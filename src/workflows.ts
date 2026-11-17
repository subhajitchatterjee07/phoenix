import { z } from "zod";
import { step, type StepContext, type StepResult } from "./step.js";
import { llm as defaultLlm, type ChatMessage, type LlmCall, type LlmReply } from "./tools/llm.js";

export type Task = { taskId: number; goal: string; input: unknown };
type Llm = { chat(messages: ChatMessage[], call: LlmCall): Promise<LlmReply> };

// Phase 1: "fetch" reads the texts from the task's input. Real web fetch is phase 7.
const Input = z.object({ sources: z.array(z.string().min(1)).min(1) });

/**
 * Every LLM call is a step(): its result is saved in `events`, so after a crash the next
 * worker replays it instead of paying again. Each fn uses only its args, so a changed input
 * is caught as NonDeterminism on replay. Step ids: 1..N = summaries, N+1 = report.
 */
export async function runTask(ctx: StepContext, task: Task, llm: Llm = defaultLlm): Promise<string> {
  const call = (stepId: number, signal: AbortSignal) => ({ taskId: task.taskId, stepId, signal });

  // Fetch: deterministic (reads the task row), so not a step
  const { sources } = Input.parse(task.input);

  // Steps 1..N: summarise each source
  const summaries: string[] = [];
  for (const text of sources) {
    const summary = await step(ctx, "llm_summarize", { goal: task.goal, text }, async (a, meta) => {
      const reply = await llm.chat(
        [
          { role: "system", content: `Summarise the text in two sentences. Focus on: ${a.goal}` },
          { role: "user", content: a.text },
        ],
        call(meta.stepId, meta.signal),
      );
      return { value: reply.content, tokens: reply.tokens };
    });
    summaries.push(valueOf(summary)); // saved in events: a restart replays it for free
  }

  // Step N+1: write the report from all summaries
  const report = await step(ctx, "write_report", { goal: task.goal, summaries }, async (a, meta) => {
    const reply = await llm.chat(
      [
        { role: "system", content: `Write a short report that answers: ${a.goal}` },
        { role: "user", content: a.summaries.map((s, i) => `Source ${i + 1}: ${s}`).join("\n") },
      ],
      call(meta.stepId, meta.signal),
    );
    return { value: reply.content, tokens: reply.tokens };
  });
  return valueOf(report);
}

/** Recorded ERROR results arrive in PHX-027; until then a failed step stops the task. */
function valueOf<T>(result: StepResult<T>): T {
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

