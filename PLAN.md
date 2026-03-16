# Pi Lossless Context Management (pi-lcm)

> A Pi extension that replaces the default lossy compaction with a DAG-based
> summarization system backed by SQLite. Every message is persisted permanently.
> Older messages are hierarchically summarized into a directed acyclic graph.
> The agent can always recover full detail via `lcm_grep`, `lcm_describe`, and
> `lcm_expand` tools.

## Problem

Pi's default compaction is lossy: when context fills up, older messages are
summarized into a flat markdown blob and the originals are never accessible
again. The existing `pi-agentic-compaction` extension improves the summary
quality (agentic jq exploration) but is still a single-pass lossy process.

For long-running sessions, multi-hour debugging, or mission workers that
accumulate deep context, this means:

- Specific error messages, stack traces, and code snippets from early in the
  conversation are gone forever after the first compaction.
- The agent cannot search or recall details from compacted history.
- Each successive compaction compounds information loss (summary of a summary).
- Large files read early in the session disappear entirely.

## Solution

**pi-lcm** implements Lossless Context Management as a Pi extension:

1. **SQLite persistence** -- every message is stored permanently, indexed, and
   searchable.
2. **Hierarchical DAG summarization** -- multi-depth compaction (leaf D0 →
   condensed D1 → deeper D2+) that logarithmically compresses history.
3. **Agent recovery tools** -- `lcm_grep`, `lcm_describe`, `lcm_expand` let the
   agent drill back into any compressed node to recover original detail.
4. **Smart context assembly** -- the `context` event injects a DAG-awareness
   preamble so the model knows it can recall history.

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────────┐
│                        Pi Session                                │
│                                                                  │
│  message_end ──► MessagePersistor ──► SQLite (messages table)    │
│                                                                  │
│  session_before_compact ──► CompactionEngine                     │
│                               │                                  │
│                               ├── leafPass: messages → D0 nodes  │
│                               ├── condensedPass: D0 → D1 → D2+  │
│                               └── returns summary + DAG refs     │
│                                                                  │
│  context ──► ContextEnricher                                     │
│               └── injects "you have LCM tools" preamble          │
│                                                                  │
│  registerTool ──► lcm_grep     (regex/text search all history)   │
│                ─► lcm_describe (section summaries + lineage)     │
│                ─► lcm_expand   (drill into compressed nodes)     │
│                                                                  │
│  session_start ──► bootstrap SQLite, load/create conversation    │
│  session_shutdown ──► flush + close SQLite connection             │
└──────────────────────────────────────────────────────────────────┘

SQLite Schema:
┌─────────────┐    ┌─────────────────┐    ┌──────────────────┐
│conversations│    │    messages      │    │    summaries     │
├─────────────┤    ├─────────────────┤    ├──────────────────┤
│ id (PK)     │◄──┤ conversation_id  │    │ id (PK)          │
│ session_id  │    │ id (PK)         │    │ conversation_id   │
│ created_at  │    │ entry_id        │    │ depth (0,1,2...) │
│ updated_at  │    │ role            │    │ text             │
└─────────────┘    │ content_text    │    │ token_count      │
                   │ content_json    │    │ created_at       │
                   │ timestamp       │    └──────────────────┘
                   │ token_estimate  │             │
                   └─────────────────┘             │
                          ▲                        │
                          │              ┌─────────┴────────┐
                   ┌──────┴───────┐     │ summary_sources   │
                   │ message_fts  │     ├────────────────── │
                   │ (FTS5 virt.) │     │ summary_id (FK)   │
                   └──────────────┘     │ source_type       │
                                        │ source_id         │
                                        │ (message or       │
                                        │  summary FK)      │
                                        └───────────────────┘
```

## Pi Extension API Surface Used

| API                       | Purpose                                      |
|---------------------------|----------------------------------------------|
| `session_start`           | Bootstrap SQLite, create/load conversation    |
| `session_shutdown`        | Flush pending writes, close DB                |
| `message_end`             | Persist each message to SQLite                |
| `session_before_compact`  | Replace default compaction with DAG-based     |
| `context`                 | Inject LCM preamble into messages             |
| `before_agent_start`      | Inject LCM tool guidelines into system prompt |
| `pi.registerTool()`       | Register lcm_grep, lcm_describe, lcm_expand  |
| `pi.registerCommand()`    | Register /lcm command for stats/admin         |
| `pi.appendEntry()`        | Persist DAG metadata to session JSONL         |
| `ctx.modelRegistry`       | Get compaction model + API key                |
| `ctx.ui.notify()`         | Status updates during compaction              |
| `ctx.ui.setStatus()`      | Footer showing message count + DB size        |

## Detailed Component Design

### 1. Database Layer (`src/db/`)

#### `connection.ts` -- SQLite connection management

- Use `better-sqlite3` (synchronous, fast, no native async overhead).
- DB location: `~/.pi/agent/lcm/<sha256(cwd)[:16]>.db`
  - One DB per project directory (conversations span sessions in that project).
  - SHA-256 hash of the absolute cwd, truncated to 16 hex chars (collision-safe).
  - A `_metadata` table stores the original cwd path for verification on open.
  - On open: if stored cwd doesn't match current cwd, log warning + create new DB.
  - WAL mode for concurrent reads during tool execution.
- `PRAGMA busy_timeout = 5000` for concurrent session safety.
- Ref-counted connections so multiple tools can read simultaneously.
- Graceful close on `session_shutdown`.
- WAL checkpoint on compaction + shutdown.

#### `schema.ts` -- migrations

Tables:

```sql
-- Conversations: one per Pi session
CREATE TABLE conversations (
  id            TEXT PRIMARY KEY,   -- UUID
  session_id    TEXT NOT NULL,      -- Pi session UUID
  session_file  TEXT,               -- Path to .jsonl file
  cwd           TEXT NOT NULL,      -- Working directory
  created_at    TEXT NOT NULL,      -- ISO timestamp
  updated_at    TEXT NOT NULL
);

