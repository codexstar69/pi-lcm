/**
 * Data access layer: CRUD for conversations, messages, and summaries.
 *
 * Fix 2: dedup_hash + ON CONFLICT DO NOTHING (atomic dedup, no TOCTOU)
 * Fix 3: Atomic seq via INSERT...SELECT (no in-memory counter)
 * Fix 4: getOrCreateConversation wrapped in transaction
 * Fix 5: getUnconsumedSummariesByDepth with NOT EXISTS
 * Fix 16: Empty query guard in search
 * Fix 21: Invalid regex throws typed error
 * Fix 24: Bounded getAllSummaries with LIMIT
 */

import type Database from "better-sqlite3";
import { uuid, estimateTokens, extractSearchableText, sanitizeFtsQuery } from "../utils.js";
import { hasFts5, computeDedupHash } from "./schema.js";

// ── Types ─────────────────────────────────────────────────────────

export interface Conversation {
  id: string;
  session_id: string;
  session_file: string | null;
  cwd: string;
  created_at: string;
  updated_at: string;
}

export interface StoredMessage {
  id: string;
  conversation_id: string;
  entry_id: string | null;
  role: string;
  content_text: string;
  content_json: string;
  tool_name: string | null;
  token_estimate: number;
  timestamp: number;
  seq: number;
  is_compacted: number;
}

export interface Summary {
  id: string;
  conversation_id: string;
  depth: number;
  text: string;
  token_estimate: number;
  metadata_json: string | null;
  created_at: string;
}

export interface SourceRef {
  source_type: "message" | "summary";
  source_id: string;
}

export interface SearchResult {
  id: string;
  role: string;
  content_text: string;
  timestamp: number;
  seq: number;
  snippet?: string;
  summary_id?: string;
  summary_depth?: number;
}

export interface LcmStats {
  messages: number;
  summaries: number;
  maxDepth: number;
  dbSizeBytes: number;
}

// ── Store ─────────────────────────────────────────────────────────

export class LcmStore {
  private db: Database.Database;
  private fts5Available: boolean;

  constructor(db: Database.Database) {
    this.db = db;
    this.fts5Available = hasFts5(db);
  }

  // ── Conversations ───────────────────────────────────────────────

  /** Fix 4: Wrapped in transaction to eliminate TOCTOU race. */
  getOrCreateConversation(sessionId: string, sessionFile: string | null, cwd: string): Conversation {
    return this.db.transaction(() => {
      const existing = this.db
        .prepare("SELECT * FROM conversations WHERE session_id = ?")
        .get(sessionId) as Conversation | undefined;

      if (existing) {
        this.db
          .prepare("UPDATE conversations SET updated_at = ?, session_file = COALESCE(?, session_file) WHERE id = ?")
          .run(new Date().toISOString(), sessionFile, existing.id);
        return { ...existing, updated_at: new Date().toISOString(), session_file: sessionFile ?? existing.session_file };
      }

      const id = uuid();
      const now = new Date().toISOString();
      this.db
        .prepare("INSERT INTO conversations (id, session_id, session_file, cwd, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(id, sessionId, sessionFile, cwd, now, now);

      return { id, session_id: sessionId, session_file: sessionFile, cwd, created_at: now, updated_at: now };
    })();
  }

  getConversation(id: string): Conversation | null {
    return (this.db.prepare("SELECT * FROM conversations WHERE id = ?").get(id) as Conversation) ?? null;
  }

  // ── Messages ────────────────────────────────────────────────────

  /**
   * Fix 2: Atomic dedup via dedup_hash + ON CONFLICT DO NOTHING.
   * Fix 3: Atomic seq via INSERT...SELECT subquery (no in-memory counter).
   * No TOCTOU race. No INSERT OR IGNORE hiding FK violations.
   */
  appendMessage(conversationId: string, entryId: string | null, message: any): StoredMessage | null {
    if (!message || !message.role) return null;

    const id = uuid();
    const contentText = extractSearchableText(message);
    const contentJson = JSON.stringify(message);
    const toolName = message.role === "toolResult" ? message.toolName ?? null : null;
    const tokenEst = Math.max(1, estimateTokens(contentText)); // Fix 6 (compaction): min 1 token
    const timestamp = message.timestamp ?? Date.now(); // Fix 2: normalize once
    const dedupHash = computeDedupHash(message.role, timestamp, contentText);

    // Atomic INSERT with seq computed from DB + dedup via ON CONFLICT
    const result = this.db.prepare(
      `INSERT INTO messages
       (id, conversation_id, entry_id, role, content_text, content_json, tool_name, token_estimate, timestamp, seq, dedup_hash)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?,
         COALESCE((SELECT MAX(seq) + 1 FROM messages WHERE conversation_id = ?), 0),
         ?
       WHERE TRUE
       ON CONFLICT(conversation_id, dedup_hash) DO NOTHING`,
    ).run(
      id, conversationId, entryId, message.role, contentText, contentJson,
      toolName, tokenEst, timestamp, conversationId, dedupHash,
    );

    if (result.changes === 0) return null; // Duplicate — deduped

    // Fetch the actual seq assigned
    const row = this.db.prepare("SELECT seq FROM messages WHERE id = ?").get(id) as { seq: number } | undefined;
    const seq = row?.seq ?? 0;

    return {
      id, conversation_id: conversationId, entry_id: entryId, role: message.role,
      content_text: contentText, content_json: contentJson, tool_name: toolName,
      token_estimate: tokenEst, timestamp, seq, is_compacted: 0,
    };
  }

  getMessages(conversationId: string, opts?: { from?: number; to?: number; role?: string }): StoredMessage[] {
    let sql = "SELECT * FROM messages WHERE conversation_id = ?";
    const params: any[] = [conversationId];

    if (opts?.from !== undefined) { sql += " AND seq >= ?"; params.push(opts.from); }
    if (opts?.to !== undefined) { sql += " AND seq < ?"; params.push(opts.to); }
    if (opts?.role) { sql += " AND role = ?"; params.push(opts.role); }

    sql += " ORDER BY seq ASC";
    return this.db.prepare(sql).all(...params) as StoredMessage[];
  }

  getMessagesByIds(ids: string[]): StoredMessage[] {
    if (ids.length === 0) return [];
    // Chunk to avoid SQLite parameter limit
    const results: StoredMessage[] = [];
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const placeholders = chunk.map(() => "?").join(",");
      const rows = this.db
        .prepare(`SELECT * FROM messages WHERE id IN (${placeholders}) ORDER BY seq ASC`)
        .all(...chunk) as StoredMessage[];
      results.push(...rows);
    }
    return results;
  }

