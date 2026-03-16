/**
 * pi-lcm: Lossless Context Management extension for Pi.
 *
 * Fix 6: session_switch + session_fork handlers.
 * Fix 7: closeDb() in session_start catch block.
 * Fix H1: message_end has no entryId — always pass null.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { complete } from "@mariozechner/pi-ai";
import { resolveConfig, type LcmConfig } from "./src/config.js";
import { openDb, closeDb, checkpointDb } from "./src/db/connection.js";
import { runMigrations } from "./src/db/schema.js";
import { LcmStore } from "./src/db/store.js";
import { CompactionEngine, type CompactionDeps } from "./src/compaction/engine.js";
import { persistMessage, type PersistorState } from "./src/persistor.js";
import { LCM_SYSTEM_PREAMBLE } from "./src/context.js";
import { handleLcmCommand, type CommandState } from "./src/commands.js";
import { updateStatus } from "./src/status.js";
import { createLcmGrepTool } from "./src/tools/lcm-grep.js";
import { createLcmDescribeTool } from "./src/tools/lcm-describe.js";
import { createLcmExpandTool } from "./src/tools/lcm-expand.js";
import { loadSettings, saveSettings, type SettingsScope } from "./src/settings.js";
import { LcmSettingsPanel, type LcmPanelDeps } from "./src/settings-panel.js";

export default function (pi: ExtensionAPI) {
  let config = resolveConfig();
  if (!config.enabled) return;

  // ── Shared state ────────────────────────────────────────────────

  let store: LcmStore | null = null;
  let settingsScope: SettingsScope = "global";
  let conversationId: string | null = null;
  let hasCompactedHistory = false;
  let cachedGuidelines: string[] = [];

  const getStore = () => store;
  const getConversationId = () => conversationId;
  const getGuidelines = () => cachedGuidelines;

  function updateGuidelines(): void {
    if (!store || !conversationId) { cachedGuidelines = []; return; }
    const stats = store.getStats(conversationId);
    cachedGuidelines = [
      `LCM has ${stats.messages} stored messages across ${stats.summaries} summaries (max depth ${stats.maxDepth}).`,
      "Use lcm_grep when you need to find something specific from earlier in the conversation.",
      "Use lcm_expand to recover exact details from compressed summaries.",
    ];
  }

  // Fix 6: Shared initialization logic
  function initializeSession(ctx: any): void {
    const sessionId = ctx.sessionManager.getSessionId();
    const sessionFile = ctx.sessionManager.getSessionFile?.() ?? null;
    const cwd = ctx.cwd;

    if (!sessionId || !cwd) return;

    // Reload config (may have been changed via /lcm-settings)
    config = resolveConfig();
    const loaded = loadSettings(cwd);
    settingsScope = loaded.source === "project" ? "project" : "global";

    const db = openDb(config.dbDir, cwd);
    runMigrations(db);

    store = new LcmStore(db);
    const conv = store.getOrCreateConversation(sessionId, sessionFile, cwd);
    conversationId = conv.id;

    const stats = store.getStats(conversationId);
    hasCompactedHistory = stats.summaries > 0;

    updateGuidelines();
    updateStatus(store, conversationId, ctx);

    if (config.debugMode) {
      ctx.ui.notify(`LCM: Initialized (${stats.messages} msgs, ${stats.summaries} summaries)`, "info");
    }
  }

  function resetState(): void {
    closeDb();
    store = null;
    conversationId = null;
    hasCompactedHistory = false;
    cachedGuidelines = [];
  }

  // ── Register tools ──────────────────────────────────────────────

  pi.registerTool(createLcmGrepTool(getStore, getConversationId, getGuidelines) as any);
  pi.registerTool(createLcmDescribeTool(getStore, getConversationId) as any);
  pi.registerTool(createLcmExpandTool(getStore, getConversationId) as any);

  pi.registerCommand("lcm", {
    description: "Lossless Context Management: stats, tree, compact, settings",
    handler: async (args: string | undefined, ctx: any) => {
      const sub = args?.split(" ")[0];
      if (sub === "settings") {
        await openSettingsPanel(ctx);
        return;
      }
      handleLcmCommand({ store, conversationId, config }, args, ctx);
    },
  });

  pi.registerCommand("lcm-settings", {
    description: "Open LCM settings panel",
    handler: async (_args: string | undefined, ctx: any) => {
      await openSettingsPanel(ctx);
    },
  });

  async function openSettingsPanel(ctx: any): Promise<void> {
    const loaded = loadSettings(ctx.cwd);
    settingsScope = loaded.source === "project" ? "project" : "global";

    const panelDeps: LcmPanelDeps = {
      config: { ...config },
      scope: settingsScope,
      cwd: ctx.cwd,
      stats: store && conversationId ? store.getStats(conversationId) : null,
      save: (cfg: LcmConfig, scope: SettingsScope, cwd: string) => {
        // Persist to settings.json
        const { enabled, leafChunkTokens, condensationThreshold, maxDepth,
                maxSummaryTokens, minMessagesForCompaction, leafPassConcurrency,
                debugMode } = cfg;
        saveSettings(
          { enabled, leafChunkTokens, condensationThreshold, maxDepth,
            maxSummaryTokens, minMessagesForCompaction, leafPassConcurrency, debugMode },
          scope,
          cwd,
        );
        // Update live config
        config = resolveConfig();
        settingsScope = scope;
        ctx.ui.notify("LCM: Settings saved", "success");
      },
    };

    const panel = new LcmSettingsPanel(panelDeps);

    await ctx.ui.custom(
      (width: number) => {
        return {
          render: () => panel.render(width),
          handleInput: (data: string) => panel.handleInput(data),
          invalidate: () => panel.invalidate(),
          onClose: panel.onClose,
        };
      },
      { overlay: true },
    );
  }

  // ── Session lifecycle ───────────────────────────────────────────

  pi.on("session_start", async (_event: any, ctx: any) => {
    try {
      initializeSession(ctx);
    } catch (e: any) {
      console.error("[LCM] Failed to initialize:", e.message);
      ctx.ui.notify(`LCM init failed: ${e.message}`, "warning");
      // Fix 7: Clean up connection on failure
      resetState();
    }
  });

  // Fix 6: Handle session switch (/new, /resume)
  pi.on("session_switch", async (_event: any, ctx: any) => {
    resetState();
    try {
      initializeSession(ctx);
    } catch (e: any) {
      console.error("[LCM] Re-init failed on session switch:", e.message);
      resetState();
    }
  });

  // Fix 6: Handle session fork
  pi.on("session_fork", async (_event: any, ctx: any) => {
    resetState();
    try {
      initializeSession(ctx);
    } catch (e: any) {
      console.error("[LCM] Re-init failed on session fork:", e.message);
      resetState();
    }
  });

  pi.on("session_shutdown", async (_event: any, _ctx: any) => {
    resetState();
  });

  // ── Message persistence ─────────────────────────────────────────

  pi.on("message_end", async (event: any, ctx: any) => {
    if (!store || !conversationId) return;

    // Fix H1: message_end has no entryId field — always null
    const state: PersistorState = { store, conversationId };
    persistMessage(state, event.message, null);

    const count = store.getMessageCount(conversationId);
    if (count % 10 === 0) updateStatus(store, conversationId, ctx);
  });

  // ── Custom compaction ───────────────────────────────────────────

  pi.on("session_before_compact", async (event: any, ctx: any) => {
    if (!store || !conversationId) return;

    const { preparation, signal } = event;

    // Persist branchEntries messages we may have missed (also uses content-based dedup)
    const allMessages =
      event.branchEntries
        ?.filter((e: any) => e.type === "message" && e.message)
        .map((e: any) => ({ message: e.message })) ?? [];

    for (const { message } of allMessages) {
      persistMessage({ store, conversationId }, message, null);
    }

    const engine = new CompactionEngine(store, config);

    const deps: CompactionDeps = {
      summarize: async (prompt: string, sig?: AbortSignal) => {
        return await callCompactionModel(ctx, config, prompt, sig);
      },
      notify: (message: string, type?: string) => ctx.ui.notify(message, type ?? "info"),
    };

    try {
      const summary = await engine.compact(conversationId, deps, signal);

      if (summary === null) return; // Too few messages — Pi's default handles it

      hasCompactedHistory = true;
      updateGuidelines();
      checkpointDb();
      updateStatus(store, conversationId, ctx);

      return {
        compaction: {
          summary,
          firstKeptEntryId: preparation.firstKeptEntryId,
          tokensBefore: preparation.tokensBefore,
          details: { lcm: true, stats: store.getStats(conversationId) },
        },
      };
    } catch (e: any) {
      console.error("[LCM] Compaction failed:", e.message);
      ctx.ui.notify(`LCM compaction failed: ${e.message}. Falling back to default.`, "warning");
      return;
    }
  });

  // ── System prompt injection (STATIC — cache-safe) ───────────────

  pi.on("before_agent_start", async (event: any, _ctx: any) => {
    if (!hasCompactedHistory) return;
    return { systemPrompt: event.systemPrompt + LCM_SYSTEM_PREAMBLE };
  });
}

// ── LLM call for compaction ─────────────────────────────────────

async function callCompactionModel(ctx: any, config: LcmConfig, prompt: string, signal?: AbortSignal): Promise<string> {
  for (const cfg of config.compactionModels) {
    const model = ctx.modelRegistry.find?.(cfg.provider, cfg.id)
      ?? ctx.modelRegistry.getAll().find((m: any) => m.provider === cfg.provider && m.id === cfg.id);
    if (!model) continue;

    const apiKey = await ctx.modelRegistry.getApiKey(model);
    if (!apiKey) continue;

    try {
      const response = await complete(
        model,
        {
          systemPrompt: "You are a precise conversation summarizer. Output only the summary, nothing else.",
          messages: [{ role: "user" as const, content: [{ type: "text" as const, text: prompt }], timestamp: Date.now() }],
        },
        { apiKey, signal },
      );

      const text = response.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n").trim();
      if (text.length > 0) return text;
    } catch (e: any) {
      if (signal?.aborted) throw e;
      continue;
    }
  }

  // Fall back to session model
  if (ctx.model) {
    const apiKey = await ctx.modelRegistry.getApiKey(ctx.model);
    if (apiKey) {
      const response = await complete(
        ctx.model,
        {
          systemPrompt: "You are a precise conversation summarizer. Output only the summary, nothing else.",
          messages: [{ role: "user" as const, content: [{ type: "text" as const, text: prompt }], timestamp: Date.now() }],
        },
        { apiKey, signal },
      );
      const text = response.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n").trim();
      if (text.length > 0) return text;
    }
  }

  throw new Error("No model available for compaction summarization");
}
