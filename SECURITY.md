# Security Policy

## Reporting a Vulnerability

**Do NOT open a public GitHub issue for security vulnerabilities.**

Instead, use [GitHub's private vulnerability reporting](https://github.com/codexstar69/pi-lcm/security/advisories/new).

## Scope

pi-lcm stores conversation history in a local SQLite database. Relevant security concerns:

- **SQL injection** via search queries (FTS5 MATCH, LIKE patterns, regex)
- **Prompt injection** via stored messages influencing summarization
- **ReDoS** via agent-supplied regex patterns
- **Path traversal** via `LCM_DB_DIR` configuration
- **Data leakage** from the unencrypted SQLite database

## What Does NOT Qualify

- Issues in Pi itself (report to github.com/badlogic/pi-mono)
- Issues in better-sqlite3 (report upstream)
- The database being unencrypted (documented, by design for performance)

## Response Timeline

- Acknowledgment within 48 hours
- Assessment within 7 days
- Patch within 14 days for confirmed vulnerabilities
