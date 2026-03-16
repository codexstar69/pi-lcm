/**
 * lcm_expand: Drill into compressed summary nodes to recover original detail.
 *
 * Fix 18: Cycle guard via visited Set.
 * Fix 19: Raised truncation from 1500 to 8000 chars.
 * Fix 20: Use loop index instead of indexOf.
 */

import { Type } from "@sinclair/typebox";
import type { LcmStore, StoredMessage, Summary } from "../db/store.js";
import { estimateTokens, timeAgo } from "../utils.js";

const HARD_TOKEN_CEILING = 8000;
const MESSAGE_CHAR_LIMIT = 8000; // Fix 19: Raised from 1500

export function createLcmExpandTool(
  getStore: () => LcmStore | null,
  getConversationId: () => string | null,
) {
  return {
    name: "lcm_expand",
    label: "LCM Expand",
    description:
      "Expand a compressed summary node to see the original messages or lower-level summaries " +
      "it was created from. Use this when you need exact details that were compressed away — " +
      "specific error messages, code snippets, or the precise sequence of events.",
    promptSnippet: "Drill into compressed summaries to recover original details",
    parameters: Type.Object({
      summary_id: Type.String({ description: "The summary ID to expand" }),
      depth: Type.Optional(
        Type.Number({ description: "How many levels deep to expand (default 1, max 3)" }),
      ),
      max_tokens: Type.Optional(
        Type.Number({ description: "Token budget for expansion (default 4000, max 8000)" }),
      ),
    }),
    async execute(
      toolCallId: string,
      params: { summary_id: string; depth?: number; max_tokens?: number },
      signal: AbortSignal,
      onUpdate: any,
      ctx: any,
    ) {
      const store = getStore();
      const conversationId = getConversationId();

      if (!store || !conversationId) {
        return { content: [{ type: "text", text: "LCM not initialized for this session." }], isError: true, details: {} };
      }

      const summary = store.getSummary(params.summary_id);
      if (!summary) {
        return { content: [{ type: "text", text: `Summary "${params.summary_id}" not found.` }], isError: true, details: {} };
      }

      const maxDepth = Math.min(params.depth ?? 1, 3);
      const maxTokens = Math.min(params.max_tokens ?? 4000, HARD_TOKEN_CEILING);

      // Fix 18: Cycle guard
      const visited = new Set<string>();
      const result = expandNode(store, summary, maxDepth, maxTokens, 0, visited);

      return {
        content: [{ type: "text", text: result.text }],
        details: { nodesExpanded: result.nodesExpanded, tokensUsed: result.tokensUsed },
      };
    },
  };
}

interface ExpandResult {
  text: string;
  tokensUsed: number;
  nodesExpanded: number;
}

function expandNode(
  store: LcmStore,
  summary: Summary,
  maxDepth: number,
  tokenBudget: number,
  currentDepth: number,
  visited: Set<string>,
): ExpandResult {
  // Fix 18: Cycle detection
  if (visited.has(summary.id)) {
    return { text: `(circular reference: ${summary.id})`, tokensUsed: 0, nodesExpanded: 0 };
  }
  visited.add(summary.id);

  const sources = store.getSummarySources(summary.id);
  const lines: string[] = [];
  let tokensUsed = 0;
  let nodesExpanded = 1;

  lines.push(`## Expansion of ${summary.id} (D${summary.depth})`);
  lines.push(`Sources: ${sources.length} | Budget: ${tokenBudget} tokens\n`);

  const headerTokens = estimateTokens(lines.join("\n"));
  tokensUsed += headerTokens;

  const messageSources = sources.filter((s) => s.source_type === "message");
  const summarySources = sources.filter((s) => s.source_type === "summary");

  // Expand message sources
  if (messageSources.length > 0) {
    const messageIds = messageSources.map((s) => s.source_id);
    const messages = store.getMessagesByIds(messageIds);

    // Fix 20: Use index-based loop instead of indexOf
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const msgText = formatMessage(msg);
      const msgTokens = estimateTokens(msgText);

      if (tokensUsed + msgTokens > tokenBudget) {
        lines.push(`\n... (${messages.length - i} more messages, budget exhausted)`);
        break;
      }

      lines.push(msgText);
      tokensUsed += msgTokens;
    }
  }

  // Expand summary sources
  if (summarySources.length > 0 && currentDepth < maxDepth) {
    for (const sourceRef of summarySources) {
      if (tokensUsed >= tokenBudget) {
        lines.push(`\n... (more summaries available, budget exhausted)`);
        break;
      }

      const childSummary = store.getSummary(sourceRef.source_id);
      if (!childSummary) continue;

      const remainingBudget = tokenBudget - tokensUsed;
      const childResult = expandNode(store, childSummary, maxDepth, remainingBudget, currentDepth + 1, visited);

      lines.push(childResult.text);
      tokensUsed += childResult.tokensUsed;
      nodesExpanded += childResult.nodesExpanded;
    }
  } else if (summarySources.length > 0) {
    for (const sourceRef of summarySources) {
      const childSummary = store.getSummary(sourceRef.source_id);
      if (!childSummary) continue;

      const text = `### Summary ${childSummary.id} (D${childSummary.depth})\n${childSummary.text}\n`;
      const textTokens = estimateTokens(text);

      if (tokensUsed + textTokens > tokenBudget) {
        lines.push(`\n... (more summaries available, budget exhausted)`);
        break;
      }

      lines.push(text);
      tokensUsed += textTokens;
    }
  }

  return { text: lines.join("\n"), tokensUsed, nodesExpanded };
}

function formatMessage(msg: StoredMessage): string {
  const time = timeAgo(msg.timestamp);
  const role = msg.tool_name ? `${msg.role}/${msg.tool_name}` : msg.role;
  // Fix 19: Raised from 1500 to 8000 — expand is for recovering full detail
  const content =
    msg.content_text.length > MESSAGE_CHAR_LIMIT
      ? msg.content_text.slice(0, MESSAGE_CHAR_LIMIT) + `\n... (${msg.content_text.length - MESSAGE_CHAR_LIMIT} chars truncated)`
      : msg.content_text;
  return `**[${role}]** (seq ${msg.seq}, ${time})\n${content}\n`;
}
