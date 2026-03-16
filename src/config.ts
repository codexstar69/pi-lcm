/**
 * Configuration resolution: env vars > settings.json > defaults
 */

import { homedir } from "os";
import { join, resolve, normalize } from "path";
import { readFileSync } from "fs";

export interface LcmConfig {
  enabled: boolean;
  dbDir: string;
  leafChunkTokens: number;
  condensationThreshold: number;
  maxDepth: number;
  maxSummaryTokens: number;
  minMessagesForCompaction: number;
  leafPassConcurrency: number;
  compactionModels: { provider: string; id: string }[];
  debugMode: boolean;
}

const DEFAULTS: LcmConfig = {
  enabled: true,
  dbDir: join(homedir(), ".pi", "agent", "lcm"),
  leafChunkTokens: 4000,
  condensationThreshold: 6,
  maxDepth: 5,
  maxSummaryTokens: 8000,
  minMessagesForCompaction: 10,
  leafPassConcurrency: 4,
  compactionModels: [
    { provider: "cerebras", id: "zai-glm-4.7" },
    { provider: "anthropic", id: "claude-haiku-4-5" },
  ],
  debugMode: false,
};

function readSettingsLcm(): Partial<LcmConfig> {
  try {
    const settingsPath = join(homedir(), ".pi", "agent", "settings.json");
    const raw = readFileSync(settingsPath, "utf-8");
    const settings = JSON.parse(raw);
    return settings.lcm ?? {};
  } catch {
    return {};
  }
}

function envBool(name: string): boolean | undefined {
  const v = process.env[name];
  if (v === undefined) return undefined;
  return v === "1" || v.toLowerCase() === "true";
}

function envInt(name: string): number | undefined {
  const v = process.env[name];
  if (v === undefined) return undefined;
  const n = parseInt(v, 10);
  return isNaN(n) ? undefined : n;
}

/** Fix 14: Validate dbDir doesn't allow path traversal. */
function validateDbDir(dir: string): string {
  const resolved = resolve(normalize(dir));
  if (resolved.includes("..")) {
    throw new Error(`LCM_DB_DIR must not contain '..': ${dir}`);
  }
  return resolved;
}

export function resolveConfig(): LcmConfig {
  const file = readSettingsLcm();

  return {
    enabled: envBool("LCM_ENABLED") ?? file.enabled ?? DEFAULTS.enabled,
    dbDir: validateDbDir(process.env.LCM_DB_DIR ?? file.dbDir ?? DEFAULTS.dbDir),
    leafChunkTokens: Math.max(500, envInt("LCM_LEAF_CHUNK_TOKENS") ?? file.leafChunkTokens ?? DEFAULTS.leafChunkTokens),
    condensationThreshold: Math.max(2, envInt("LCM_CONDENSATION_THRESHOLD") ?? file.condensationThreshold ?? DEFAULTS.condensationThreshold),
    maxDepth: Math.max(1, envInt("LCM_MAX_DEPTH") ?? file.maxDepth ?? DEFAULTS.maxDepth),
    maxSummaryTokens: Math.max(500, envInt("LCM_MAX_SUMMARY_TOKENS") ?? file.maxSummaryTokens ?? DEFAULTS.maxSummaryTokens),
    minMessagesForCompaction: Math.max(2, envInt("LCM_MIN_MESSAGES") ?? file.minMessagesForCompaction ?? DEFAULTS.minMessagesForCompaction),
    leafPassConcurrency: Math.max(1, envInt("LCM_LEAF_CONCURRENCY") ?? file.leafPassConcurrency ?? DEFAULTS.leafPassConcurrency),
    compactionModels: file.compactionModels ?? DEFAULTS.compactionModels,
    debugMode: envBool("LCM_DEBUG") ?? file.debugMode ?? DEFAULTS.debugMode,
  };
}
