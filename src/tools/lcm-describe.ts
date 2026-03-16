/**
 * lcm_describe: Get high-level summaries of conversation sections.
 */

import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import type { LcmStore } from "../db/store.js";
import { timeAgo } from "../utils.js";

export function createLcmDescribeTool(
  getStore: () => LcmStore | null,
  getConversationId: () => string | null,
) {
  return {
    name: "lcm_describe",
    label: "LCM Describe",
    description:
      "Get a high-level summary of conversation history sections. Shows the DAG structure " +
      "of summaries and their lineage. Use this to understand what happened in a particular " +
      "time range or topic area.",
    promptSnippet: "Get summaries of conversation sections with DAG lineage",
    parameters: Type.Object({
      section: StringEnum(["overview", "recent", "earliest", "by_id"] as const, {
        description: "Which section to describe",
      }),
      summary_id: Type.Optional(
        Type.String({ description: "Specific summary ID (required for by_id mode)" }),
      ),
    }),
    async execute(
      toolCallId: string,
      params: { section: "overview" | "recent" | "earliest" | "by_id"; summary_id?: string },
      signal: AbortSignal,
      onUpdate: any,
      ctx: any,
    ) {
      const store = getStore();
      const conversationId = getConversationId();

      if (!store || !conversationId) {
        return {
          content: [{ type: "text", text: "LCM not initialized for this session." }],
          isError: true,
          details: {},
        };
      }

      const stats = store.getStats(conversationId);

      switch (params.section) {
        case "overview": {
          const latestPerDepth = store.getLatestSummaryPerDepth(conversationId);
          const lines: string[] = [
            `## LCM Overview`,
            `- Messages: ${stats.messages}`,
            `- Summaries: ${stats.summaries}`,
            `- DAG depth: ${stats.maxDepth}`,
            `- DB size: ${(stats.dbSizeBytes / 1024 / 1024).toFixed(1)} MB`,
            "",
            "### Summary DAG (newest at each depth):",
          ];

          for (const s of latestPerDepth) {
            const preview = s.text.slice(0, 100).replace(/\n/g, " ");
            const sources = store.getSummarySources(s.id);
            lines.push(
              `- **D${s.depth}** ${s.id} (${sources.length} sources, ${timeAgo(new Date(s.created_at).getTime())})`
            );
            lines.push(`  "${preview}..."`);
          }

          if (latestPerDepth.length === 0) {
            lines.push("  (no summaries yet — conversation has not been compacted)");
          }

          return { content: [{ type: "text", text: lines.join("\n") }], details: {} };
        }

        case "recent": {
          const d0Summaries = store.getSummariesByDepth(conversationId, 0);
          const recent = d0Summaries.slice(-3); // Last 3 leaf summaries
          const lines: string[] = ["## Recent Activity (last 3 leaf summaries)\n"];

          for (const s of recent.reverse()) {
            lines.push(`### ${s.id} (D0, ${timeAgo(new Date(s.created_at).getTime())})`);
            lines.push(s.text);
            lines.push("");
          }

          if (recent.length === 0) {
            lines.push("No leaf summaries yet.");
          }

          return { content: [{ type: "text", text: lines.join("\n") }], details: {} };
        }

        case "earliest": {
          const d0Summaries = store.getSummariesByDepth(conversationId, 0);
          const earliest = d0Summaries.slice(0, 3); // First 3 leaf summaries
          const lines: string[] = ["## Earliest Activity (first 3 leaf summaries)\n"];

          for (const s of earliest) {
            lines.push(`### ${s.id} (D0, ${timeAgo(new Date(s.created_at).getTime())})`);
            lines.push(s.text);
            lines.push("");
          }

          if (earliest.length === 0) {
            lines.push("No leaf summaries yet.");
          }

          return { content: [{ type: "text", text: lines.join("\n") }], details: {} };
        }

        case "by_id": {
          if (!params.summary_id) {
            return {
              content: [{ type: "text", text: "summary_id is required for by_id mode." }],
              isError: true,
              details: {},
            };
          }

          const summary = store.getSummary(params.summary_id);
          if (!summary) {
            return {
              content: [{ type: "text", text: `Summary "${params.summary_id}" not found.` }],
              isError: true,
              details: {},
            };
          }

          const sources = store.getSummarySources(summary.id);
          const lineage = store.getSummaryLineage(summary.id);

          const lines: string[] = [
            `## Summary: ${summary.id}`,
            `- Depth: ${summary.depth}`,
            `- Created: ${summary.created_at} (${timeAgo(new Date(summary.created_at).getTime())})`,
            `- Token estimate: ${summary.token_estimate}`,
            `- Sources: ${sources.length} (${sources.filter((s) => s.source_type === "message").length} messages, ${sources.filter((s) => s.source_type === "summary").length} summaries)`,
            "",
            "### Content",
            summary.text,
            "",
          ];

          if (lineage.length > 0) {
            lines.push("### Lineage (this summary is covered by):");
            for (const ancestor of lineage) {
              lines.push(`- D${ancestor.depth} ${ancestor.id}: "${ancestor.text.slice(0, 80).replace(/\n/g, " ")}..."`);
            }
          }

          lines.push("");
          lines.push(`Use lcm_expand("${summary.id}") to see the original source content.`);

          return { content: [{ type: "text", text: lines.join("\n") }], details: {} };
        }

        default:
          return {
            content: [{ type: "text", text: `Unknown section "${params.section}". Use: overview, recent, earliest, or by_id.` }],
            isError: true,
            details: {},
          };
      }
    },
  };
}