  getUncompactedMessages(conversationId: string): StoredMessage[] {
    return this.db
      .prepare("SELECT * FROM messages WHERE conversation_id = ? AND is_compacted = 0 ORDER BY seq ASC")
      .all(conversationId) as StoredMessage[];
  }

  markCompacted(messageIds: string[]): void {
    if (messageIds.length === 0) return;
    const stmt = this.db.prepare("UPDATE messages SET is_compacted = 1 WHERE id = ?");
    this.db.transaction(() => {
      for (const id of messageIds) stmt.run(id);
    })();
  }

  getMessageCount(conversationId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) as count FROM messages WHERE conversation_id = ?")
      .get(conversationId) as { count: number };
    return row.count;
  }

  // ── Search ──────────────────────────────────────────────────────

  searchMessages(
    conversationId: string,
    query: string,
    opts?: { limit?: number; after?: string; before?: string },
  ): SearchResult[] {
    // Fix 16: Empty query guard
    if (!query?.trim()) return [];

    const limit = Math.min(opts?.limit ?? 20, 100);

    if (this.fts5Available) {
      return this.searchFts5(conversationId, query, limit, opts?.after, opts?.before);
    }
    return this.searchLike(conversationId, query, limit, opts?.after, opts?.before);
  }

  private searchFts5(conversationId: string, query: string, limit: number, after?: string, before?: string): SearchResult[] {
    const sanitized = sanitizeFtsQuery(query);
    if (!sanitized) return [];

    let sql = `SELECT m.id, m.role, m.content_text, m.timestamp, m.seq
      FROM messages m JOIN messages_fts fts ON m.rowid = fts.rowid
      WHERE fts.messages_fts MATCH ? AND m.conversation_id = ?`;
    const params: any[] = [sanitized, conversationId];

    if (after) { const ts = new Date(after).getTime(); if (!isNaN(ts)) { sql += " AND m.timestamp >= ?"; params.push(ts); } }
    if (before) { const ts = new Date(before).getTime(); if (!isNaN(ts)) { sql += " AND m.timestamp <= ?"; params.push(ts); } }

    sql += " ORDER BY m.seq DESC LIMIT ?";
    params.push(limit);

    try {
      return this.enrichWithSummaryInfo(this.db.prepare(sql).all(...params) as SearchResult[]);
    } catch {
      return this.searchLike(conversationId, query, limit, after, before);
    }
  }

  private searchLike(conversationId: string, query: string, limit: number, after?: string, before?: string): SearchResult[] {
    const escaped = query.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
    let sql = `SELECT id, role, content_text, timestamp, seq FROM messages
      WHERE conversation_id = ? AND content_text LIKE ? ESCAPE '\\'`;
    const params: any[] = [conversationId, `%${escaped}%`];

    if (after) { const ts = new Date(after).getTime(); if (!isNaN(ts)) { sql += " AND timestamp >= ?"; params.push(ts); } }
    if (before) { const ts = new Date(before).getTime(); if (!isNaN(ts)) { sql += " AND timestamp <= ?"; params.push(ts); } }

    sql += " ORDER BY seq DESC LIMIT ?";
    params.push(limit);

    return this.enrichWithSummaryInfo(this.db.prepare(sql).all(...params) as SearchResult[]);
  }

  /**
   * Fix 21: Invalid regex throws a typed error instead of silently returning [].
   * Fix 13 (partial): Cap content_text length tested to 50K chars.
   */
  searchMessagesRegex(conversationId: string, pattern: string, opts?: { limit?: number; timeout?: number }): SearchResult[] {
    if (!pattern?.trim()) return [];

    const limit = Math.min(opts?.limit ?? 20, 100);
    const timeoutMs = opts?.timeout ?? 5000;

    let regex: RegExp;
    try {
      regex = new RegExp(pattern, "i");
    } catch (e: any) {
      throw new Error(`Invalid regex pattern "${pattern}": ${e.message}`);
    }

    const startTime = Date.now();
    const iter = this.db
      .prepare("SELECT id, role, content_text, timestamp, seq FROM messages WHERE conversation_id = ? ORDER BY seq DESC")
      .iterate(conversationId) as IterableIterator<SearchResult>;

    const results: SearchResult[] = [];
    for (const msg of iter) {
      if (Date.now() - startTime > timeoutMs) break;
      // Fix 13: Cap text length to mitigate ReDoS on single large message
      const testText = msg.content_text.length > 50000 ? msg.content_text.slice(0, 50000) : msg.content_text;
      if (regex.test(testText)) {
        results.push(msg);
        if (results.length >= limit) break;
      }
    }

    return this.enrichWithSummaryInfo(results);
  }

  searchSummaries(conversationId: string, query: string, limit: number = 20): Summary[] {
    if (!query?.trim()) return [];
    const escaped = query.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
    return this.db
      .prepare("SELECT * FROM summaries WHERE conversation_id = ? AND text LIKE ? ESCAPE '\\' ORDER BY created_at DESC LIMIT ?")
      .all(conversationId, `%${escaped}%`, Math.min(limit, 100)) as Summary[];
  }

  private enrichWithSummaryInfo(results: SearchResult[]): SearchResult[] {
    if (results.length === 0) return results;

    // Batch lookup instead of N+1
    const ids = results.map((r) => r.id);
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const placeholders = chunk.map(() => "?").join(",");
      const sources = this.db
        .prepare(
          `SELECT ss.source_id, s.id as summary_id, s.depth FROM summaries s
           JOIN summary_sources ss ON s.id = ss.summary_id
           WHERE ss.source_type = 'message' AND ss.source_id IN (${placeholders})`,
        )
        .all(...chunk) as { source_id: string; summary_id: string; depth: number }[];

      const lookup = new Map(sources.map((s) => [s.source_id, { id: s.summary_id, depth: s.depth }]));
      for (const r of results) {
        const info = lookup.get(r.id);
        if (info) { r.summary_id = info.id; r.summary_depth = info.depth; }
      }
    }
    return results;
  }

  // ── Summaries (DAG) ─────────────────────────────────────────────

  createSummary(conversationId: string, depth: number, text: string, sources: SourceRef[], metadata?: any): Summary {
    const id = uuid();
    const now = new Date().toISOString();
    const tokenEst = estimateTokens(text);
    const metadataJson = metadata ? JSON.stringify(metadata) : null;

    this.db.transaction(() => {
      this.db.prepare(
        `INSERT INTO summaries (id, conversation_id, depth, text, token_estimate, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, conversationId, depth, text, tokenEst, metadataJson, now);

      const insertSource = this.db.prepare(
        `INSERT INTO summary_sources (summary_id, source_type, source_id, seq) VALUES (?, ?, ?, ?)`,
      );
      for (let i = 0; i < sources.length; i++) {
        insertSource.run(id, sources[i].source_type, sources[i].source_id, i);
      }
    })();

    return { id, conversation_id: conversationId, depth, text, token_estimate: tokenEst, metadata_json: metadataJson, created_at: now };
  }

  getSummary(id: string): Summary | null {
    return (this.db.prepare("SELECT * FROM summaries WHERE id = ?").get(id) as Summary) ?? null;
  }

  getSummaryParents(summaryId: string): Summary[] {
    return this.db
      .prepare(
        `SELECT s.* FROM summaries s JOIN summary_sources ss ON s.id = ss.summary_id
         WHERE ss.source_type = 'summary' AND ss.source_id = ? ORDER BY s.depth ASC`,
      )
      .all(summaryId) as Summary[];
  }

  getSummarySources(summaryId: string): { source_type: string; source_id: string; seq: number }[] {
    return this.db
      .prepare("SELECT source_type, source_id, seq FROM summary_sources WHERE summary_id = ? ORDER BY seq ASC")
      .all(summaryId) as { source_type: string; source_id: string; seq: number }[];
  }

  getSummaryLineage(summaryId: string): Summary[] {
    const lineage: Summary[] = [];
    const visited = new Set<string>();
    let currentId = summaryId;
    while (true) {
      if (visited.has(currentId)) break;
      visited.add(currentId);
      const parents = this.getSummaryParents(currentId);
      if (parents.length === 0) break;
      const parent = parents.reduce((a, b) => (a.depth > b.depth ? a : b));
      lineage.push(parent);
      currentId = parent.id;
    }
    return lineage;
  }

  getSummariesByDepth(conversationId: string, depth: number): Summary[] {
    return this.db
      .prepare("SELECT * FROM summaries WHERE conversation_id = ? AND depth = ? ORDER BY created_at ASC")
      .all(conversationId, depth) as Summary[];
  }

  /**
   * Fix 5: Get summaries NOT already consumed as sources by higher-level summaries.
   * Fix B4: Uses NOT EXISTS instead of NOT IN (avoids NULL trap).
   */
  getUnconsumedSummariesByDepth(conversationId: string, depth: number): Summary[] {
    return this.db
      .prepare(
        `SELECT s.* FROM summaries s
         WHERE s.conversation_id = ? AND s.depth = ?
           AND NOT EXISTS (
             SELECT 1 FROM summary_sources ss
             WHERE ss.source_id = s.id AND ss.source_type = 'summary'
           )
         ORDER BY s.created_at ASC`,
      )
      .all(conversationId, depth) as Summary[];
  }

  getUnconsumedSummaryCount(conversationId: string, depth: number): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) as count FROM summaries s
         WHERE s.conversation_id = ? AND s.depth = ?
           AND NOT EXISTS (
             SELECT 1 FROM summary_sources ss
             WHERE ss.source_id = s.id AND ss.source_type = 'summary'
           )`,
      )
      .get(conversationId, depth) as { count: number };
    return row.count;
  }

  getSummaryCount(conversationId: string, depth: number): number {
    const row = this.db
      .prepare("SELECT COUNT(*) as count FROM summaries WHERE conversation_id = ? AND depth = ?")
      .get(conversationId, depth) as { count: number };
    return row.count;
  }

  getMaxDepth(conversationId: string): number {
    const row = this.db
      .prepare("SELECT MAX(depth) as max_depth FROM summaries WHERE conversation_id = ?")
      .get(conversationId) as { max_depth: number | null };
    return row.max_depth ?? -1;
  }

  /** Fix 24: Bounded with LIMIT. */
  getAllSummaries(conversationId: string, limit: number = 100): Summary[] {
    return this.db
      .prepare("SELECT * FROM summaries WHERE conversation_id = ? ORDER BY depth DESC, created_at DESC LIMIT ?")
      .all(conversationId, limit) as Summary[];
  }

  getLatestSummaryPerDepth(conversationId: string): Summary[] {
    return this.db
      .prepare(
        `SELECT s.* FROM summaries s
         INNER JOIN (SELECT depth, MAX(rowid) as max_rowid FROM summaries WHERE conversation_id = ? GROUP BY depth)
         latest ON s.depth = latest.depth AND s.rowid = latest.max_rowid
         WHERE s.conversation_id = ? ORDER BY s.depth DESC`,
      )
      .all(conversationId, conversationId) as Summary[];
  }

  getStats(conversationId: string): LcmStats {
    const msgCount = this.getMessageCount(conversationId);
    const summaryRow = this.db
      .prepare("SELECT COUNT(*) as count FROM summaries WHERE conversation_id = ?")
      .get(conversationId) as { count: number };
    const maxDepth = this.getMaxDepth(conversationId);
    let dbSizeBytes = 0;
    try {
      const sizeRow = this.db
        .prepare("SELECT page_count * page_size as size FROM pragma_page_count(), pragma_page_size()")
        .get() as { size: number } | undefined;
      dbSizeBytes = sizeRow?.size ?? 0;
    } catch { /* ignore */ }

    return { messages: msgCount, summaries: summaryRow.count, maxDepth: Math.max(0, maxDepth), dbSizeBytes };
  }
}
