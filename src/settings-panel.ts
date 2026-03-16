/**
 * LCM Settings Panel — interactive TUI overlay.
 *
 * Architecture: Follows the pi-voice VoiceSettingsPanel pattern.
 *   - Component interface: render(width) / handleInput(data) / invalidate()
 *   - Opened via ctx.ui.custom() with overlay: true
 *   - ↑↓ row navigation, ↵ toggle/edit, ←→ for number adjust, esc close
 *   - Responsive rendering with truncation
 *   - Scope switching (global/project)
 */

import { matchesKey, Key, truncateToWidth } from "@mariozechner/pi-tui";
import type { LcmConfig } from "./config.js";
import type { SettingsScope } from "./settings.js";
import type { LcmStats } from "./db/store.js";

// ─── ANSI helpers ──────────────────────────────────────────────────

const dim = (s: string) => `\x1b[2m${s}\x1b[22m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;
const green = (s: string) => `\x1b[32m${s}\x1b[39m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[39m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[39m`;
const red = (s: string) => `\x1b[31m${s}\x1b[39m`;

// ─── Settings items ────────────────────────────────────────────────

interface SettingRow {
  key: keyof LcmConfig;
  label: string;
  type: "boolean" | "number" | "string";
  description: string;
  min?: number;
  max?: number;
  step?: number;
}

const SETTINGS_ROWS: SettingRow[] = [
  { key: "enabled", label: "Enabled", type: "boolean", description: "Enable lossless context management" },
  { key: "leafChunkTokens", label: "Chunk Size", type: "number", description: "Tokens per leaf summary chunk", min: 500, max: 16000, step: 500 },
  { key: "condensationThreshold", label: "Condense At", type: "number", description: "Summaries before condensation", min: 2, max: 20, step: 1 },
  { key: "maxDepth", label: "Max Depth", type: "number", description: "Maximum DAG depth levels", min: 1, max: 10, step: 1 },
  { key: "maxSummaryTokens", label: "Summary Budget", type: "number", description: "Token budget for compaction output", min: 1000, max: 32000, step: 1000 },
  { key: "minMessagesForCompaction", label: "Min Messages", type: "number", description: "Minimum messages before DAG compaction", min: 2, max: 50, step: 1 },
  { key: "leafPassConcurrency", label: "Concurrency", type: "number", description: "Parallel leaf summarization workers", min: 1, max: 8, step: 1 },
  { key: "debugMode", label: "Debug Mode", type: "boolean", description: "Verbose logging and notifications" },
];

// ─── Panel ─────────────────────────────────────────────────────────

export interface LcmPanelDeps {
  config: LcmConfig;
  scope: SettingsScope;
  cwd: string;
  stats: LcmStats | null;
  save: (config: LcmConfig, scope: SettingsScope, cwd: string) => void;
}

export class LcmSettingsPanel {
  onClose?: () => void;

  private row = 0;
  private editing = false;
  private editBuffer = "";

  // Render cache
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(private deps: LcmPanelDeps) {}

  // ─── Component interface ────────────────────────────────────────

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

    const w = Math.max(40, Math.min(width - 2, 68));
    const t = (s: string) => truncateToWidth(s, w);

    const lines: string[] = [];
    const { config, stats, scope } = this.deps;

    // ── Header
    lines.push(t(`  ${bold("pi-lcm")} ${dim("Lossless Context Management")}`));
    lines.push(t(dim("  " + "─".repeat(Math.min(w - 4, 50)))));

    // ── Stats bar
    if (stats) {
      const sizeMb = (stats.dbSizeBytes / 1024 / 1024).toFixed(1);
      lines.push(t(`  ${dim(`${stats.messages} msgs | ${stats.summaries} summaries | D${stats.maxDepth} | ${sizeMb} MB`)}`));
    } else {
      lines.push(t(dim("  No data yet — settings will apply on next session")));
    }
    lines.push("");

    // ── Scope indicator
    const scopeRow = SETTINGS_ROWS.length;
    const isScopeSelected = this.row === scopeRow;
    const scopePrefix = isScopeSelected ? cyan("  → ") : "    ";
    const scopeValue = scope === "project"
      ? green("Project") + dim(" (this repo only)")
      : cyan("Global") + dim(" (all projects)");
    const scopeHint = isScopeSelected ? dim("  [↵ toggle]") : "";
    lines.push(t(`${scopePrefix}${"Scope".padEnd(18)}${scopeValue}${scopeHint}`));
    lines.push(t(dim("  " + "─".repeat(Math.min(w - 4, 50)))));

    // ── Settings rows
    for (let i = 0; i < SETTINGS_ROWS.length; i++) {
      const setting = SETTINGS_ROWS[i]!;
      const isSelected = this.row === i;
      const prefix = isSelected ? cyan("  → ") : "    ";
      const label = setting.label.padEnd(18);
      const value = this.formatValue(setting, config[setting.key]);
      const hint = this.getHint(setting, isSelected);

      if (this.editing && isSelected && setting.type === "string") {
        // Inline editing mode
        lines.push(t(`${prefix}${label}${this.editBuffer}${cyan("▌")}`));
      } else {
        lines.push(t(`${prefix}${label}${value}${hint}`));
      }

      // Show description for selected row
      if (isSelected) {
        lines.push(t(`      ${dim(setting.description)}`));
      }
    }

    // ── Footer
    lines.push("");
    const footer = this.editing
      ? "  type value  ↵ confirm  esc cancel"
      : "  ↵ toggle/edit  ←→ adjust numbers  ↑↓ navigate  esc close";
    lines.push(t(dim(footer)));

    this.cachedLines = lines;
    this.cachedWidth = width;
    return lines;
  }

  handleInput(data: string): void {
    // ── Editing mode (string values)
    if (this.editing) {
      if (matchesKey(data, Key.escape)) {
        this.editing = false;
        this.invalidate();
        return;
      }
      if (matchesKey(data, Key.enter)) {
        this.applyEdit();
        this.editing = false;
        this.invalidate();
        return;
      }
      if (matchesKey(data, Key.backspace)) {
        this.editBuffer = this.editBuffer.slice(0, -1);
        this.invalidate();
        return;
      }
      if (data.length === 1 && data >= " " && data <= "~") {
        this.editBuffer += data;
        this.invalidate();
        return;
      }
      return;
    }

    // ── Navigation
    if (matchesKey(data, Key.escape)) {
      this.onClose?.();
      return;
    }

    const totalRows = SETTINGS_ROWS.length + 1; // +1 for scope row

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

    // ── Enter = toggle/edit
    if (matchesKey(data, Key.enter)) {
      this.handleSelect();
      this.invalidate();
      return;
    }

    // ── Left/Right = adjust numbers
    if (matchesKey(data, Key.left) || matchesKey(data, Key.right)) {
      if (this.row < SETTINGS_ROWS.length) {
        const setting = SETTINGS_ROWS[this.row]!;
        if (setting.type === "number") {
          const direction = matchesKey(data, Key.left) ? -1 : 1;
          this.adjustNumber(setting, direction);
          this.invalidate();
        }
      }
      return;
    }
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  // ─── Actions ────────────────────────────────────────────────────

  private handleSelect(): void {
    const scopeRow = SETTINGS_ROWS.length;

    // Scope toggle
    if (this.row === scopeRow) {
      this.deps.scope = this.deps.scope === "project" ? "global" : "project";
      this.save();
      return;
    }

    const setting = SETTINGS_ROWS[this.row];
    if (!setting) return;

    if (setting.type === "boolean") {
      (this.deps.config as any)[setting.key] = !(this.deps.config as any)[setting.key];
      this.save();
    } else if (setting.type === "string") {
      this.editing = true;
      this.editBuffer = String((this.deps.config as any)[setting.key] ?? "");
    } else if (setting.type === "number") {
      // Enter on number = cycle through preset values or toggle between min/default
      const current = (this.deps.config as any)[setting.key] as number;
      const step = setting.step ?? 1;
      const max = setting.max ?? current + step;
      const min = setting.min ?? 0;
      const next = current + step;
      (this.deps.config as any)[setting.key] = next > max ? min : next;
      this.save();
    }
  }

  private adjustNumber(setting: SettingRow, direction: number): void {
    const current = (this.deps.config as any)[setting.key] as number;
    const step = setting.step ?? 1;
    const min = setting.min ?? 0;
    const max = setting.max ?? Infinity;
    const next = Math.max(min, Math.min(max, current + direction * step));
    (this.deps.config as any)[setting.key] = next;
    this.save();
  }

  private applyEdit(): void {
    const setting = SETTINGS_ROWS[this.row];
    if (!setting) return;

    if (setting.type === "string") {
      (this.deps.config as any)[setting.key] = this.editBuffer;
      this.save();
    }
  }

  private save(): void {
    this.deps.save(this.deps.config, this.deps.scope, this.deps.cwd);
  }

  // ─── Formatting ─────────────────────────────────────────────────

  private formatValue(setting: SettingRow, value: any): string {
    if (setting.type === "boolean") {
      return value ? green("On") : red("Off");
    }
    if (setting.type === "number") {
      const num = Number(value);
      if (setting.key === "leafChunkTokens" || setting.key === "maxSummaryTokens") {
        return cyan(`${(num / 1000).toFixed(1)}K tokens`);
      }
      return cyan(String(num));
    }
    return String(value ?? "");
  }

  private getHint(setting: SettingRow, isSelected: boolean): string {
    if (!isSelected) return "";
    if (setting.type === "boolean") return dim("  [↵ toggle]");
    if (setting.type === "number") return dim(`  [←→ adjust | ${setting.min}–${setting.max}]`);
    if (setting.type === "string") return dim("  [↵ edit]");
    return "";
  }
}
