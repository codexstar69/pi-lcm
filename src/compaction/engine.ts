/**
 * CompactionEngine: two-phase DAG compaction (leaf + condensed).
 *
 * Fix 9: Per-conversation mutex.
 * Fix 10: Condensed pass uses unconsumed summaries, < threshold, bounded cascade.
 * Fix 11: No mark-compacted on summarization failure.
 */

import type { LcmStore, StoredMessage, SourceRef } from "../db/store.js";
import type { LcmConfig } from "../config.js";
import { mapConcurrent } from "../utils.js";
import {
  buildLeafPrompt,
  buildCondensedD1Prompt,
  buildCondensedD2PlusPrompt,
  serializeMessagesForPrompt,
} from "./prompts.js";
import { assembleSummary } from "./assembler.js";

const MAX_CONDENSE_PASSES = 10;

export interface CompactionDeps {
  summarize: (systemPrompt: string, signal?: AbortSignal) => Promise<string>;
  notify: (message: string, type?: string) => void;
}

export class CompactionEngine {
  private store: LcmStore;
  private config: LcmConfig;
  // Fix 9: Per-conversation mutex
  private locks = new Map<string, Promise<string | null>>();

  constructor(store: LcmStore, config: LcmConfig) {
    this.store = store;
    this.config = config;
  }

  /** Fix 9: Serialize compaction calls per conversation. */
  async compact(
    conversationId: string,
    deps: CompactionDeps,
    signal?: AbortSignal,
  ): Promise<string | null> {
    const prev = this.locks.get(conversationId) ?? Promise.resolve(null);
    const current = prev.then(() => this.doCompact(conversationId, deps, signal));
    this.locks.set(conversationId, current);
    try {
      return await current;
    } finally {
      if (this.locks.get(conversationId) === current) {
        this.locks.delete(conversationId);
      }
    }
  }

  private async doCompact(
    conversationId: string,
    deps: CompactionDeps,
    signal?: AbortSignal,
  ): Promise<string | null> {
    const uncompacted = this.store.getUncompactedMessages(conversationId);

    if (uncompacted.length < this.config.minMessagesForCompaction) {
      deps.notify(`LCM: Only ${uncompacted.length} uncompacted messages, skipping DAG compaction`, "info");
      return null;
    }

    deps.notify(`LCM: Compacting ${uncompacted.length} messages into leaf summaries...`, "info");
    await this.leafPass(conversationId, uncompacted, deps, signal);

    if (signal?.aborted) return null;

    await this.condensedPass(conversationId, deps, signal);

    if (signal?.aborted) return null;

    return assembleSummary(this.store, conversationId, this.config.maxSummaryTokens);
  }

  // ── Leaf Pass ─────────────────────────────────────────────────

  private async leafPass(
    conversationId: string,
    messages: StoredMessage[],
    deps: CompactionDeps,
    signal?: AbortSignal,
  ): Promise<void> {
    const chunks = this.chunkMessages(messages, this.config.leafChunkTokens);

    deps.notify(`LCM: Processing ${chunks.length} chunks (concurrency ${this.config.leafPassConcurrency})...`, "info");

    const results = await mapConcurrent(
      chunks,
      this.config.leafPassConcurrency,
      async (chunk, idx) => {
        if (signal?.aborted) throw new Error("Aborted");

        const serialized = serializeMessagesForPrompt(chunk);
        const prompt = buildLeafPrompt(serialized);

        try {
          const summaryText = await deps.summarize(prompt, signal);
          return { chunk, summaryText, failed: false };
        } catch {
          // Fix 11: Mark as failed — do NOT persist or mark compacted
          return { chunk, summaryText: "", failed: true };
        }
      },
    );

    for (const result of results) {
      if (result.status === "rejected") continue;
      const { chunk, summaryText, failed } = result.value;

      // Fix 11: Skip failed chunks — messages stay uncompacted for retry next cycle
      if (failed) {
        deps.notify(
          `LCM: Summarization failed for messages ${chunk[0].seq}-${chunk[chunk.length - 1].seq}, will retry next cycle`,
          "warning",
        );
        continue;
      }

      const sources: SourceRef[] = chunk.map((m) => ({
        source_type: "message" as const,
        source_id: m.id,
      }));

      this.store.createSummary(conversationId, 0, summaryText, sources, {
        messageRange: { from: chunk[0].seq, to: chunk[chunk.length - 1].seq },
      });

      this.store.markCompacted(chunk.map((m) => m.id));
    }
  }

  // ── Condensed Pass ────────────────────────────────────────────

  /**
   * Fix 10a: Use getUnconsumedSummariesByDepth (NOT EXISTS filter).
   * Fix 10b: Threshold uses < not <= (condense AT threshold, not above).
   * Fix 10c: Bounded cascade loop (MAX_CONDENSE_PASSES = 10).
   */
  private async condensedPass(
    conversationId: string,
    deps: CompactionDeps,
    signal?: AbortSignal,
  ): Promise<void> {
    let didCondense = true;
    let passes = 0;

    while (didCondense && passes < MAX_CONDENSE_PASSES) {
      didCondense = false;
      passes++;

      for (let depth = 0; depth < this.config.maxDepth; depth++) {
        if (signal?.aborted) return;

        // Fix 10a: Only count/select unconsumed summaries
        const unconsumed = this.store.getUnconsumedSummariesByDepth(conversationId, depth);
        // Fix 10b: < threshold (condense at threshold count, not above)
        if (unconsumed.length < this.config.condensationThreshold) continue;

        const toCondense = unconsumed.slice(0, this.config.condensationThreshold);

        deps.notify(
          `LCM: Condensing ${toCondense.length} D${depth} summaries into D${depth + 1}...`,
          "info",
        );

        const combinedText = toCondense.map((s) => s.text).join("\n\n---\n\n");

        const prompt =
          depth + 1 === 1
            ? buildCondensedD1Prompt(combinedText)
            : buildCondensedD2PlusPrompt(depth + 1, combinedText);

        let summaryText: string;
        try {
          summaryText = await deps.summarize(prompt, signal);
        } catch {
          deps.notify(`LCM: Condensation at D${depth + 1} failed, will retry next cycle`, "warning");
          return; // Stop cascading on failure
        }

        const sources: SourceRef[] = toCondense.map((s) => ({
          source_type: "summary" as const,
          source_id: s.id,
        }));

        this.store.createSummary(conversationId, depth + 1, summaryText, sources, {
          sourceSummaryIds: toCondense.map((s) => s.id),
        });

        didCondense = true;
      }
    }

    if (passes >= MAX_CONDENSE_PASSES) {
      deps.notify("LCM: Condensation hit pass limit, will continue next cycle", "warning");
    }
  }

  private chunkMessages(messages: StoredMessage[], tokenBudget: number): StoredMessage[][] {
    const chunks: StoredMessage[][] = [];
    let current: StoredMessage[] = [];
    let tokens = 0;

    for (const msg of messages) {
      const msgTokens = msg.token_estimate; // Already min 1 from store
      if (tokens + msgTokens > tokenBudget && current.length > 0) {
        chunks.push(current);
        current = [];
        tokens = 0;
      }
      current.push(msg);
      tokens += msgTokens;
    }

    if (current.length > 0) chunks.push(current);
    return chunks;
  }
}
