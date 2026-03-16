import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { LcmStore } from "../src/db/store.js";
import { runMigrations } from "../src/db/schema.js";

let db: Database.Database;
let store: LcmStore;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  store = new LcmStore(db);
});

afterEach(() => {
  db.close();
});

describe("LcmStore", () => {
  describe("conversations", () => {
    it("creates and retrieves a conversation", () => {
      const conv = store.getOrCreateConversation("session-1", "/path/session.jsonl", "/project");
      expect(conv.session_id).toBe("session-1");
      expect(conv.cwd).toBe("/project");

      const retrieved = store.getConversation(conv.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.session_id).toBe("session-1");
    });

    it("returns existing conversation for same session_id (transaction-safe)", () => {
      const conv1 = store.getOrCreateConversation("session-1", null, "/project");
      const conv2 = store.getOrCreateConversation("session-1", null, "/project");
      expect(conv1.id).toBe(conv2.id);
    });

    it("does not clobber session_file with null", () => {
      store.getOrCreateConversation("session-1", "/path/file.jsonl", "/project");
      const conv2 = store.getOrCreateConversation("session-1", null, "/project");
      expect(conv2.session_file).toBe("/path/file.jsonl");
    });
  });

  describe("messages", () => {
    let conversationId: string;

    beforeEach(() => {
      const conv = store.getOrCreateConversation("session-1", null, "/project");
      conversationId = conv.id;
    });

    it("appends and retrieves messages with atomic seq", () => {
      store.appendMessage(conversationId, null, {
        role: "user", content: "Hello world", timestamp: Date.now(),
      });
      store.appendMessage(conversationId, null, {
        role: "assistant", content: [{ type: "text", text: "Hi there!" }], timestamp: Date.now() + 1,
      });

      const messages = store.getMessages(conversationId);
      expect(messages).toHaveLength(2);
      expect(messages[0].role).toBe("user");
      expect(messages[0].seq).toBe(0);
      expect(messages[1].seq).toBe(1);
    });

    it("deduplicates via dedup_hash (same role + timestamp + content prefix)", () => {
      const ts = Date.now();
      store.appendMessage(conversationId, null, { role: "user", content: "Hello", timestamp: ts });
      const result = store.appendMessage(conversationId, null, { role: "user", content: "Hello", timestamp: ts });

      expect(result).toBeNull(); // Duplicate
      expect(store.getMessages(conversationId)).toHaveLength(1);
    });

    it("does NOT dedup messages with different timestamps", () => {
      store.appendMessage(conversationId, null, { role: "user", content: "Hello", timestamp: 1000 });
      store.appendMessage(conversationId, null, { role: "user", content: "Hello", timestamp: 2000 });

      expect(store.getMessages(conversationId)).toHaveLength(2);
    });

    it("extracts searchable text from toolResult", () => {
      store.appendMessage(conversationId, null, {
        role: "toolResult", toolCallId: "call-1", toolName: "bash",
        content: [{ type: "text", text: "error: file not found" }], isError: true, timestamp: Date.now(),
      });

      const messages = store.getMessages(conversationId);
      expect(messages[0].content_text).toContain("[bash]");
      expect(messages[0].content_text).toContain("error: file not found");
    });

    it("has minimum 1 token estimate", () => {
      store.appendMessage(conversationId, null, {
        role: "user", content: "", timestamp: Date.now(),
      });
      const messages = store.getMessages(conversationId);
      expect(messages[0].token_estimate).toBeGreaterThanOrEqual(1);
    });

    it("marks messages as compacted", () => {
      store.appendMessage(conversationId, null, { role: "user", content: "a", timestamp: 1 });
      store.appendMessage(conversationId, null, { role: "user", content: "b", timestamp: 2 });

      const msgs = store.getMessages(conversationId);
      store.markCompacted([msgs[0].id]);

      const uncompacted = store.getUncompactedMessages(conversationId);
      expect(uncompacted).toHaveLength(1);
      expect(uncompacted[0].content_text).toBe("b");
    });

    it("chunks getMessagesByIds for large batches", () => {
      // Just verify it doesn't crash with a moderate batch
      for (let i = 0; i < 50; i++) {
        store.appendMessage(conversationId, null, { role: "user", content: `msg ${i}`, timestamp: i });
      }
      const msgs = store.getMessages(conversationId);
      const ids = msgs.map((m) => m.id);
      const fetched = store.getMessagesByIds(ids);
      expect(fetched).toHaveLength(50);
    });
  });

  describe("search", () => {
    let conversationId: string;

    beforeEach(() => {
      const conv = store.getOrCreateConversation("session-1", null, "/project");
      conversationId = conv.id;

      store.appendMessage(conversationId, null, { role: "user", content: "fix the TypeError in processFile", timestamp: 1000 });
      store.appendMessage(conversationId, null, { role: "assistant", content: [{ type: "text", text: "I found the TypeError at line 42" }], timestamp: 2000 });
      store.appendMessage(conversationId, null, { role: "user", content: "now optimize the database queries", timestamp: 3000 });
    });

    it("returns empty for empty query", () => {
      expect(store.searchMessages(conversationId, "")).toHaveLength(0);
      expect(store.searchMessages(conversationId, "   ")).toHaveLength(0);
    });

    it("searches messages via FTS5", () => {
      const results = store.searchMessages(conversationId, "TypeError");
      expect(results.length).toBeGreaterThanOrEqual(1);
    });

    it("searches messages via regex", () => {
      const results = store.searchMessagesRegex(conversationId, "line \\d+");
      expect(results.length).toBeGreaterThanOrEqual(1);
    });

    it("throws on invalid regex", () => {
      expect(() => store.searchMessagesRegex(conversationId, "[invalid")).toThrow("Invalid regex");
    });

    it("regex search respects timeout", () => {
      const results = store.searchMessagesRegex(conversationId, "(a+)+b", { timeout: 100 });
      expect(Array.isArray(results)).toBe(true);
    });

    it("caps text length for regex to mitigate ReDoS", () => {
      // Insert a message with very long content
      store.appendMessage(conversationId, null, {
        role: "user", content: "a".repeat(100000), timestamp: 9000,
      });
      // Should complete without hanging (50K char cap)
      const results = store.searchMessagesRegex(conversationId, "a+", { timeout: 1000 });
      expect(Array.isArray(results)).toBe(true);
    });
  });

  describe("summaries", () => {
    let conversationId: string;

    beforeEach(() => {
      const conv = store.getOrCreateConversation("session-1", null, "/project");
      conversationId = conv.id;
    });

    it("creates summaries with source links", () => {
      store.appendMessage(conversationId, null, { role: "user", content: "msg1", timestamp: 1 });
      store.appendMessage(conversationId, null, { role: "user", content: "msg2", timestamp: 2 });
      const msgs = store.getMessages(conversationId);

      const summary = store.createSummary(conversationId, 0, "Summary of msgs 1-2", [
        { source_type: "message", source_id: msgs[0].id },
        { source_type: "message", source_id: msgs[1].id },
      ]);

      expect(summary.depth).toBe(0);
      const sources = store.getSummarySources(summary.id);
      expect(sources).toHaveLength(2);
    });

    it("getUnconsumedSummariesByDepth filters consumed summaries", () => {
      const s1 = store.createSummary(conversationId, 0, "Leaf 1", []);
      const s2 = store.createSummary(conversationId, 0, "Leaf 2", []);
      const s3 = store.createSummary(conversationId, 0, "Leaf 3", []);

      // Consume s1 and s2 into a D1 summary
      store.createSummary(conversationId, 1, "Condensed", [
        { source_type: "summary", source_id: s1.id },
        { source_type: "summary", source_id: s2.id },
      ]);

      // Only s3 should be unconsumed
      const unconsumed = store.getUnconsumedSummariesByDepth(conversationId, 0);
      expect(unconsumed).toHaveLength(1);
      expect(unconsumed[0].id).toBe(s3.id);
    });

    it("gets stats correctly", () => {
      store.appendMessage(conversationId, null, { role: "user", content: "a", timestamp: 1 });
      store.createSummary(conversationId, 0, "S1", []);
      store.createSummary(conversationId, 1, "S2", []);

      const stats = store.getStats(conversationId);
      expect(stats.messages).toBe(1);
      expect(stats.summaries).toBe(2);
      expect(stats.maxDepth).toBe(1);
    });

    it("getAllSummaries respects LIMIT", () => {
      for (let i = 0; i < 5; i++) {
        store.createSummary(conversationId, 0, `S${i}`, []);
      }
      const limited = store.getAllSummaries(conversationId, 3);
      expect(limited).toHaveLength(3);
    });
  });
});
