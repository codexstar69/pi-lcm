import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { LcmStore } from "../src/db/store.js";
import { runMigrations } from "../src/db/schema.js";
import { CompactionEngine, type CompactionDeps } from "../src/compaction/engine.js";
import { resolveConfig, type LcmConfig } from "../src/config.js";
import { assembleSummary } from "../src/compaction/assembler.js";

let db: Database.Database;
let store: LcmStore;
let config: LcmConfig;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  store = new LcmStore(db);
  config = {
    ...resolveConfig(),
    leafChunkTokens: 200, // Small chunks for testing
    condensationThreshold: 3, // Low threshold for testing
    maxDepth: 3,
    minMessagesForCompaction: 3,
    leafPassConcurrency: 2,
    maxSummaryTokens: 4000,
  };
});

afterEach(() => {
  db.close();
});

function makeDeps(summaryFn?: (prompt: string) => string): CompactionDeps {
  return {
    summarize: async (prompt: string) => {
      return summaryFn ? summaryFn(prompt) : `Summary of: ${prompt.slice(0, 50)}`;
    },
    notify: () => {},
  };
}

function seedMessages(conversationId: string, count: number): void {
  for (let i = 0; i < count; i++) {
    store.appendMessage(conversationId, `e${i}`, {
      role: i % 2 === 0 ? "user" : "assistant",
      content: i % 2 === 0 ? `User message ${i} with some content to fill tokens` : [{ type: "text", text: `Assistant response ${i} with details` }],
      timestamp: Date.now() + i * 1000,
    });
  }
}

describe("CompactionEngine", () => {
  let conversationId: string;

  beforeEach(() => {
    const conv = store.getOrCreateConversation("session-1", null, "/project");
    conversationId = conv.id;
  });

  it("skips compaction when too few messages", async () => {
    seedMessages(conversationId, 2);
    const engine = new CompactionEngine(store, config);

    const result = await engine.compact(conversationId, makeDeps());
    expect(result).toBeNull();
  });

  it("creates leaf summaries from uncompacted messages", async () => {
    seedMessages(conversationId, 10);
    const engine = new CompactionEngine(store, config);

    const result = await engine.compact(conversationId, makeDeps());
    expect(result).not.toBeNull();

    // Should have created D0 summaries
    const d0 = store.getSummariesByDepth(conversationId, 0);
    expect(d0.length).toBeGreaterThan(0);

    // All messages should be marked as compacted
    const uncompacted = store.getUncompactedMessages(conversationId);
    expect(uncompacted).toHaveLength(0);
  });

  it("creates condensed summaries when threshold exceeded", async () => {
    // Seed enough messages to create > condensationThreshold (3) D0 summaries
    seedMessages(conversationId, 30);
    const engine = new CompactionEngine(store, config);

    await engine.compact(conversationId, makeDeps());

    const d0 = store.getSummariesByDepth(conversationId, 0);
    const d1 = store.getSummariesByDepth(conversationId, 1);

    // Should have condensed some D0s into D1
    if (d0.length > config.condensationThreshold) {
      // If still over threshold, condensation may not have caught all
      expect(d1.length).toBeGreaterThan(0);
    }
  });

  it("links summaries to source messages via summary_sources", async () => {
    seedMessages(conversationId, 10);
    const engine = new CompactionEngine(store, config);

    await engine.compact(conversationId, makeDeps());

    const d0 = store.getSummariesByDepth(conversationId, 0);
    expect(d0.length).toBeGreaterThan(0);

    // Each D0 should have message sources
    for (const s of d0) {
      const sources = store.getSummarySources(s.id);
      expect(sources.length).toBeGreaterThan(0);
      expect(sources.every((src) => src.source_type === "message")).toBe(true);
    }
  });

  it("handles summarization failure gracefully — no mark-compacted on failure", async () => {
    seedMessages(conversationId, 10);
    const engine = new CompactionEngine(store, config);

    const failDeps: CompactionDeps = {
      summarize: async () => {
        throw new Error("Model unavailable");
      },
      notify: () => {},
    };

    const result = await engine.compact(conversationId, failDeps);
    // Fix 11: On total failure, no summaries created, messages stay uncompacted
    // The engine returns an assembled summary from whatever exists (empty DAG = fallback text)
    // But no D0 summaries should exist since all chunks failed
    const d0 = store.getSummariesByDepth(conversationId, 0);
    expect(d0.length).toBe(0);

    // Messages should remain uncompacted (available for retry next cycle)
    const uncompacted = store.getUncompactedMessages(conversationId);
    expect(uncompacted.length).toBe(10);
  });
});

describe("assembleSummary", () => {
  let conversationId: string;

  beforeEach(() => {
    const conv = store.getOrCreateConversation("session-1", null, "/project");
    conversationId = conv.id;
  });

  it("assembles from empty state", () => {
    const result = assembleSummary(store, conversationId, 4000);
    expect(result).toContain("Lossless Context Management");
    expect(result).toContain("0 summaries");
  });

  it("assembles from populated DAG", () => {
    // Create D0 summaries
    store.createSummary(conversationId, 0, "Fixed the auth bug in login.ts", []);
    store.createSummary(conversationId, 0, "Refactored the database layer", []);

    // Create D1 summary
    const s1 = store.getSummariesByDepth(conversationId, 0);
    store.createSummary(conversationId, 1, "Worked on auth and database improvements", [
      { source_type: "summary", source_id: s1[0].id },
      { source_type: "summary", source_id: s1[1].id },
    ]);

    const result = assembleSummary(store, conversationId, 4000);
    expect(result).toContain("High-Level Summary");
    expect(result).toContain("auth and database improvements");
    expect(result).toContain("Summary IDs for Drill-Down");
  });

  it("respects token budget", () => {
    // Create a large summary
    const bigText = "x ".repeat(5000);
    store.createSummary(conversationId, 0, bigText, []);

    const result = assembleSummary(store, conversationId, 100);
    // Should be truncated to fit budget
    expect(result.length).toBeLessThan(bigText.length);
  });
});
