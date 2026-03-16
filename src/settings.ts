/**
 * Settings persistence: load/save LCM config from Pi's settings.json.
 * Follows the pi-voice pattern: project > global > defaults.
 * Atomic writes via temp file + rename.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { LcmConfig } from "./config.js";

export const SETTINGS_KEY = "lcm";

export type SettingsScope = "global" | "project";
export type ConfigSource = SettingsScope | "default";

export interface LoadedConfig {
  config: Partial<LcmConfig>;
  source: ConfigSource;
  globalPath: string;
  projectPath: string;
}

function readJsonFile(filePath: string): Record<string, unknown> {
  try {
    if (!fs.existsSync(filePath)) return {};
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return {};
  }
}

export function getGlobalSettingsPath(): string {
  return path.join(os.homedir(), ".pi", "agent", "settings.json");
}

export function getProjectSettingsPath(cwd: string): string {
  return path.join(cwd, ".pi", "settings.json");
}

export function loadSettings(cwd: string): LoadedConfig {
  const globalPath = getGlobalSettingsPath();
  const projectPath = getProjectSettingsPath(cwd);

  const projectRaw = readJsonFile(projectPath)[SETTINGS_KEY];
  if (projectRaw && typeof projectRaw === "object") {
    return { config: projectRaw as Partial<LcmConfig>, source: "project", globalPath, projectPath };
  }

  const globalRaw = readJsonFile(globalPath)[SETTINGS_KEY];
  if (globalRaw && typeof globalRaw === "object") {
    return { config: globalRaw as Partial<LcmConfig>, source: "global", globalPath, projectPath };
  }

  return { config: {}, source: "default", globalPath, projectPath };
}

export function saveSettings(
  config: Partial<LcmConfig>,
  scope: SettingsScope,
  cwd: string,
): string {
  const settingsPath = scope === "project"
    ? getProjectSettingsPath(cwd)
    : getGlobalSettingsPath();

  const settings = readJsonFile(settingsPath);
  settings[SETTINGS_KEY] = config;

  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });

  // Atomic write: temp + rename prevents corruption
  const tmpPath = `${settingsPath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(settings, null, 2) + "\n");
    fs.renameSync(tmpPath, settingsPath);
  } finally {
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch {}
  }

  return settingsPath;
}
