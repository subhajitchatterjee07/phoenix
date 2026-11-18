import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const DATABASE_URL = "postgres://u:p@localhost:5432/db";

describe("loadConfig", () => {
  it("uses the LLD §9 defaults when only DATABASE_URL is set", () => {
    const c = loadConfig({ DATABASE_URL });
    expect(c.LEASE_SECONDS).toBe(30);
    expect(c.POLL_JITTER_MS).toBe(1_000);
    expect(c.MCP_ALLOWLIST["phoenix-tools"]).toContain("calculate");
  });

  it("turns env strings into numbers and JSON", () => {
    const c = loadConfig({ DATABASE_URL, LEASE_SECONDS: "45", MCP_ALLOWLIST: '{"x":["t"]}' });
    expect(c.LEASE_SECONDS).toBe(45);
    expect(c.MCP_ALLOWLIST).toEqual({ x: ["t"] });
  });

  it.each([
    ["DATABASE_URL", {}],
    ["LEASE_SECONDS", { DATABASE_URL, LEASE_SECONDS: "abc" }],
    ["HEARTBEAT_MS", { DATABASE_URL, HEARTBEAT_MS: "0" }],
    ["MCP_ALLOWLIST", { DATABASE_URL, MCP_ALLOWLIST: "not json" }],
    ["CRASH_AT", { DATABASE_URL, CRASH_AT: "after_outbox_comit" }], // a typo must not silently never fire
  ])("fails at boot naming %s", (name, env) => {
    expect(() => loadConfig(env)).toThrow(name);
  });

  it("accepts a known failpoint and treats an empty CRASH_AT as unset", () => {
    expect(loadConfig({ DATABASE_URL, CRASH_AT: "after_outbox_commit" }).CRASH_AT).toBe("after_outbox_commit");
    expect(loadConfig({ DATABASE_URL, CRASH_AT: "" }).CRASH_AT).toBeUndefined();
  });

  it("is read-only", () => {
    const c = loadConfig({ DATABASE_URL }) as { LEASE_SECONDS: number };
    expect(() => { c.LEASE_SECONDS = 1; }).toThrow(TypeError);
  });
});
