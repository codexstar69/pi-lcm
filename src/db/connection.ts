/**
 * SQLite connection management with WAL mode, busy timeout, and cwd tracking.
 * Fix 8: Track currentCwd, close+reopen on mismatch.
 * Fix 15: PASSIVE checkpoint on close, TRUNCATE after compaction.
 */

import Database from "better-sqlite3";
import { mkdirSync, chmodSync } from "fs";
import { join } from "path";
import { hashCwd } from "../utils.js";

let db: Database.Database | null = null;
let currentCwd: string | null = null;

export function getDbPath(dbDir: string, cwd: string): string {
  return join(dbDir, `${hashCwd(cwd)}.db`);
}

export function openDb(dbDir: string, cwd: string): Database.Database {
  // Fix 8: If already open for a different cwd, close first
  if (db && currentCwd !== cwd) {
    closeDb();
  }
  if (db) return db;

  // Fix 14: Secure directory permissions
  mkdirSync(dbDir, { recursive: true, mode: 0o700 });
  const dbPath = getDbPath(dbDir, cwd);

  db = new Database(dbPath);

  // Fix 14: Secure file permissions
  try { chmodSync(dbPath, 0o600); } catch { /* may fail on some FS */ }

  // Connection pragmas
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  db.pragma("synchronous = NORMAL");

  ensureMetadata(db, cwd);
  currentCwd = cwd;

  return db;
}

export function closeDb(): void {
  if (!db) return;
  try {
    // Fix 15: PASSIVE on close (non-blocking, won't fail if readers exist)
    db.pragma("wal_checkpoint(PASSIVE)");
  } catch { /* non-fatal */ }
  try {
    db.close();
  } catch { /* ignore close errors */ }
  db = null;
  currentCwd = null;
}

/** TRUNCATE checkpoint after compaction (safe — called under mutex). */
export function checkpointDb(): void {
  if (!db) return;
  try {
    db.pragma("wal_checkpoint(TRUNCATE)");
  } catch { /* non-fatal */ }
}

function ensureMetadata(database: Database.Database, cwd: string): void {
  database.prepare(
    `CREATE TABLE IF NOT EXISTS _metadata (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`
  ).run();

  const row = database.prepare("SELECT value FROM _metadata WHERE key = 'cwd'").get() as
    | { value: string }
    | undefined;

  if (!row) {
    database.prepare("INSERT INTO _metadata (key, value) VALUES ('cwd', ?)").run(cwd);
  } else if (row.value !== cwd) {
    console.warn(
      `[LCM] DB cwd mismatch: stored="${row.value}" current="${cwd}". ` +
        `This may indicate a hash collision or moved project.`,
    );
  }
}
