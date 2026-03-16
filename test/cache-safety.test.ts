import { describe, it, expect } from "vitest";
import { LCM_SYSTEM_PREAMBLE } from "../src/context.js";

describe("Prompt cache safety", () => {
  it("system preamble is a static constant", () => {
    // The preamble must be identical across invocations
    const first = LCM_SYSTEM_PREAMBLE;
    const second = LCM_SYSTEM_PREAMBLE;
    expect(first).toBe(second);
    expect(typeof first).toBe("string");
  });

  it("system preamble contains no dynamic values", () => {
    // Must not contain Date, timestamp, count, or any placeholder patterns
    expect(LCM_SYSTEM_PREAMBLE).not.toMatch(/\$\{/); // No template literals
    expect(LCM_SYSTEM_PREAMBLE).not.toMatch(/Date\./);
    expect(LCM_SYSTEM_PREAMBLE).not.toMatch(/\d+ messages/); // No dynamic counts
    expect(LCM_SYSTEM_PREAMBLE).not.toMatch(/\d+ summaries/);
  });

  it("system preamble mentions all three tools", () => {
    expect(LCM_SYSTEM_PREAMBLE).toContain("lcm_grep");
    expect(LCM_SYSTEM_PREAMBLE).toContain("lcm_describe");
    expect(LCM_SYSTEM_PREAMBLE).toContain("lcm_expand");
  });

  it("system preamble instructs against 'I don't remember'", () => {
    expect(LCM_SYSTEM_PREAMBLE).toContain("Do NOT assume information is lost");
  });
});
