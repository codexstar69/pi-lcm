# Contributing to pi-lcm

Thanks for your interest in contributing.

## Ways to Contribute

- **Report bugs** — open an issue with reproduction steps
- **Suggest features** — open a feature request issue
- **Submit PRs** — bug fixes, improvements, documentation
- **Improve docs** — fix typos, add examples, clarify instructions

## Development Setup

```bash
git clone https://github.com/codexstar69/pi-lcm.git
cd pi-lcm
bun install
bun run test
```

To test inside Pi:

```bash
pi -e ./index.ts
```

## Project Structure

```
index.ts                    # Extension entry point
src/
├── db/
│   ├── connection.ts       # SQLite connection (WAL, busy_timeout)
│   ├── schema.ts           # Migrations, FTS5 setup, dedup_hash
│   └── store.ts            # Data access layer
├── compaction/
│   ├── engine.ts           # Two-phase compaction with mutex
│   ├── prompts.ts          # Depth-aware summarization prompts
│   └── assembler.ts        # Token-budgeted summary assembly
├── tools/
│   ├── lcm-grep.ts         # FTS5 + regex search
│   ├── lcm-describe.ts     # DAG overview
│   └── lcm-expand.ts       # Drill-down with cycle guard
├── config.ts               # Configuration resolution
├── context.ts              # Static system prompt preamble
├── settings.ts             # Load/save from settings.json
├── settings-panel.ts       # TUI overlay component
├── persistor.ts            # message_end hook
├── commands.ts             # /lcm command handler
├── status.ts               # Footer widget
└── utils.ts                # Token estimation, text extraction, FTS5 sanitization
```

## Pull Request Guidelines

1. Keep PRs focused. One concern per PR.
2. Run tests: `bun run test`
3. Update CHANGELOG.md with your changes.
4. Follow existing code style (no formatter enforced, just be consistent).

## Testing

```bash
bun run test              # Run all 46 tests
bun run test:watch        # Watch mode
```

Tests use vitest with in-memory SQLite databases. No external dependencies needed.
