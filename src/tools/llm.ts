import OpenAI from "openai";
import { config } from "../config.js";

export type ChatMessage = OpenAI.Chat.ChatCompletionMessageParam;
export type LlmCall = { taskId: number; stepId: number; signal?: AbortSignal };
export type LlmReply = { content: string; tokens: number };
export type LlmSettings = { baseURL: string; apiKey: string; model: string; timeoutMs: number };

/** The same code talks to the fake LLM or OpenRouter; only the settings differ. */
export function createLlm(settings: LlmSettings) {
  const client = new OpenAI({
    baseURL: settings.baseURL,
    apiKey: settings.apiKey,
    timeout: settings.timeoutMs,
    // No hidden retries: they live in step() (LLD §4.3) where events.attempts counts them.
    maxRetries: 0,
  });

  return {
    async chat(messages: ChatMessage[], call: LlmCall): Promise<LlmReply> {
      const res = await client.chat.completions.create(
        { model: settings.model, messages },
        {
          // Lets the fake count calls per (task, step); OpenRouter ignores these headers.
          headers: { "X-Phoenix-Task": String(call.taskId), "X-Phoenix-Step": String(call.stepId) },
          // Aborted by the heartbeat when this worker is fenced: stop waiting and paying.
          ...(call.signal ? { signal: call.signal } : {}),
        },
      );
      const content = res.choices[0]?.message.content;
      if (content == null) throw new Error(`LLM reply for task ${call.taskId} step ${call.stepId} has no content`);
      return { content, tokens: res.usage?.total_tokens ?? 0 };
    },
  };
}

export const llm = createLlm({
  baseURL: config.LLM_BASE_URL,
  apiKey: config.LLM_API_KEY,
  model: config.LLM_MODEL,
  timeoutMs: config.LLM_TIMEOUT_MS,
});
