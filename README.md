<p align="center">
  <h1 align="center">pi-lcm</h1>
  <p align="center"><strong>Lossless context management for Pi. Never lose a message again.</strong></p>
</p>

<p align="center">
  <!-- BADGES:START -->
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT"></a>
  <a href="https://www.npmjs.com/package/pi-lcm"><img src="https://img.shields.io/npm/v/pi-lcm.svg" alt="npm version"></a>
  <img src="https://img.shields.io/badge/TypeScript-5.x-blue.svg" alt="TypeScript">
  <img src="https://img.shields.io/badge/Pi-0.58+-purple.svg" alt="Pi 0.58+">
  <img src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg" alt="PRs Welcome">
  <!-- BADGES:END -->
</p>

<p align="center">
  <a href="#install">Install</a> ·
  <a href="#quick-start">Quick Start</a> ·
  <a href="#how-it-works">How It Works</a> ·
  <a href="#features">Features</a> ·
  <a href="#configuration">Configuration</a> ·
  <a href="#contributing">Contributing</a>
</p>

---

Pi's default compaction throws away old messages when the context window fills up. A single flat summary replaces everything, and the original messages are gone forever.

pi-lcm fixes this. Every message is stored permanently in SQLite. When compaction triggers, messages are summarized into a hierarchical DAG (directed acyclic graph) instead of a flat blob. The agent can search and drill back into any compressed node to recover the original detail.

## Install

```bash
# From npm
pi install npm:pi-lcm

# From source (development)
git clone https://github.com/codexstar69/pi-lcm.git
cd pi-lcm
bun install
pi -e ./index.ts
```

## Quick Start

Install the extension and start Pi. That's it. pi-lcm works automatically:

1. Every message is persisted to SQLite as it happens
2. When Pi triggers compaction, pi-lcm creates hierarchical DAG summaries instead of flat text
3. The agent gets three tools to recover detail from compressed history

No configuration needed. Default settings work well for most sessions.

## How It Works

```
Pi Session
│
├── message_end ──► SQLite (every message stored permanently)
│
├── session_before_compact ──► CompactionEngine
│   ├── Leaf pass: raw messages → D0 summaries (parallel, 4 workers)
│   ├── Condensed pass: D0 → D1 → D2+ (cascading until stable)
│   └── Assembly: DAG summaries → token-budgeted output for Pi
│
├── before_agent_start ──► Static system prompt preamble (cache-safe)
│
└── registerTool ──► lcm_grep, lcm_describe, lcm_expand
```

**The DAG grows logarithmically.** With a condensation threshold of 6, you need 7 compaction cycles to get a D1 summary, 43 to get D2, 259 to get D3. A conversation can run for thousands of turns and the DAG stays compact.

**Prompt caching is preserved.** The system prompt preamble is a static const string, identical every turn. Dynamic stats go in the compaction summary message (which only changes on compaction). Zero extra cache misses.

## Features

### Message Persistence
- Every `AgentMessage` stored in SQLite with FTS5 full-text search
- Idempotent inserts via `dedup_hash` (safe for session resume)
- Atomic sequence numbers via `INSERT...SELECT` (no race conditions)
- Per-project database (cross-session history within the same project)

### DAG Compaction
- Two-phase: leaf pass (messages → D0) then condensed pass (D0 → D1 → D2+)
- Parallel leaf summarization (configurable concurrency, default 4)
- Bounded cascade loop (max 10 passes per cycle)
- Consumed summaries filtered via `NOT EXISTS` (no re-condensation)
- Failed chunks stay uncompacted for retry next cycle (no data loss)
- Per-conversation mutex prevents duplicate summaries

### Agent Tools

| Tool | Purpose |
|------|---------|
| `lcm_grep` | Search all history by text (FTS5) or regex. Returns snippets with context. Time-range filtering. |
| `lcm_describe` | Overview of the summary DAG, recent/earliest activity, or detail on a specific summary ID. |
| `lcm_expand` | Drill into any compressed summary to recover original messages. Hard 8K token cap. Cycle-safe. |

### Security
- XML-fenced content in summarization prompts (prompt injection mitigation)
- FTS5 query sanitization (no syntax injection)
- Regex execution with 50K char cap per message (ReDoS mitigation)
- DB directory permissions: 0o700 dir, 0o600 file
- Path validation on `LCM_DB_DIR` (no traversal)

### Settings TUI
- `/lcm-settings` opens an interactive overlay panel
- Toggle, adjust, and edit all settings with keyboard navigation
- Global or project-scoped settings (`.pi/settings.json`)
- Changes apply instantly, no restart needed

## Configuration

Open the settings panel with `/lcm-settings`, or edit `~/.pi/agent/settings.json` directly:

```json
{
  "lcm": {
    "enabled": true,
    "leafChunkTokens": 4000,
    "condensationThreshold": 6,
    "maxDepth": 5,
    "maxSummaryTokens": 8000,
    "minMessagesForCompaction": 10,
    "leafPassConcurrency": 4,
    "debugMode": false
  }
}
```

| Setting | Default | Description |
|---------|---------|-------------|
| `enabled` | `true` | Enable/disable the extension |
| `leafChunkTokens` | `4000` | Token budget per leaf summary chunk |
| `condensationThreshold` | `6` | Number of summaries at one depth before condensing up |
| `maxDepth` | `5` | Maximum DAG depth levels |
| `maxSummaryTokens` | `8000` | Token budget for the assembled compaction output |
| `minMessagesForCompaction` | `10` | Skip DAG compaction if fewer messages (falls back to Pi default) |
| `leafPassConcurrency` | `4` | Parallel workers for leaf summarization |
| `debugMode` | `false` | Verbose logging and notifications |

Environment variables also work: `LCM_ENABLED`, `LCM_LEAF_CHUNK_TOKENS`, `LCM_DEBUG`, etc.

Project-level settings (`.pi/settings.json`) override global settings.

## Commands

| Command | Description |
|---------|-------------|
| `/lcm stats` | Show message count, summary count, DAG depth, DB size |
| `/lcm tree` | Visualize the summary DAG |
| `/lcm compact` | Trigger manual compaction |
| `/lcm settings` | Open the settings panel |
| `/lcm-settings` | Open the settings panel (standalone) |

## Compaction Models

pi-lcm uses a cheap fast model for summarization, not your session model. It tries in order:

1. `cerebras/zai-glm-4.7` (fast, free)
2. `anthropic/claude-haiku-4-5` (reliable fallback)
3. Session model (last resort)

Configure custom models in settings.json under `compactionModels`.

## Development

```bash
git clone https://github.com/codexstar69/pi-lcm.git
cd pi-lcm
bun install
bun run test          # 46 tests
pi -e ./index.ts      # Load in Pi for testing
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and guidelines.

## Security

See [SECURITY.md](SECURITY.md) for reporting vulnerabilities.

## License

MIT. See [LICENSE](LICENSE).
