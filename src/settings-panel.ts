/**
 * LCM Settings Panel — interactive TUI overlay.
 *
 * Implements Pi's Component interface: render(width) / handleInput(data) / invalidate()
 * Opened via ctx.ui.custom() with overlay: true.
 * Panel.onClose must be wired to done() by the caller.
 */

import { matchesKey, Key, truncateToWidth } from "@mariozechner/pi-tui";
import type { LcmConfig } from "./config.js";
import type { SettingsScope } from "./settings.js";
import type { LcmStats } from "./db/store.js";

// ─── ANSI helpers ──────────────────────────────────────────────────

const dim = (s: string) => `\x1b[2m${s}\x1b[22m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;
const green = (s: string) => `\x1b[32m${s}\x1b[39m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[39m`;
const red = (s: string) => `\x1b[31m${s}\x1b[39m`;

// ─── Settings items ────────────────────────────────────────────────

interface SettingRow {
  key: keyof LcmConfig;
  label: string;
  type: "boolean" | "number";
  description: string;
  min?: number;
  max?: number;
  step?: number;
}

const ROWS: SettingRow[] = [
  { key: "enabled", label: "Enabled", type: "boolean", description: "Enable lossless context management" },
  { key: "leafChunkTokens", label: "Chunk Size", type: "number", description: "Tokens per leaf chunk", min: 500, max: 16000, step: 500 },
  { key: "condensationThreshold", label: "Condense At", type: "number", description: "Summaries before condensation", min: 2, max: 20, step: 1 },
  { key: "maxDepth", label: "Max Depth", type: "number", description: "Maximum DAG depth", min: 1, max: 10, step: 1 },
  { key: "maxSummaryTokens", label: "Budget", type: "number", description: "Summary token budget", min: 1000, max: 32000, step: 1000 },
  { key: "minMessagesForCompaction", label: "Min Msgs", type: "number", description: "Min messages for DAG compaction", min: 2, max: 50, step: 1 },
  { key: "leafPassConcurrency", label: "Workers", type: "number", description: "Parallel leaf workers", min: 1, max: 8, step: 1 },
  { key: "debugMode", label: "Debug", type: "boolean", description: "Verbose logging" },
];

// Total navigable rows: ROWS.length + 1 (scope row at top)
const SCOPE_ROW = 0;
const FIRST_SETTING_ROW = 1;

// ─── Panel ─────────────────────────────────────────────────────────

export interface LcmPanelDeps {
  config: LcmConfig;
  scope: SettingsScope;
  cwd: string;
  stats: LcmStats | null;
  save: (config: LcmConfig, scope: SettingsScope, cwd: string) => void;
}

export class LcmSettingsPanel {
  /** Wire this to done() in the ctx.ui.custom callback. */
  onClose?: () => void;

  private row = 0;
  private cw?: number;
  private cl?: string[];
  private deps: LcmPanelDeps;

  constructor(deps: LcmPanelDeps) {
    this.deps = deps;
  }

  // ─── Component interface (required by Pi) ───────────────────────

  render(width: number): string[] {
    if (this.cl && this.cw === width) return this.cl;

    const w = Math.max(20, Math.min(width, 64));
    const t = (s: string) => truncateToWidth(s, w);
    const lines: string[] = [];
    const { config, stats, scope } = this.deps;
    const lw = 14; // label width

    // Header
    lines.push(t(`  ${bold("pi-lcm")} ${dim("settings")}`));
    lines.push(t(dim("  " + "\u2500".repeat(Math.min(w - 4, 40)))));

    // Stats
    if (stats) {
      lines.push(t(dim(`  ${stats.messages}m ${stats.summaries}s D${stats.maxDepth}`)));
    }
    lines.push("");

    // Scope row (index 0)
    const scopeSel = this.row === SCOPE_ROW;
    const scopePfx = scopeSel ? cyan("  > ") : "    ";
    const scopeVal = scope === "project" ? green("Project") : cyan("Global");
    const scopeHint = scopeSel ? dim(" [enter]") : "";
    lines.push(t(`${scopePfx}${"Scope".padEnd(lw)}${scopeVal}${scopeHint}`));

    lines.push(t(dim("  " + "\u2500".repeat(Math.min(w - 4, 40)))));

    // Settings rows (index 1..ROWS.length)
    for (let i = 0; i < ROWS.length; i++) {
      const s = ROWS[i]!;
      const sel = this.row === FIRST_SETTING_ROW + i;
      const pfx = sel ? cyan("  > ") : "    ";
      const label = s.label.padEnd(lw);
      const val = this.fmtVal(s, (config as any)[s.key]);
      const hint = sel ? this.hint(s) : "";
      lines.push(t(`${pfx}${label}${val}${hint}`));
      if (sel) {
        lines.push(t(`      ${dim(s.description)}`));
      }
    }

    // Footer
    lines.push("");
    lines.push(t(dim("  enter toggle  < > adjust  esc close")));

    this.cl = lines;
    this.cw = width;
    return lines;
  }

  handleInput(data: string): void {
    const totalRows = 1 + ROWS.length; // scope + settings

    // Close
    if (matchesKey(data, Key.escape)) {
      this.onClose?.();
      return;
    }

    // Navigate
    if (matchesKey(data, Key.up)) {
      this.row = this.row === 0 ? totalRows - 1 : this.row - 1;
      this.invalidate();
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.row = this.row === totalRows - 1 ? 0 : this.row + 1;
      this.invalidate();
      return;
    }

    // Enter = toggle
    if (matchesKey(data, Key.enter)) {
      if (this.row === SCOPE_ROW) {
        this.deps.scope = this.deps.scope === "project" ? "global" : "project";
        this.save();
      } else {
        const s = ROWS[this.row - FIRST_SETTING_ROW];
        if (s?.type === "boolean") {
          (this.deps.config as any)[s.key] = !(this.deps.config as any)[s.key];
          this.save();
        } else if (s?.type === "number") {
          this.adjust(s, 1);
        }
      }
      this.invalidate();
      return;
    }

    // Left/Right = adjust numbers
    if (matchesKey(data, Key.left) || matchesKey(data, Key.right)) {
      if (this.row >= FIRST_SETTING_ROW) {
        const s = ROWS[this.row - FIRST_SETTING_ROW];
        if (s?.type === "number") {
          this.adjust(s, matchesKey(data, Key.left) ? -1 : 1);
          this.invalidate();
        }
      }
      return;
    }
  }

  invalidate(): void {
    this.cw = undefined;
    this.cl = undefined;
  }

  // ─── Helpers ────────────────────────────────────────────────────

  private adjust(s: SettingRow, dir: number): void {
    const cur = (this.deps.config as any)[s.key] as number;
    const step = s.step ?? 1;
    const min = s.min ?? 0;
    const max = s.max ?? Infinity;
    (this.deps.config as any)[s.key] = Math.max(min, Math.min(max, cur + dir * step));
    this.save();
  }

  private save(): void {
    this.deps.save(this.deps.config, this.deps.scope, this.deps.cwd);
  }

  private fmtVal(s: SettingRow, v: any): string {
    if (s.type === "boolean") return v ? green("On") : red("Off");
    const n = Number(v);
    if (s.key === "leafChunkTokens" || s.key === "maxSummaryTokens") {
      return cyan(`${(n / 1000).toFixed(1)}K`);
    }
    return cyan(String(n));
  }

  private hint(s: SettingRow): string {
    if (s.type === "boolean") return dim(" [enter]");
    return dim(` [< > ${s.min}-${s.max}]`);
  }
}
