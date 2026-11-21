import { z } from "zod";
import { step, type StepContext, type StepResult } from "./step.js";
import { llm as defaultLlm, type ChatMessage, type LlmCall, type LlmReply } from "./tools/llm.js";

export type Task = { taskId: number; goal: string; input: unknown };
type Llm = { chat(messages: ChatMessage[], call: LlmCall): Promise<LlmReply> };

// Phase 1: "fetch" reads the texts from the task's input. Real web fetch is phase 7.
// `email` stands in for a planned send_email step until the planner exists (D-27).
const Input = z.object({
  sources: z.array(z.string().min(1)).min(1),
  email: z.object({ to: z.email(), guarantee: z.enum(["AT_LEAST_ONCE", "AT_MOST_ONCE"]) }).optional(),
});

/**
 * Every LLM call is a step(): its result is saved in `events`, so after a crash the next
 * worker replays it instead of paying again. Each fn uses only its args, so a changed input
 * is caught as NonDeterminism on replay. Step ids: 1..N = summaries, N+1 = report.
 */
export async function runTask(ctx: StepContext, task: Task, llm: Llm = defaultLlm): Promise<string> {
  const call = (stepId: number, signal: AbortSignal) => ({ taskId: task.taskId, stepId, signal });

  // Fetch: deterministic (reads the task row), so not a step
  const { sources, email } = Input.parse(task.input);

  // Steps 1..N: summarise each source
  const summaries: string[] = [];
  let summarised = 0;
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
    // Saved in events either way, so a restart replays it for free. A source that failed for
    // good is reported as missing and the task goes on (LLD §4.3: record ERROR, continue).
    summaries.push(summary.ok ? summary.value : `not available (${summary.error})`);
    if (summary.ok) summarised++;
  }
  if (summarised === 0) throw new Error(`no source could be summarised: ${summaries.join("; ")}`);

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
  if (!email) return valueOf(report);

  // Step N+2: the LLM writes the email; the outbox row is saved with the event, and the
  // dispatcher sends it. A replay finds the event and queues nothing new.
  const args = { to: email.to, brief: valueOf(report), guarantee: email.guarantee };
  const sent = await step(ctx, "send_email", args, async (a, meta) => {
    const reply = await llm.chat(
      [
        { role: "system", content: "Write a short email that delivers this brief." },
        { role: "user", content: a.brief },
      ],
      call(meta.stepId, meta.signal),
    );
    return { value: reply.content, tokens: reply.tokens };
  }, { outbox: (body) => ({ kind: "email", guarantee: args.guarantee, recipient: args.to, payload: { subject: task.goal, body } }) });
  valueOf(sent); // an email that could not be written is a deliverable that failed
  return valueOf(report);
}

/** The report is the task's result: if it failed for good, there is nothing to deliver. */
function valueOf<T>(result: StepResult<T>): T {
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