-- Messages: every AgentMessage persisted
CREATE TABLE messages (
  id              TEXT PRIMARY KEY,   -- UUID
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  entry_id        TEXT,               -- Pi session entry ID (8-char hex)
  role            TEXT NOT NULL,      -- user|assistant|toolResult|bashExecution|custom|...
  content_text    TEXT NOT NULL,      -- Extracted plaintext (searchable)
  content_json    TEXT NOT NULL,      -- Full AgentMessage JSON
  tool_name       TEXT,               -- For toolResult messages
  token_estimate  INTEGER NOT NULL,   -- Estimated token count
  timestamp       INTEGER NOT NULL,   -- Unix ms from message
  seq             INTEGER NOT NULL,   -- Monotonic sequence within conversation
  is_compacted    INTEGER DEFAULT 0,  -- 1 if covered by a leaf summary
  UNIQUE(conversation_id, seq)
);

-- FTS5 full-text search on message content
CREATE VIRTUAL TABLE messages_fts USING fts5(
  content_text,
  content='messages',
  content_rowid='rowid'
);

-- Summaries: the DAG nodes (no parent_id — use summary_sources for all lineage)
CREATE TABLE summaries (
  id              TEXT PRIMARY KEY,   -- UUID
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  depth           INTEGER NOT NULL,   -- 0=leaf, 1=condensed, 2+=deeper
  text            TEXT NOT NULL,      -- Summary markdown
  token_estimate  INTEGER NOT NULL,
  metadata_json   TEXT,               -- JSON: model used, token counts, etc.
  created_at      TEXT NOT NULL
  -- NOTE: No parent_id column. All lineage tracked via summary_sources table.
  -- This supports true DAG structure (a summary can be referenced by multiple
  -- higher-level summaries) without the confusion of a single parent_id FK.
  -- To walk up: query summary_sources WHERE source_type='summary' AND source_id=this.id
);

-- Links summaries to their source messages or child summaries
CREATE TABLE summary_sources (
  summary_id  TEXT NOT NULL REFERENCES summaries(id),
  source_type TEXT NOT NULL,  -- 'message' or 'summary'
  source_id   TEXT NOT NULL,  -- FK to messages.id or summaries.id
  seq         INTEGER NOT NULL,  -- Order within the summary's sources
  PRIMARY KEY (summary_id, source_type, source_id)
);

-- Large files: DEFERRED TO v2
-- Interception heuristic, dedup strategy, and tool integration need full design.
-- For v1, large file content is stored in the messages table like everything else.
-- CREATE TABLE large_files (...) will be added in a future migration.

-- FTS5 sync triggers (CRITICAL — without these, search returns stale results)
CREATE TRIGGER messages_fts_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, content_text) VALUES (new.rowid, new.content_text);
END;
CREATE TRIGGER messages_fts_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content_text) VALUES ('delete', old.rowid, old.content_text);
END;
CREATE TRIGGER messages_fts_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content_text) VALUES ('delete', old.rowid, old.content_text);
  INSERT INTO messages_fts(rowid, content_text) VALUES (new.rowid, new.content_text);
END;

-- Indexes
CREATE INDEX idx_messages_conversation ON messages(conversation_id, seq);
CREATE INDEX idx_messages_role ON messages(conversation_id, role);
CREATE INDEX idx_messages_timestamp ON messages(conversation_id, timestamp);
CREATE INDEX idx_summaries_conversation ON summaries(conversation_id, depth);
CREATE INDEX idx_summary_sources_source ON summary_sources(source_type, source_id);
```

Migration system: version table + sequential migrations applied on connect.

#### Connection pragmas (applied on every open)

```sql
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;   -- Handle concurrent sessions in same project
PRAGMA foreign_keys = ON;
PRAGMA synchronous = NORMAL;  -- Safe with WAL, faster than FULL
```

WAL checkpointing: `PRAGMA wal_checkpoint(TRUNCATE)` runs after every
compaction cycle and on `session_shutdown` to prevent unbounded WAL growth.

#### `store.ts` -- data access layer

```typescript
class LcmStore {
  // Conversations
  getOrCreateConversation(sessionId: string, sessionFile: string, cwd: string): Conversation;
  getConversation(id: string): Conversation | null;

  // Messages
  appendMessage(conversationId: string, entryId: string, message: AgentMessage): StoredMessage;
  getMessages(conversationId: string, opts?: { from?: number; to?: number; role?: string }): StoredMessage[];
  searchMessages(conversationId: string, query: string, opts?: { regex?: boolean; limit?: number }): SearchResult[];
  getMessagesByIds(ids: string[]): StoredMessage[];
  markCompacted(messageIds: string[]): void;

