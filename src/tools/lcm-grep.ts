/**
 * lcm_grep: Search all conversation history (including compacted messages).
 */

import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import type { LcmStore, SearchResult } from "../db/store.js";
import { extractSnippet, timeAgo } from "../utils.js";

export function createLcmGrepTool(
  getStore: () => LcmStore | null,
  getConversationId: () => string | null,
  getGuidelines: () => string[],
) {
  return {
    name: "lcm_grep",
    label: "LCM Search",
    description:
      "Search through all past conversation messages, including those that have been compacted. " +
      "Returns snippets with context around matches. Use this to find specific error messages, " +
      "code snippets, decisions, or any detail from earlier in the conversation.",
    promptSnippet: "Search all conversation history (including compacted)",
    // Use getter so Pi evaluates this lazily each turn, picking up updated stats
    get promptGuidelines() { return getGuidelines(); },
    parameters: Type.Object({
      query: Type.String({ description: "Search query (regex pattern or text)" }),
      mode: StringEnum(["regex", "text"] as const, {
        description: "Search mode: 'text' for FTS5 search, 'regex' for pattern matching",
      }),
      scope: StringEnum(["messages", "summaries", "all"] as const, {
        description: "Where to search",
      }),
      limit: Type.Optional(Type.Number({ description: "Max results (default 20)" })),
      after: Type.Optional(Type.String({ description: "Only messages after this ISO timestamp" })),
      before: Type.Optional(Type.String({ description: "Only messages before this ISO timestamp" })),
      full: Type.Optional(
        Type.Boolean({ description: "Return full message content instead of snippets (default false)" }),
      ),
    }),
    async execute(
      toolCallId: string,
      params: {
        query: string;
        mode: "regex" | "text";
        scope: "messages" | "summaries" | "all";
        limit?: number;
        after?: string;
        before?: string;
        full?: boolean;
      },
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

      const limit = Math.min(params.limit ?? 20, 100);
      let results: SearchResult[] = [];

      // Search messages
      if (params.scope === "messages" || params.scope === "all") {
        if (params.mode === "regex") {
          // Fix 21: Invalid regex now throws — catch and return error
          try {
            results = store.searchMessagesRegex(conversationId, params.query, {
              limit,
              timeout: 5000,
            });
          } catch (e: any) {
            return {
              content: [{ type: "text", text: e.message }],
              isError: true,
              details: {},
            };
          }
        } else {
          results = store.searchMessages(conversationId, params.query, {
            limit,
            after: params.after,
            before: params.before,
          });
        }
      }

      // Search summaries too
      if (params.scope === "summaries" || params.scope === "all") {
        const summaryResults = store.searchSummaries(conversationId, params.query, limit);
        // Convert summaries to search result format for unified display
        for (const s of summaryResults) {
          results.push({
            id: s.id,
            role: `summary(D${s.depth})`,
            content_text: s.text,
            timestamp: new Date(s.created_at).getTime(),
            seq: -1,
            summary_id: s.id,
            summary_depth: s.depth,
          });
        }
      }

      if (results.length === 0) {
        return {
          content: [{ type: "text", text: `No results found for "${params.query}".` }],
          details: { resultCount: 0 },
        };
      }

      // Format results
      const lines: string[] = [`Found ${results.length} results for "${params.query}":\n`];

      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        const time = timeAgo(r.timestamp);
        const summaryRef = r.summary_id ? ` [summary: ${r.summary_id}, D${r.summary_depth}]` : "";

        if (params.full) {
          lines.push(`[${i + 1}] ${r.id} (${r.role}, ${time}, seq ${r.seq})${summaryRef}`);
          lines.push(r.content_text);
          lines.push("");
        } else {
          const snippet = extractSnippet(r.content_text, params.query, 200);
          lines.push(`[${i + 1}] ${r.id} (${r.role}, ${time}, seq ${r.seq})${summaryRef}`);
          lines.push(`  ${snippet}`);
          lines.push("");
        }
      }

      if (!params.full && results.some((r) => r.summary_id)) {
        lines.push(
          `Tip: Use lcm_expand("<summary_id>") to see full context around these messages.`,
        );
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { resultCount: results.length },
      };
    },
  };
}
