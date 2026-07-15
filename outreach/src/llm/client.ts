// Cheap-tier LLM client (D4). Injectable interface so the pipeline is testable
// offline (tests pass a fake); the OpenRouter implementation uses `fetch`, no SDK.

export interface LLMClient {
  // Returns the raw assistant message content. Callers own parsing.
  complete(system: string, user: string): Promise<string>;
}

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_MODEL = 'deepseek/deepseek-chat';

export interface OpenRouterOptions {
  apiKey?: string;
  model?: string;
  temperature?: number;
  fetchFn?: typeof fetch;
}

// OpenRouter client. Temperature 0 by default for determinism (D4); drafts pass a
// little warmth. Reads OPENROUTER_API_KEY and MODEL_CHEAP from env when not given.
export function createOpenRouterClient(opts: OpenRouterOptions = {}): LLMClient {
  const apiKey = opts.apiKey ?? process.env.OPENROUTER_API_KEY ?? '';
  const model = opts.model ?? process.env.MODEL_CHEAP ?? DEFAULT_MODEL;
  const temperature = opts.temperature ?? 0;
  const doFetch = opts.fetchFn ?? fetch;

  return {
    async complete(system: string, user: string): Promise<string> {
      if (!apiKey) throw new Error('OPENROUTER_API_KEY is not set');
      const response = await doFetch(OPENROUTER_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          temperature,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        }),
      });
      if (!response.ok) {
        throw new Error(`OpenRouter request failed: ${response.status}`);
      }
      const data = (await response.json()) as { choices?: { message?: { content?: string } }[] };
      return data.choices?.[0]?.message?.content ?? '';
    },
  };
}