  // Summaries (DAG)
  createSummary(conversationId: string, depth: number, text: string, sourceIds: SourceRef[], parentId?: string): Summary;
  getSummary(id: string): Summary | null;
  getSummaryChildren(summaryId: string): Summary[];  // Query: summary_sources WHERE source_type='summary' AND source_id=summaryId
  getSummaryLineage(summaryId: string): Summary[];   // Walk up via summary_sources (reverse: find summaries that reference this one)
  getLeafSummaries(conversationId: string): Summary[];
  getUncompactedMessages(conversationId: string): StoredMessage[];
  getOldestUncompactedChunk(conversationId: string, chunkSize: number): StoredMessage[];
  getShallowestCondensationCandidate(conversationId: string): Summary[];
  searchSummaries(conversationId: string, query: string): SearchResult[];

  // Stats
  getStats(conversationId: string): { messages: number; summaries: number; depth: number; dbSize: number };

  // FTS5 query sanitization (escape special chars for MATCH expressions)
  sanitizeFtsQuery(query: string): string;

  // Regex search with timeout protection (5s max, ReDoS-safe)
  searchMessagesRegex(conversationId: string, pattern: string, opts?: { limit?: number; timeout?: number }): SearchResult[];
}
```

### 2. Compaction Engine (`src/compaction.ts`)

Replaces Pi's default compaction via `session_before_compact`. Two-phase
approach matching Lossless Claw's architecture:

#### Phase 1: Leaf Pass

When compaction triggers:

0. **Minimum threshold check:** If fewer than 10 uncompacted messages exist,
   skip DAG compaction and fall through to Pi's default compaction. This
   prevents creating summaries larger than the original messages.
1. Get all uncompacted messages older than `firstKeptEntryId`.
2. Chunk them into groups of ~4000 tokens (configurable `LEAF_CHUNK_TOKENS`).
3. For each chunk, call the compaction model to generate a depth-0 summary.
4. Store each summary in `summaries` table with links to source messages.
5. Mark source messages as `is_compacted = 1`.

#### Phase 1.5: Parallel Leaf Pass

Leaf chunks are independent — summarize them concurrently with a concurrency
limit of 4 (`Promise.allSettled` with pool). This cuts compaction latency by
~4x for large compaction cycles (20 chunks → 5 batches instead of 20 serial).

If a chunk fails after 2 retries with fallback model, store a placeholder
summary: `"[Summary unavailable — use lcm_expand to see original messages]"`
with the source message links intact. Don't block the entire compaction.

#### Phase 2: Condensed Pass

After the leaf pass, check if there are too many depth-0 summaries.

**Precise condensation algorithm:**

1. Starting at depth 0, count summaries at that depth for this conversation.
2. If count > `CONDENSATION_THRESHOLD` (default 6):
   a. Select the **oldest `CONDENSATION_THRESHOLD` summaries** at this depth
      (ordered by `created_at`).
   b. Summarize them into a single depth-(N+1) summary using the depth-aware
      prompt for level N+1.
   c. Link the new summary to its sources via `summary_sources`.
   d. The source summaries remain in the DB (not deleted) but are now
      "covered" by the higher-level summary.
3. Increment depth and repeat from step 1.
4. Stop when: no depth has more than `CONDENSATION_THRESHOLD` summaries,
   OR depth exceeds `MAX_DEPTH` (default 5).

**State transition example (30 compaction cycles):**

```
After compaction  1: D0: 1
After compaction  6: D0: 6
After compaction  7: D0: 2, D1: 1  (oldest 6 D0s → 1 D1)
After compaction 12: D0: 6, D1: 1
After compaction 13: D0: 2, D1: 2  (oldest 6 D0s → 1 D1)
After compaction 42: D0: 2, D1: 6
After compaction 43: D0: 2, D1: 2, D2: 1  (oldest 6 D1s → 1 D2)
```

The DAG grows logarithmically: O(log_T(N)) depth where T is threshold and
N is total compaction count.

#### Summary Assembly for Pi

After both passes, assemble the final compaction summary that Pi will use.

**Token budget:** `MAX_SUMMARY_TOKENS` (default 8000, configurable). This is
the maximum size of the summary text returned to Pi. The assembler greedily
fills from the highest-depth summaries down to this budget:

1. Start with the deepest summaries (broadest coverage).
2. Add progressively shallower summaries until budget is exhausted.
3. Always include at least the most recent D0 summary (for continuity).

**Format (STATIC structure — only content changes on compaction, not on each turn):**

```
## Conversation History (Lossless Context Management)
[stats line: N messages stored | M summaries | DAG depth D]

### High-Level Summary
[Deepest summary/summaries — broadest narrative arc]

### Recent Activity
[Most recent D0 summary — detailed recent work]

