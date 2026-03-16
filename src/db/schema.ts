/**
 * Database schema and migrations.
 * Fix 1: UNIQUE(session_id), UNIQUE(conversation_id, seq), dedup_hash column.
 * Fix 23: Atomic FTS5 setup with SAVEPOINT.
 */

import type Database from "better-sqlite3";
import { createHash } from "crypto";

const SCHEMA_VERSION = 2;

export function runMigrations(db: Database.Database): void {
  const hasVersionTable = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='_schema_version'")
    .get();

  let currentVersion = 0;
  if (hasVersionTable) {
    const row = db.prepare("SELECT version FROM _schema_version ORDER BY version DESC LIMIT 1").get() as
      | { version: number }
      | undefined;
    currentVersion = row?.version ?? 0;
  }

  if (currentVersion >= SCHEMA_VERSION) return;

  const migrate = db.transaction(() => {
    if (currentVersion < 1) {
      applyV1(db);
      db.prepare("INSERT INTO _schema_version (version) VALUES (?)").run(1);
    }
    if (currentVersion < 2) {
      applyV2(db);
      db.prepare("INSERT INTO _schema_version (version) VALUES (?)").run(2);
    }
  });

  migrate();
}

function applyV1(db: Database.Database): void {
  db.prepare(
    `CREATE TABLE IF NOT EXISTS _schema_version (
      version INTEGER NOT NULL
    )`
  ).run();

  // Fix 1: UNIQUE(session_id) on conversations
  db.prepare(
    `CREATE TABLE IF NOT EXISTS conversations (
      id            TEXT PRIMARY KEY,
      session_id    TEXT NOT NULL UNIQUE,
      session_file  TEXT,
      cwd           TEXT NOT NULL,
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL
    )`
  ).run();

  // Fix 1: dedup_hash column + UNIQUE constraint; Fix 3: UNIQUE(conversation_id, seq)
  db.prepare(
    `CREATE TABLE IF NOT EXISTS messages (
      id              TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id),
      entry_id        TEXT,
      role            TEXT NOT NULL,
      content_text    TEXT NOT NULL,
      content_json    TEXT NOT NULL,
      tool_name       TEXT,
      token_estimate  INTEGER NOT NULL,
      timestamp       INTEGER NOT NULL,
      seq             INTEGER NOT NULL,
      is_compacted    INTEGER DEFAULT 0,
      dedup_hash      TEXT NOT NULL,
      UNIQUE(conversation_id, seq),
      UNIQUE(conversation_id, dedup_hash)
    )`
  ).run();

  // Fix 23: Atomic FTS5 setup with SAVEPOINT
  setupFts5(db);

  db.prepare(
    `CREATE TABLE IF NOT EXISTS summaries (
      id              TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id),
      depth           INTEGER NOT NULL,
      text            TEXT NOT NULL,
      token_estimate  INTEGER NOT NULL,
      metadata_json   TEXT,
      created_at      TEXT NOT NULL
    )`
  ).run();

  db.prepare(
    `CREATE TABLE IF NOT EXISTS summary_sources (
      summary_id  TEXT NOT NULL REFERENCES summaries(id),
      source_type TEXT NOT NULL,
      source_id   TEXT NOT NULL,
      seq         INTEGER NOT NULL,
      PRIMARY KEY (summary_id, source_type, source_id)
    )`
  ).run();

  db.prepare("CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, seq)").run();
  db.prepare("CREATE INDEX IF NOT EXISTS idx_messages_role ON messages(conversation_id, role)").run();
  db.prepare("CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(conversation_id, timestamp)").run();
  db.prepare("CREATE INDEX IF NOT EXISTS idx_summaries_conversation ON summaries(conversation_id, depth)").run();
  db.prepare("CREATE INDEX IF NOT EXISTS idx_summary_sources_source ON summary_sources(source_type, source_id)").run();
}

/** V2 migration: add dedup_hash to existing DBs that were created under V1. */
function applyV2(db: Database.Database): void {
  // Check if dedup_hash column already exists
  const cols = db.prepare("PRAGMA table_info(messages)").all() as { name: string }[];
  if (cols.some((c) => c.name === "dedup_hash")) return;

  // Add column
  db.prepare("ALTER TABLE messages ADD COLUMN dedup_hash TEXT").run();

  // Backfill existing rows
  const rows = db.prepare("SELECT rowid, role, timestamp, content_text FROM messages WHERE dedup_hash IS NULL").all() as any[];
  const update = db.prepare("UPDATE messages SET dedup_hash = ? WHERE rowid = ?");
  for (const row of rows) {
    const hash = computeDedupHash(row.role, row.timestamp, row.content_text);
    update.run(hash, row.rowid);
  }

  // Now add the unique index (after backfill)
  try {
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_dedup ON messages(conversation_id, dedup_hash)").run();
  } catch {
    // May have duplicates in legacy data — skip index, dedup works via pre-check
    console.warn("[LCM] Could not create dedup index on legacy data (possible duplicates)");
  }
}

function setupFts5(db: Database.Database): void {
  // Fix 23: SAVEPOINT for atomic FTS5 setup
  try {
    db.prepare("SAVEPOINT fts_setup").run();

    db.prepare(
      `CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        content_text,
        content='messages',
        content_rowid='rowid'
      )`
    ).run();

    db.prepare(
      `CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, content_text) VALUES (new.rowid, new.content_text);
      END`
    ).run();

    db.prepare(
      `CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content_text)
          VALUES ('delete', old.rowid, old.content_text);
      END`
    ).run();

    db.prepare(
      `CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content_text)
          VALUES ('delete', old.rowid, old.content_text);
        INSERT INTO messages_fts(rowid, content_text) VALUES (new.rowid, new.content_text);
      END`
    ).run();

    db.prepare("RELEASE fts_setup").run();
  } catch {
    try { db.prepare("ROLLBACK TO fts_setup").run(); } catch {}
    try { db.prepare("RELEASE fts_setup").run(); } catch {}
    console.warn("[LCM] FTS5 not available, falling back to LIKE-based search");
  }
}

/** Compute dedup hash: SHA-1 of role|timestamp|first 200 chars of content. */
export function computeDedupHash(role: string, timestamp: number, contentText: string): string {
  return createHash("sha1")
    .update(`${role}|${timestamp}|${contentText.slice(0, 200)}`)
    .digest("hex")
    .slice(0, 16);
}

export function hasFts5(db: Database.Database): boolean {
  try {
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='messages_fts'").get();
    return !!row;
  } catch {
    return false;
  }
}
