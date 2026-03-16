/**
 * Footer status widget showing LCM stats.
 */

import type { LcmStore } from "./db/store.js";

export function updateStatus(
  store: LcmStore | null,
  conversationId: string | null,
  ctx: any,
): void {
  if (!store || !conversationId) {
    ctx.ui.setStatus("lcm", "");
    return;
  }

  const stats = store.getStats(conversationId);
  const sizeMb = (stats.dbSizeBytes / 1024 / 1024).toFixed(1);

  ctx.ui.setStatus(
    "lcm",
    `LCM: ${stats.messages} msgs | ${stats.summaries} summaries (D${stats.maxDepth}) | ${sizeMb} MB`,
  );
}
