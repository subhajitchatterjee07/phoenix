import { z } from "zod";
import { llm as defaultLlm, type ChatMessage, type LlmCall, type LlmReply } from "./tools/llm.js";

export type Task = { taskId: number; goal: string; input: unknown };
export type TaskResult = { report: string; tokens: number };
type Llm = { chat(messages: ChatMessage[], call: LlmCall): Promise<LlmReply> };

// Phase 1: "fetch" reads the texts from the task's input. Real web fetch is phase 7.
const Input = z.object({ sources: z.array(z.string().min(1)).min(1) });

/**
 * PHASE 1, DELIBERATELY NAIVE: no step(), no events table. Every paid LLM result lives
 * only in local variables, so a crash anywhere loses all of it and a restart pays again.
 * Phase 2 (PHX-016..023) wraps each numbered step in step() to fix exactly this.
 */
export async function runTask(task: Task, llm: Llm = defaultLlm): Promise<TaskResult> {
  const call = (stepId: number) => ({ taskId: task.taskId, stepId });
  let tokens = 0;

  // Step 1: fetch
  const { sources } = Input.parse(task.input);

  // Steps 2..N+1: summarise each source
  const summaries: string[] = [];
  for (const [i, text] of sources.entries()) {
    const reply = await llm.chat(
      [
        { role: "system", content: `Summarise the text in two sentences. Focus on: ${task.goal}` },
        { role: "user", content: text },
      ],
      call(2 + i),
    );
    summaries.push(reply.content); // paid for, and kept only in memory
    tokens += reply.tokens;
  }

  // Step N+2: write the report from all summaries
  const report = await llm.chat(
    [
      { role: "system", content: `Write a short report that answers: ${task.goal}` },
      { role: "user", content: summaries.map((s, i) => `Source ${i + 1}: ${s}`).join("\n") },
    ],
    call(2 + sources.length),
  );
  tokens += report.tokens;
  return { report: report.content, tokens };
}
