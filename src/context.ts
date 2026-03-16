/**
 * Context enrichment: static system prompt injection for cache safety.
 *
 * CRITICAL: The preamble is a const string. It NEVER changes between turns.
 * This preserves Anthropic/OpenAI prompt caching (prefix stability).
 */

// STATIC — defined at module load time, never changes.
export const LCM_SYSTEM_PREAMBLE = `

## Lossless Context Management

This conversation uses lossless context management. Earlier messages have been
compressed into a searchable DAG but are fully recoverable. You have three tools:

- lcm_grep: Search all past messages by regex or text (including compacted ones)
- lcm_describe: Get high-level summaries of conversation sections with DAG lineage
- lcm_expand: Drill into any compressed summary to recover original messages

Do NOT assume information is lost. Always check with these tools before saying
"I don't have that information" or "I don't remember."`;
