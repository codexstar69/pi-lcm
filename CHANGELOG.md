# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.3] — 2026-04-03

### Fixed
- **Pi API compatibility: session events** — `session_start` now uses per-event
  `event.reason` detection for new Pi API (reason-based routing for `startup`,
  `reload`, `new`, `resume`, `fork`). Legacy `session_switch`/`session_fork`
  handlers preserved for backward compatibility with older Pi versions.
- **Pi API compatibility: auth migration** — `ModelRegistry.getApiKey(model)`
  replaced with `getApiKeyAndHeaders(model)` via runtime `typeof` guard, with
  automatic fallback to `getApiKey()` for older Pi versions. Both `apiKey` and
  `headers` are now forwarded to all `complete()` calls.
- **Auth response shape validation** — all auth call sites now validate the full
  success payload (`auth.ok` boolean, `apiKey` non-empty string, `headers` object
  sanitization). Malformed responses abort gracefully without making LLM calls.
- **Security** — no raw API keys or auth headers are logged in any error path.

## [0.1.0] — 2026-03-16

### Added
- SQLite message persistence via `message_end` hook with FTS5 full-text search
- DAG-based compaction engine (leaf + condensed passes) replacing Pi's default lossy compaction
- Three agent tools: `lcm_grep`, `lcm_describe`, `lcm_expand` for history recovery
- Static system prompt preamble preserving Anthropic/OpenAI prompt caching
- Interactive TUI settings panel (`/lcm-settings`) with keyboard navigation
- Per-conversation compaction mutex preventing duplicate summaries
- Atomic message deduplication via `dedup_hash` + `ON CONFLICT DO NOTHING`
- Atomic sequence numbers via `INSERT...SELECT` (no in-memory counter)
- Session lifecycle handling: `session_switch`, `session_fork`, `session_shutdown`
- Consumed summary filtering via `NOT EXISTS` preventing unbounded DAG growth
- Bounded condensation cascade (max 10 passes per cycle)
- Failed chunks stay uncompacted for retry (no data loss on summarization failure)
- XML-fenced summarization prompts (prompt injection mitigation)
- FTS5 query sanitization, regex 50K char cap, path validation, file permissions
- Configuration via `~/.pi/agent/settings.json` or project `.pi/settings.json`
- Environment variable overrides for all settings
- `/lcm` command with `stats`, `tree`, `compact`, `settings` subcommands
- Footer status widget showing message count, summaries, depth, DB size
- 46 tests covering store, compaction, tools, and cache safety
