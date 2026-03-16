/**
 * Shared utilities: token estimation, text extraction, formatting
 */

import { createHash } from "crypto";
import { randomUUID } from "crypto";

// ── Token estimation ──────────────────────────────────────────────

/** Fast heuristic: ~3.5 chars per token for English text. ±15% error. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

// ── UUID ──────────────────────────────────────────────────────────

export function uuid(): string {
  return randomUUID();
}

// ── Path hashing ──────────────────────────────────────────────────

/** SHA-256 of cwd, truncated to 16 hex chars. Used for DB filename. */
export function hashCwd(cwd: string): string {
  return createHash("sha256").update(cwd).digest("hex").slice(0, 16);
}

// ── Text extraction from AgentMessage ─────────────────────────────

/**
 * Extract searchable plaintext from any AgentMessage type.
 * This is the core function that determines search quality.
 */
export function extractSearchableText(message: any): string {
  if (!message || !message.role) return "";

  switch (message.role) {
    case "user": {
      if (typeof message.content === "string") return message.content;
      if (!Array.isArray(message.content)) return "";
      return message.content
        .filter((b: any) => b?.type === "text")
        .map((b: any) => b.text)
        .join("\n");
    }

    case "assistant": {
      const parts: string[] = [];
      if (!Array.isArray(message.content)) return "";
      for (const block of message.content) {
        if (block?.type === "text") parts.push(block.text);
        if (block?.type === "toolCall") {
          parts.push(`[tool: ${block.name}(${JSON.stringify(block.arguments)})]`);
        }
        // Intentionally skip thinking blocks — internal reasoning
      }
      return parts.join("\n");
    }

    case "toolResult": {
      const resultText = Array.isArray(message.content)
        ? message.content
            .filter((b: any) => b?.type === "text")
            .map((b: any) => b.text)
            .join("\n")
        : "";
      return `[${message.toolName ?? "tool"}] ${resultText}`;
    }

    case "bashExecution":
      return `$ ${message.command ?? ""}\n${message.output ?? ""}`;

    case "custom": {
      if (typeof message.content === "string") return message.content;
      if (!Array.isArray(message.content)) return "";
      return message.content
        .filter((b: any) => b?.type === "text")
        .map((b: any) => b.text)
        .join("\n");
    }

    case "compactionSummary":
      return message.summary ?? "";

    case "branchSummary":
      return message.summary ?? "";

    default:
      return "";
  }
}

// ── Snippet extraction ────────────────────────────────────────────

/**
 * Extract a snippet of `contextChars` around the first match of `query` in `text`.
 * Falls back to the first `contextChars` if no match found.
 */
export function extractSnippet(text: string, query: string, contextChars: number = 200): string {
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const idx = lowerText.indexOf(lowerQuery);

  if (idx === -1) {
    // No match — return start of text
    return text.length <= contextChars ? text : text.slice(0, contextChars) + "...";
  }

  const start = Math.max(0, idx - Math.floor(contextChars / 2));
  const end = Math.min(text.length, idx + query.length + Math.floor(contextChars / 2));

  let snippet = text.slice(start, end);
  if (start > 0) snippet = "..." + snippet;
  if (end < text.length) snippet = snippet + "...";

  return snippet;
}

// ── Time formatting ───────────────────────────────────────────────

export function timeAgo(timestampMs: number): string {
  const diff = Date.now() - timestampMs;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// ── FTS5 query sanitization ───────────────────────────────────────

/**
 * Escape FTS5 special characters by wrapping each token in double quotes.
 * Prevents FTS5 syntax injection (AND, OR, NOT, NEAR, column filters).
 */
export function sanitizeFtsQuery(query: string): string {
  // Split on whitespace, wrap each token in double quotes, rejoin
  return query
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => `"${token.replace(/"/g, '""')}"`)
    .join(" ");
}

// ── Concurrent execution ──────────────────────────────────────────

export async function mapConcurrent<T, U>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<U>,
): Promise<PromiseSettledResult<U>[]> {
  const results: PromiseSettledResult<U>[] = new Array(items.length);
  let nextIndex = 0;

  const worker = async () => {
    while (true) {
      const i = nextIndex++;
      if (i >= items.length) return;
      try {
        const value = await fn(items[i], i);
        results[i] = { status: "fulfilled", value };
      } catch (reason: any) {
        results[i] = { status: "rejected", reason };
      }
    }
  };

  const workers = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return results;
}