### Summary IDs for Drill-Down
[List of summary IDs the agent can use with lcm_expand]
- s-abc123 (D2): "Overall project goals and architecture decisions"
- s-def456 (D1): "Authentication module implementation"
- s-ghi789 (D0): "Recent debugging of token refresh logic"
```

**No hand-extracted "Key Decisions" or "Files Modified" sections.** These were
under-specified in v1 of the plan. Instead, the free-text summaries carry this
information naturally (the depth-aware prompts instruct the model to include
decisions and file changes). This avoids unreliable post-hoc extraction.

Return this as the `compaction.summary` to Pi.

#### Depth-Aware Prompts

| Depth | Input              | Prompt Style                          |
|-------|--------------------|---------------------------------------|
| 0     | Raw messages       | Detailed: preserve code, errors, decisions |
| 1     | D0 summaries       | Consolidate: merge themes, drop redundancy |
| 2+    | D(N-1) summaries   | Abstract: high-level narrative, key facts  |

#### Model Selection

Try in order (matching `pi-agentic-compaction` pattern):
1. `cerebras/zai-glm-4.7` (fast, cheap)
2. `anthropic/claude-haiku-4-5` (reliable fallback)
3. Session model (last resort)

### 3. Message Persistor (`src/persistor.ts`)

Hooks into `message_end` to capture every message:

```typescript
pi.on("message_end", async (event, ctx) => {
  const { message, entryId } = event;
  store.appendMessage(conversationId, entryId, message);
  updateStatusWidget(ctx);
});
```

Also hooks into `turn_end` to capture any messages that `message_end` might
miss (tool results are sometimes batched).

Token estimation uses a fast heuristic (chars / 3.5) rather than a tokenizer
dependency, matching Lossless Claw's approach.

#### `extractSearchableText(message: AgentMessage): string`

Critical function that produces the searchable plaintext from any message type:

```typescript
function extractSearchableText(message: AgentMessage): string {
  switch (message.role) {
    case "user":
      // String content or text blocks from content array
      return typeof message.content === "string"
        ? message.content
        : message.content.filter(b => b.type === "text").map(b => b.text).join("\n");

    case "assistant":
      // Text blocks + tool call names/args (not thinking — that's internal)
      const parts: string[] = [];
      for (const block of message.content) {
        if (block.type === "text") parts.push(block.text);
        if (block.type === "toolCall") {
          parts.push(`[tool: ${block.name}(${JSON.stringify(block.arguments)})]`);
        }
      }
      return parts.join("\n");

    case "toolResult":
      // Tool name + text content (skip images)
      const resultText = message.content
        .filter(b => b.type === "text").map(b => b.text).join("\n");
      return `[${message.toolName}] ${resultText}`;

    case "bashExecution":
      return `$ ${message.command}\n${message.output}`;

    case "custom":
      return typeof message.content === "string"
        ? message.content
        : message.content.filter(b => b.type === "text").map(b => b.text).join("\n");

    case "compactionSummary":
      return message.summary;

    case "branchSummary":
      return message.summary;

    default:
      return "";
  }
}
```

Idempotent insertion: uses `INSERT OR IGNORE` keyed on `entry_id` to handle
session resumption safely (Pi may replay history on resume).

### 4. Agent Tools (`src/tools/`)

All tools registered via `pi.registerTool()` with TypeBox schemas.

#### `lcm_grep` -- Search conversation history

```typescript
pi.registerTool({
  name: "lcm_grep",
  label: "LCM Search",
  description: "Search through all past conversation messages, including those that have been compacted. Supports regex and plain text search. Returns snippets with context around matches, not full messages. Use this to find specific error messages, code snippets, decisions, or any detail from earlier in the conversation.",
  promptSnippet: "Search all conversation history (including compacted)",
  promptGuidelines: getLcmGuidelines(),  // Dynamic but only updates after compaction
  parameters: Type.Object({
    query: Type.String({ description: "Search query (regex pattern or text)" }),
    mode: StringEnum(["regex", "text"] as const, { description: "Search mode", default: "text" }),
    scope: StringEnum(["messages", "summaries", "all"] as const, { description: "Where to search", default: "all" }),
    limit: Type.Optional(Type.Number({ description: "Max results", default: 20 })),
    after: Type.Optional(Type.String({ description: "Only messages after this ISO timestamp" })),
    before: Type.Optional(Type.String({ description: "Only messages before this ISO timestamp" })),
    full: Type.Optional(Type.Boolean({ description: "Return full message content instead of snippets", default: false })),
  }),
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    // FTS5 query sanitization for text mode (escape special chars)
    // Regex mode: compile with 5s timeout, catch ReDoS
    const results = params.mode === "regex"
      ? store.searchMessagesRegex(conversationId, params.query, {
          limit: params.limit ?? 20, timeout: 5000,
        })
      : store.searchMessages(conversationId, store.sanitizeFtsQuery(params.query), {
          limit: params.limit ?? 20,
          after: params.after, before: params.before,
        });

    // Return SNIPPETS (200 chars around each match) by default, full content only if requested
    const formatted = params.full
      ? formatFullResults(results)
      : formatSnippetResults(results, params.query, /* contextChars */ 200);

    return { content: [{ type: "text", text: formatted }], details: { resultCount: results.length } };
  },
});
```

**Output format** (snippet mode):
```
Found 7 results for "TypeError":

[1] msg-a3f2 (assistant, 2h ago, seq 47) [summary: s-8b2c, depth 0]
  ...called processFile() which threw TypeError: Cannot read property 'name' of undefined...

[2] msg-c921 (toolResult/bash, 2h ago, seq 48) [summary: s-8b2c, depth 0]
  ...TypeError: Cannot read property 'name' of undefined\n    at processFile (/src/utils.ts:42)...

Use lcm_expand("s-8b2c") to see the full context around these messages.
```
```

#### `lcm_describe` -- Section summaries

