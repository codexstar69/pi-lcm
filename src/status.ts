/**
 * Footer status widget showing LCM stats.
 * Keep it SHORT — Pi crashes if status text exceeds terminal width.
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

  try {
    const stats = store.getStats(conversationId);
    // Keep under 20 chars to be safe on narrow terminals
    ctx.ui.setStatus("lcm", `${stats.messages}m ${stats.summaries}s`);
  } catch {
    ctx.ui.setStatus("lcm", "");
  }
}
