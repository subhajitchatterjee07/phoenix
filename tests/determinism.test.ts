import { ESLint } from "eslint";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { now, random, type StepContext } from "../src/step.js";
import { seedRunningTask } from "../testing/seed.js";
import { createTestDb } from "../testing/test-db.js";

describe("now(ctx) and random(ctx)", () => {
  let db: pg.Pool;
  let drop: () => Promise<void>;
  let taskId: number;
  const run = (): StepContext => ({ taskId, token: 0, nextStepId: 1, signal: new AbortController().signal, maxSteps: 200, db });

  beforeAll(async () => {
    ({ pool: db, drop } = await createTestDb("determinism"));
    taskId = await seedRunningTask(db, "goal");
  });
  afterAll(() => drop());

  it("read the clock and the dice once; a replay (restart) gets the same values", async () => {
    const dice = vi.spyOn(Math, "random");
    const first = run();
    const [t1, r1] = [await now(first), await random(first)];
    const replay = run(); // a new worker after a crash: same task, step ids from 1 again
    expect([await now(replay), await random(replay)]).toEqual([t1, r1]);
    expect(dice).toHaveBeenCalledTimes(1);
    dice.mockRestore();
  });
});

describe("ESLint bans non-determinism in src/workflows.ts (LLD §4.5)", () => {
  const eslint = new ESLint();
  const errors = async (code: string, filePath = "src/workflows.ts") =>
    (await eslint.lintText(code, { filePath }))[0]!.messages.filter((m) => m.ruleId?.startsWith("no-restricted"));

  it.each([
    "export const t = Date.now();",
    "export const t = new Date();",
    "export const r = Math.random();",
    "export const id = crypto.randomUUID();",
    'import { randomUUID } from "node:crypto";\nexport const id = randomUUID();',
    'export const p = fetch("https://example.com");',
  ])("fails on %s", async (code) => {
    expect((await errors(code)).length).toBeGreaterThan(0);
  });

  it("allows a time that came from a step, and allows Date.now() outside workflow code", async () => {
    expect(await errors("export const at = (ms: number) => new Date(ms);")).toEqual([]);
    expect(await errors("export const t = Date.now();", "src/worker.ts")).toEqual([]);
  });
});
