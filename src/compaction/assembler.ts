/**
 * Assemble a compaction summary from the DAG for Pi's compaction entry.
 * The output is a STATIC structure (content only changes on compaction, not per-turn).
 */

import type { LcmStore, Summary, LcmStats } from "../db/store.js";
import { estimateTokens } from "../utils.js";

export function assembleSummary(
  store: LcmStore,
  conversationId: string,
  maxTokens: number,
): string {
  const stats = store.getStats(conversationId);
  const latestPerDepth = store.getLatestSummaryPerDepth(conversationId);

  if (latestPerDepth.length === 0) {
    return `## Conversation History (Lossless Context Management)\n${stats.messages} messages stored | 0 summaries\n\nNo summaries generated yet.`;
  }

  const parts: string[] = [];

  // Header with stats
  parts.push(`## Conversation History (Lossless Context Management)`);
  parts.push(
    `${stats.messages} messages stored | ${stats.summaries} summaries | DAG depth ${stats.maxDepth}`,
  );
  parts.push("");

  // Fill from deepest summaries first (broadest coverage)
  let tokensUsed = estimateTokens(parts.join("\n"));

  // High-level summaries (deepest first)
  const deepSummaries = latestPerDepth.filter((s) => s.depth >= 1);
  if (deepSummaries.length > 0) {
    parts.push("### High-Level Summary");
    for (const s of deepSummaries) {
      const needed = estimateTokens(s.text) + 20; // +20 for formatting
      if (tokensUsed + needed > maxTokens) break;
      parts.push(s.text);
      parts.push("");
      tokensUsed += needed;
    }
  }

  // Most recent D0 summary (detailed recent work)
  const recentD0 = latestPerDepth.find((s) => s.depth === 0);
  if (recentD0) {
    const needed = estimateTokens(recentD0.text) + 30;
    if (tokensUsed + needed <= maxTokens) {
      parts.push("### Recent Activity");
      parts.push(recentD0.text);
      parts.push("");
      tokensUsed += needed;
    }
  }

  // Summary IDs for drill-down
  const allSummaries = store.getAllSummaries(conversationId);
  if (allSummaries.length > 0) {
    parts.push("### Summary IDs for Drill-Down");
    const idBudget = maxTokens - tokensUsed - 50;
    let idTokens = 0;
    for (const s of allSummaries) {
      const preview = s.text.slice(0, 60).replace(/\n/g, " ");
      const line = `- ${s.id} (D${s.depth}): "${preview}..."`;
      const lineTokens = estimateTokens(line);
      if (idTokens + lineTokens > idBudget) break;
      parts.push(line);
      idTokens += lineTokens;
    }
  }

  return parts.join("\n");
}