```typescript
pi.registerTool({
  name: "lcm_describe",
  label: "LCM Describe",
  description: "Get a high-level summary of a specific section of conversation history. Shows the DAG structure of summaries and their lineage. Use this to understand what happened in a particular time range or topic area.",
  promptSnippet: "Get summaries of conversation sections",
  parameters: Type.Object({
    section: StringEnum(["overview", "recent", "earliest", "by_id"] as const, {
      description: "Which section to describe",
    }),
    summary_id: Type.Optional(Type.String({ description: "Specific summary ID (for by_id mode)" })),
  }),
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    // Return summary text, depth, source count, children, lineage
  },
});
```

#### `lcm_expand` -- Drill into compressed nodes

```typescript
pi.registerTool({
  name: "lcm_expand",
  label: "LCM Expand",
  description: "Expand a compressed summary node to see the original messages or lower-level summaries it was created from. Use this when you need the exact details that were compressed away -- specific error messages, code snippets, or the precise sequence of events.",
  promptSnippet: "Drill into compressed summaries to recover original details",
  parameters: Type.Object({
    summary_id: Type.String({ description: "The summary ID to expand" }),
    depth: Type.Optional(Type.Number({ description: "How many levels deep to expand (default 1)", default: 1 })),
    max_tokens: Type.Optional(Type.Number({ description: "Token budget for expansion (default 4000)", default: 4000 })),
  }),
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    const summary = store.getSummary(params.summary_id);
    if (!summary) return { content: [{ type: "text", text: "Summary not found" }], isError: true };

    // HARD token cap enforced via BFS with running token counter.
    // Stops expanding when budget exhausted — never returns unbounded content.
    const maxTokens = Math.min(params.max_tokens ?? 4000, 8000); // Hard ceiling of 8K
    const expanded = expandSummary(store, summary, params.depth ?? 1, maxTokens);
    return { content: [{ type: "text", text: formatExpansion(expanded) }], details: { nodesExpanded: expanded.count } };
  },
});
```

### 5. Context Enricher (`src/context.ts`)

**CRITICAL: Prompt caching preservation.** Anthropic and OpenAI cache the
longest prefix match of system prompt + early messages. If the system prompt
changes every turn, caching is defeated and every request pays full input
token cost. Our injection must be **100% static text** — no dynamic stats,
no message counts, no timestamps.

Two hooks work together:

#### `before_agent_start` -- STATIC system prompt injection

Appends a **fixed, unchanging** preamble. This text is identical on every
turn, preserving the cached prefix:

```typescript
// STATIC — never changes between turns. Cache-safe.
const LCM_SYSTEM_PREAMBLE = `

## Lossless Context Management

This conversation uses lossless context management. Earlier messages have been
compressed into a searchable DAG but are fully recoverable. You have three tools:

- lcm_grep: Search all past messages by regex or text (including compacted ones)
- lcm_describe: Get high-level summaries of conversation sections with DAG lineage
- lcm_expand: Drill into any compressed summary to recover original messages

Do NOT assume information is lost. Always check with these tools before saying
"I don't have that information" or "I don't remember."`;

pi.on("before_agent_start", async (event, ctx) => {
  if (!hasCompactedHistory()) return;  // Don't inject if no compacted history

  return {
    systemPrompt: event.systemPrompt + LCM_SYSTEM_PREAMBLE
  };
});
```

#### Dynamic stats go in `promptGuidelines` on the tools themselves

Dynamic information (message count, DAG depth, DB size) is conveyed via
tool `promptGuidelines`, which Pi places in the system prompt's Guidelines
section. These only change after compaction events (infrequent), not every
turn. The tools are re-registered with updated guidelines only when
compaction occurs:

```typescript
function getLcmGuidelines(): string[] {
  const stats = cachedStats;  // Updated only after compaction
  return [
    `LCM has ${stats.messages} stored messages across ${stats.summaries} summaries (max depth ${stats.depth}).`,
    "Use lcm_grep when you need to find something specific from earlier.",
    "Use lcm_expand to recover exact details from compressed summaries.",
  ];
}
```

#### Dynamic stats also embedded in the compaction summary message

The compaction summary (a `CompactionSummaryMessage`) is a regular message
in Pi's context. It only changes when compaction runs — not every turn.
Stats embedded here are cache-safe because the message stays stable between
compactions:

```
## Conversation History (Lossless Context Management)
847 messages stored | 23 summaries | DAG depth 3

[summary content here]
```

#### What we NEVER do

- Never inject dynamic data into `before_agent_start` return
- Never use the `context` event to modify messages with per-turn data
- Never change the system prompt suffix between turns
- The `context` event is reserved for future proactive injection (v2),
  and if used, would only add/remove messages (not modify existing ones),
  preserving prefix stability

#### Cache impact analysis

```
Pi's system prompt (stable)           → CACHED ✓
+ LCM static preamble (stable)       → CACHED ✓
+ CompactionSummary message (stable)  → CACHED ✓ (changes only on compaction)
+ Kept messages from firstKeptEntryId → CACHED ✓ (stable between turns)
+ New user/assistant messages         → NOT CACHED (expected, these are new)
```

