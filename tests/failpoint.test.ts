import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

// A real child process: the only way to see that a failpoint dies like kill -9. Plain node
// with tsx as a loader: the tsx CLI runs code in a grandchild, which would hide the signal.
const run = (crashAt: string) =>
  spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", `
    import { failpoint } from "./src/failpoint.ts";
    process.on("exit", () => console.log("exit handler ran"));
    try { failpoint("after_outbox_commit"); console.log("survived"); } finally { console.log("finally ran"); }`],
  { env: { ...process.env, CRASH_AT: crashAt }, encoding: "utf8", timeout: 20_000 });

it("dies by SIGKILL at the named point: nothing after it runs, not even finally or exit handlers", () => {
  const child = run("after_outbox_commit");
  expect(child.signal).toBe("SIGKILL");
  expect(child.stdout).toBe("");
  expect(child.stderr).toContain("failpoint after_outbox_commit: SIGKILL");
});

it("does nothing at any other point", () => {
  const child = run("after_send_before_sent");
  expect(child.status).toBe(0);
  expect(child.stdout).toBe("survived\nfinally ran\nexit handler ran\n");
});
