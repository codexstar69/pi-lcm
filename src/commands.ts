/**
 * /lcm command: stats, tree visualization, manual compact trigger.
 */

import type { LcmStore } from "./db/store.js";
import type { LcmConfig } from "./config.js";

export interface CommandState {
  store: LcmStore | null;
  conversationId: string | null;
  config: LcmConfig;
}

export function handleLcmCommand(
  state: CommandState,
  args: string | undefined,
  ctx: any,
): void {
  const subcommand = args?.split(" ")[0] ?? "help";

  switch (subcommand) {
    case "stats":
      return showStats(state, ctx);
    case "tree":
      return showTree(state, ctx);
    case "compact":
      return triggerCompact(state, ctx);
    case "help":
    default:
      ctx.ui.notify(
        "LCM commands: /lcm stats | /lcm tree | /lcm compact | /lcm help",
        "info",
      );
  }
}

function showStats(state: CommandState, ctx: any): void {
  if (!state.store || !state.conversationId) {
    ctx.ui.notify("LCM not initialized for this session.", "warning");
    return;
  }

  const stats = state.store.getStats(state.conversationId);
  const sizeMb = (stats.dbSizeBytes / 1024 / 1024).toFixed(1);

  ctx.ui.notify(
    `LCM: ${stats.messages} messages | ${stats.summaries} summaries | ` +
      `depth ${stats.maxDepth} | ${sizeMb} MB`,
    "info",
  );
}

function showTree(state: CommandState, ctx: any): void {
  if (!state.store || !state.conversationId) {
    ctx.ui.notify("LCM not initialized for this session.", "warning");
    return;
  }

  const allSummaries = state.store.getAllSummaries(state.conversationId);
  if (allSummaries.length === 0) {
    ctx.ui.notify("LCM: No summaries yet (conversation has not been compacted)", "info");
    return;
  }

  const lines: string[] = ["LCM Summary DAG:"];
  const maxDepth = state.store.getMaxDepth(state.conversationId);

  for (let d = maxDepth; d >= 0; d--) {
    const atDepth = allSummaries.filter((s) => s.depth === d);
    const indent = "  ".repeat(maxDepth - d);
    for (const s of atDepth) {
      const preview = s.text.slice(0, 50).replace(/\n/g, " ");
      const sources = state.store.getSummarySources(s.id);
      lines.push(
        `${indent}D${d} ${s.id.slice(0, 8)} (${sources.length} src, ${s.token_estimate}tok) "${preview}..."`,
      );
    }
  }

  ctx.ui.notify(lines.join("\n"), "info");
}

function triggerCompact(state: CommandState, ctx: any): void {
  if (!state.store || !state.conversationId) {
    ctx.ui.notify("LCM not initialized for this session.", "warning");
    return;
  }

  // Fix 22: Pass callbacks for user feedback
  ctx.compact({
    onComplete: () => {
      ctx.ui.notify("LCM: Compaction completed successfully.", "success");
    },
    onError: (error: Error) => {
      ctx.ui.notify(`LCM: Compaction failed: ${error.message}`, "error");
    },
  });
}