Only genuinely new content (latest turn's messages) is uncached. Everything
else benefits from prefix caching. This matches Pi's native caching behavior
exactly — our extension adds zero cache misses.

### 6. Admin Command (`src/commands.ts`)

```typescript
pi.registerCommand("lcm", {
  description: "Lossless Context Management stats and admin",
  handler: async (args, ctx) => {
    const subcommand = args?.split(" ")[0];
    switch (subcommand) {
      case "stats":
        // Show message count, summary count, DAG depth, DB size
        break;
      case "tree":
        // Show summary DAG as ASCII tree
        break;
      case "search":
        // Interactive search through history
        break;
      case "export":
        // Export full conversation to markdown
        break;
      case "compact":
        // Force manual compaction cycle
        break;
      default:
        // Show help
        break;
    }
  },
});
```

### 7. Status Widget (`src/status.ts`)

Shows persistent footer info:

```
LCM: 847 msgs | 23 summaries (depth 3) | 2.1 MB
```

Updated after each message and compaction via `ctx.ui.setStatus()`.

## Configuration

Settings in `~/.pi/agent/settings.json` under `lcm` key:

```json
{
  "lcm": {
    "enabled": true,
    "dbDir": "~/.pi/agent/lcm",
    "leafChunkTokens": 4000,
    "condensationThreshold": 6,
    "maxDepth": 5,
    "compactionModels": [
      { "provider": "cerebras", "id": "zai-glm-4.7" },
      { "provider": "anthropic", "id": "claude-haiku-4-5" }
    ],
    "largFileThresholdTokens": 25000,
    "debugMode": false
  }
}
```

Also supports env vars: `LCM_ENABLED`, `LCM_DB_DIR`,
`LCM_LEAF_CHUNK_TOKENS`, etc.

## File Structure

```
pi-lossless-context/
├── package.json
├── index.ts                    # Extension entry point
├── src/
│   ├── db/
│   │   ├── connection.ts       # SQLite connection management (WAL, ref-counting)
│   │   ├── schema.ts           # Table definitions + migrations
│   │   └── store.ts            # Data access layer (CRUD, search, DAG traversal)
│   ├── compaction/
│   │   ├── engine.ts           # CompactionEngine (leaf + condensed passes)
│   │   ├── prompts.ts          # Depth-aware summarization prompts
│   │   └── assembler.ts        # Assemble final summary from DAG for Pi
│   ├── tools/
│   │   ├── lcm-grep.ts         # Search tool
│   │   ├── lcm-describe.ts     # Section summary tool
│   │   └── lcm-expand.ts       # Drill-down expansion tool
│   ├── persistor.ts            # Message persistence (message_end hook)
│   ├── context.ts              # System prompt + context enrichment
│   ├── commands.ts             # /lcm admin command
│   ├── config.ts               # Configuration resolution
│   ├── status.ts               # Footer status widget
│   └── utils.ts                # Token estimation, text extraction, formatting
├── test/
│   ├── store.test.ts           # Database layer tests
│   ├── compaction.test.ts      # Compaction engine tests
│   ├── tools.test.ts           # Tool execution tests
│   └── integration.test.ts     # End-to-end with mock Pi session
└── docs/
    ├── architecture.md         # Detailed architecture + diagrams
    ├── configuration.md        # All config options
    └── tools.md                # Agent tool reference
```

## Dependencies

```json
{
  "dependencies": {
    "better-sqlite3": "^11.0.0"
  },
  "peerDependencies": {
    "@mariozechner/pi-ai": "*",
    "@mariozechner/pi-coding-agent": "*",
    "@sinclair/typebox": "*"
  },
  "devDependencies": {
    "vitest": "^3.0.0",
    "typescript": "^5.7.0",
    "@types/better-sqlite3": "^7.6.0"
  }
}
```

Why `better-sqlite3`:
- Synchronous API = simpler code, no async overhead for DB operations.
- WAL mode supports concurrent reads (tools can query while compaction runs).
- FTS5 support built-in.
- Battle-tested, widely used.
- No external services or network dependencies.

## Implementation Phases

### Phase 0: API Verification Skeleton

**Goal:** Verify all Pi extension API assumptions before writing real code.

Create a minimal skeleton extension that:
1. Hooks into every relevant event (`session_start`, `session_shutdown`,
   `message_end`, `session_before_compact`, `context`, `before_agent_start`,
   `turn_end`).
2. Logs what each event receives (event shape, field names, timing).
3. In `session_before_compact`: returns a custom summary and verifies Pi
   uses it (confirms the hook REPLACES default compaction, not supplements).
4. In `before_agent_start`: returns modified systemPrompt and verifies the
   model sees it.
5. Registers a dummy tool and verifies the LLM can call it.
6. Verifies `message_end` fires for all message types (user, assistant,
   toolResult, bashExecution).
7. Verifies idempotency: what happens on session resume (`pi -c`)?
   Does `message_end` replay old messages?

Files: `index.ts` (skeleton only, ~100 lines)
Time: ~1 hour
Output: A verified list of API behaviors that the real implementation depends on.

### Phase 1: Foundation (Core DB + Message Persistence)

**Goal:** Every message is stored in SQLite, searchable via FTS5.

Files to create:
1. `package.json` -- deps, pi extension config
2. `src/config.ts` -- config resolution (settings.json + env vars)
3. `src/utils.ts` -- token estimation, text extraction
4. `src/db/connection.ts` -- SQLite connection manager
5. `src/db/schema.ts` -- migrations
6. `src/db/store.ts` -- data access (messages only, no summaries yet)
7. `src/persistor.ts` -- message_end hook
8. `index.ts` -- extension entry point (bootstrap + persistor)

Tests (written alongside code):
- `test/store.test.ts` -- CRUD operations, FTS5 search, idempotent inserts,
  concurrent access with busy_timeout, extractSearchableText for all msg types.

Validation:
- Start Pi with `pi -e ./index.ts`, have a conversation, verify messages
  appear in SQLite.
- Run `/compact` and confirm extension logs show message count.
- Search messages via direct DB query.
- Resume session (`pi -c`) and verify no duplicate messages (idempotent insert).

### Phase 2: DAG Compaction

**Goal:** Replace default compaction with hierarchical DAG summarization.

Files to create:
1. `src/compaction/prompts.ts` -- depth-aware prompt builders
2. `src/compaction/engine.ts` -- leaf + condensed passes
3. `src/compaction/assembler.ts` -- build Pi-compatible summary from DAG
4. `src/db/store.ts` -- extend with summary CRUD + DAG traversal

Update:
1. `index.ts` -- add `session_before_compact` handler

Tests:
- `test/compaction.test.ts` -- leaf pass chunking, condensed pass cascading,
  depth transitions, assembly token budget, model fallback chain,
  parallel leaf pass, summary-sources linkage.

Also: pull `/lcm compact` command forward from Phase 4 so compaction can be
triggered manually during development without filling the context window.

Validation:
- Start Pi, fill context until auto-compaction triggers.
- Verify multiple depth-0 summaries created in SQLite.
- Force another compaction, verify condensed (depth-1) summaries appear.
- Confirm Pi's context contains the assembled DAG summary.
- Verify compaction summary is STATIC between turns (prompt cache safe).

### Phase 3: Agent Recovery Tools

**Goal:** Agent can search and drill into compressed history.

Files to create:
1. `src/tools/lcm-grep.ts`
2. `src/tools/lcm-describe.ts`
3. `src/tools/lcm-expand.ts`
4. `src/context.ts` -- system prompt injection

Update:
1. `index.ts` -- register tools + before_agent_start handler

Tests:
- `test/tools.test.ts` -- lcm_grep FTS5 sanitization, regex ReDoS timeout,
  snippet extraction, time-range filtering, lcm_expand hard token cap,
  lcm_describe overview/by_id modes, output format verification.

Validation:
- After compaction, ask the agent "what error message did I see earlier?"
- Agent should use `lcm_grep` to find it, `lcm_expand` to get full detail.
- Verify the agent can navigate the summary DAG via `lcm_describe`.
- Verify system prompt preamble is STATIC (same text every turn).

### Phase 4: Admin + Polish

**Goal:** User-facing commands, status widget, robustness.

Files to create:
1. `src/commands.ts` -- /lcm command
2. `src/status.ts` -- footer widget

Updates:
1. Error handling, edge cases (empty conversations, corrupted DB, etc.)
2. Graceful degradation if better-sqlite3 fails to load.
3. Debug mode with detailed logging.

Validation:
- `/lcm stats` shows correct counts.
- `/lcm tree` shows DAG visualization.
- Footer shows live message count.
- Extension works correctly when disabled/re-enabled.

### Phase 5: Integration Tests + Cache Verification

Tests created alongside earlier phases cover unit/component tests. This phase
adds end-to-end integration:

Files to create:
1. `test/integration.test.ts` -- full lifecycle: persist → compact → search → expand
2. `test/cache-safety.test.ts` -- verify system prompt is identical across turns,
   compaction summary message is stable between compactions, no dynamic data
   leaks into cached prefix

## Key Design Decisions

### Why SQLite, Not Session JSONL

Pi's session files are JSONL with a parentId-chain tree structure. We could
store DAG metadata as `CustomEntry` objects in the session JSONL, but:

1. **Performance**: JSONL is append-only. Searching requires reading the
   entire file. SQLite with FTS5 is orders of magnitude faster for search.
2. **Independence**: The DAG should survive session switches. A project-level
   DB means all sessions in that project share the same searchable history.
3. **Integrity**: SQLite provides ACID transactions, foreign keys, and
   indexes. JSONL can be corrupted by crashes mid-write.
4. **Cross-session recall**: If you start a new session in the same project,
   the agent can search history from previous sessions via the tools.

We still use `pi.appendEntry()` to store minimal DAG metadata in the session
(summary IDs, conversation mapping) so that session export/backup includes
pointers to the DAG.

### Why Not Replace Pi's Context Building

Lossless Claw implements a full `ContextEngine` that replaces the entire
context pipeline. Pi doesn't expose this interface -- it has event hooks.
Our approach is additive:

- Pi still manages context building (system prompt + messages from
  `firstKeptEntryId` onwards).
- We provide the compaction summary that Pi injects.
- We provide tools for the agent to pull detail on demand.
- We inject awareness into the system prompt.

This is simpler, more maintainable, and doesn't fight Pi's architecture.

### Compaction Model vs. Session Model

We use a cheap fast model (Cerebras/Haiku) for summarization, not the session
model. Reasons:

1. **Cost**: Summarizing thousands of tokens with Opus is wasteful.
2. **Speed**: Compaction should be fast -- the user is waiting.
3. **Quality**: Summarization doesn't need the smartest model. Haiku is great
   at structured extraction.

### Token Estimation Strategy

We use `Math.ceil(text.length / 3.5)` as a fast heuristic rather than
importing a tokenizer. This is what Lossless Claw does, and it's accurate
enough for chunking decisions (±15% error is fine when we're deciding where
to cut summary chunks).

## Risk Mitigations

| Risk | Mitigation |
|------|-----------|
| better-sqlite3 native module fails | Graceful fallback: disable LCM, use Pi's default compaction, notify user |
| DB corruption | WAL mode + regular checkpoints. Worst case: delete DB, lose summaries but Pi session JSONL still has the last compaction summary |
| Compaction model unavailable | Fall back to session model. Fall back to no-op (let Pi's default compaction run) |
| Extension slows down Pi | All DB writes are synchronous but fast (SQLite WAL). Compaction runs async. Tool queries have timeout. |
| Cross-session conversation mismatch | Each conversation is keyed by session ID. Strict isolation. |
| FTS5 unavailable | LIKE-based fallback search (slower but functional). Check at startup. |

## Comparison: pi-agentic-compaction vs. pi-lcm

| Feature | pi-agentic-compaction | pi-lcm |
|---------|----------------------|--------|
| Message persistence | None | SQLite (permanent) |
| Summary structure | Flat markdown | Hierarchical DAG |
| Search history | Not possible | FTS5 + regex via lcm_grep |
| Recover details | Not possible | lcm_expand drills into any node |
| Compaction depth | 1 (single pass) | Unlimited (D0→D1→D2→...) |
| Cross-session recall | No | Yes (project-level DB) |
| Large file handling | No | Deferred to v2 |
| Agent tools | No | 3 tools (grep, describe, expand) |
| Model for summarization | Configurable | Configurable with cascading fallback |
| User admin | None | /lcm command + status widget |
| Dependency | just-bash (WASM shell) | better-sqlite3 (native) |
| Prompt cache safe | N/A (uses session model) | Yes — static system prompt, stable summary message |

## Prompt Caching Guarantee

**This extension is designed to add zero cache misses to Pi's native behavior.**

Anthropic's prompt caching works on prefix stability: the system prompt and
early messages must be byte-identical between turns for the cache to hit.

Our cache-safety invariants:

1. **System prompt injection (`before_agent_start`)**: Returns the EXACT SAME
   static string every turn. No dynamic stats, timestamps, or message counts.
   The string is a const defined at module load time.

2. **Compaction summary message**: This is a `CompactionSummaryMessage` in Pi's
   context. It only changes when compaction runs (infrequent). Between
   compactions, it's byte-stable and benefits from prefix caching.

3. **`context` event**: We do NOT modify messages in this event in v1. The
   messages array passes through unchanged, preserving Pi's native caching.

4. **Tool `promptGuidelines`**: These are part of the system prompt's Guidelines
   section. They update only after compaction (when we re-register tools with
   new stats). Between compactions, they're stable.

5. **What we never do**:
   - Never inject `Date.now()` or similar into any cached prefix position
   - Never add per-turn counters or metrics to the system prompt
   - Never modify existing messages in the `context` event
   - Never change the system prompt suffix between turns

Cache flow per turn:
```
System prompt (Pi's base)            → CACHED ✓ (unchanged)
+ LCM static preamble               → CACHED ✓ (const string)
+ Tool descriptions/guidelines       → CACHED ✓ (stable between compactions)
+ CompactionSummary message          → CACHED ✓ (stable between compactions)
+ Kept messages (firstKeptEntryId→)  → CACHED ✓ (unchanged between turns)
+ Latest turn messages               → NOT CACHED (new content, expected)
```

## Appendix: Review Fixes Applied

All issues from the architecture review have been addressed:

| # | Issue | Resolution |
|---|-------|------------|
| 1 | Verify `session_before_compact` contract | Phase 0 added — skeleton verifies it replaces default compaction |
| 2 | FTS5 sync triggers missing | Added INSERT/UPDATE/DELETE triggers to schema |
| 3 | No Phase 0 | Added Phase 0: API verification skeleton |
| 4 | Tests deferred to Phase 5 | Tests merged into each phase |
| 5 | `extractSearchableText` undefined | Full implementation added to persistor section |
| 6 | No `PRAGMA busy_timeout` | Added to connection pragmas (5000ms) |
| 7 | FTS5 query sanitization | `sanitizeFtsQuery()` method added to store |
| 8 | `parent_id` vs `summary_sources` redundancy | Dropped `parent_id`, using `summary_sources` exclusively |
| 9 | `lcm_grep` returns full messages | Snippet extraction (200 chars context) with `full` opt-in |
| 10 | `lcm_expand` unbounded recursion | Hard 8K token ceiling enforced via BFS counter |
| 11 | Sequential leaf pass | Parallel with concurrency 4, Promise.allSettled |
| 12 | No time-range filtering | `after`/`before` params added to `lcm_grep` |
| 13 | Assembly token budget undefined | MAX_SUMMARY_TOKENS=8000, greedy fill from deepest |
| 14 | ReDoS risk | 5s timeout on regex execution |
| 15 | Condensation algorithm ambiguous | Precise algorithm with state transition example |
| 16 | Session resumption idempotency | INSERT OR IGNORE keyed on entry_id |
| 17 | Tool output formats unspecified | Explicit format examples for grep results |
| 18 | Dynamic system prompt defeats caching | **STATIC preamble only — no dynamic data in system prompt** |
| 19 | DB path collision | SHA-256 hash + metadata table verification |
| 20 | WAL checkpoint unspecified | Explicit checkpoint on compaction + shutdown |
| 21 | Large files under-designed | Deferred to v2 |
| 22 | Minimum message threshold | Added: skip DAG compaction if <10 messages |
| 23 | Compaction model output parsing | 2 retries + fallback model + placeholder on failure |
