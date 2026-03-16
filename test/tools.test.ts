import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { LcmStore } from "../src/db/store.js";
import { runMigrations } from "../src/db/schema.js";
import { sanitizeFtsQuery, extractSnippet, extractSearchableText } from "../src/utils.js";

let db: Database.Database;
let store: LcmStore;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  store = new LcmStore(db);
});

afterEach(() => {
  db.close();
});

describe("sanitizeFtsQuery", () => {
  it("wraps tokens in double quotes", () => {
    expect(sanitizeFtsQuery("hello world")).toBe('"hello" "world"');
  });

  it("escapes double quotes in tokens", () => {
    expect(sanitizeFtsQuery('say "hello"')).toBe('"say" """hello"""');
  });

  it("handles FTS5 operators safely", () => {
    // AND, OR, NOT should be quoted, not interpreted as operators
    expect(sanitizeFtsQuery("error AND fix")).toBe('"error" "AND" "fix"');
  });

  it("handles empty input", () => {
    expect(sanitizeFtsQuery("")).toBe("");
    expect(sanitizeFtsQuery("   ")).toBe("");
  });
});

describe("extractSnippet", () => {
  it("extracts context around match", () => {
    const text = "a".repeat(100) + "ERROR_HERE" + "b".repeat(100);
    const snippet = extractSnippet(text, "ERROR_HERE", 40);
    expect(snippet).toContain("ERROR_HERE");
    expect(snippet.length).toBeLessThan(text.length);
  });

  it("returns start of text when no match", () => {
    const text = "Hello world this is a long text";
    const snippet = extractSnippet(text, "NOTFOUND", 10);
    expect(snippet).toContain("Hello");
  });

  it("returns full text when short enough", () => {
    const text = "short";
    const snippet = extractSnippet(text, "short", 200);
    expect(snippet).toBe("short");
  });
});

describe("extractSearchableText", () => {
  it("handles user string content", () => {
    expect(extractSearchableText({ role: "user", content: "hello" })).toBe("hello");
  });

  it("handles user array content", () => {
    expect(
      extractSearchableText({
        role: "user",
        content: [
          { type: "text", text: "line 1" },
          { type: "image", data: "base64" },
          { type: "text", text: "line 2" },
        ],
      }),
    ).toBe("line 1\nline 2");
  });

  it("handles assistant with tool calls", () => {
    const text = extractSearchableText({
      role: "assistant",
      content: [
        { type: "text", text: "Let me check" },
        { type: "toolCall", name: "read", arguments: { path: "/src/foo.ts" } },
        { type: "thinking", thinking: "internal thought" },
      ],
    });
    expect(text).toContain("Let me check");
    expect(text).toContain('[tool: read({"path":"/src/foo.ts"})]');
    expect(text).not.toContain("internal thought"); // Thinking excluded
  });

  it("handles toolResult", () => {
    const text = extractSearchableText({
      role: "toolResult",
      toolName: "bash",
      content: [{ type: "text", text: "file not found" }],
    });
    expect(text).toBe("[bash] file not found");
  });

  it("handles bashExecution", () => {
    const text = extractSearchableText({
      role: "bashExecution",
      command: "git status",
      output: "On branch main",
    });
    expect(text).toBe("$ git status\nOn branch main");
  });

  it("handles null/undefined gracefully", () => {
    expect(extractSearchableText(null)).toBe("");
    expect(extractSearchableText(undefined)).toBe("");
    expect(extractSearchableText({})).toBe("");
  });
});

describe("lcm_expand token cap", () => {
  let conversationId: string;

  beforeEach(() => {
    const conv = store.getOrCreateConversation("session-1", null, "/project");
    conversationId = conv.id;
  });

  it("summary sources can be retrieved", () => {
    // Create messages
    store.appendMessage(conversationId, "e1", { role: "user", content: "msg 1", timestamp: 1 });
    store.appendMessage(conversationId, "e2", { role: "user", content: "msg 2", timestamp: 2 });
    const msgs = store.getMessages(conversationId);

    // Create summary linking to messages
    const summary = store.createSummary(conversationId, 0, "Summary", [
      { source_type: "message", source_id: msgs[0].id },
      { source_type: "message", source_id: msgs[1].id },
    ]);

    // Verify we can retrieve the source messages
    const sources = store.getSummarySources(summary.id);
    expect(sources).toHaveLength(2);

    const sourceMessages = store.getMessagesByIds(sources.map((s) => s.source_id));
    expect(sourceMessages).toHaveLength(2);
  });
});
