import { describe, expect, test } from 'vitest';
import { createOpenRouterClient } from '../src/llm/client.js';

// The OpenRouter client posts a temperature-0 chat completion and returns the
// message content. Injected fetch keeps this offline.

describe('createOpenRouterClient', () => {
  test('posts system+user with temperature 0 and returns message content', async () => {
    let captured: { url: string; body: any; headers: any } | null = null;
    const fakeFetch = (async (url: any, init: any) => {
      captured = { url: String(url), body: JSON.parse(init.body), headers: init.headers };
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: '[]' } }] }),
      };
    }) as unknown as typeof fetch;

    const client = createOpenRouterClient({ apiKey: 'k', model: 'test/model', fetchFn: fakeFetch });
    const out = await client.complete('SYS', 'USR');

    expect(out).toBe('[]');
    expect(captured!.url).toContain('openrouter.ai');
    expect(captured!.body.temperature).toBe(0);
    expect(captured!.body.model).toBe('test/model');
    expect(captured!.body.messages).toEqual([
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'USR' },
    ]);
    expect(captured!.headers.Authorization).toBe('Bearer k');
  });

  test('throws when the API key is missing', async () => {
    const client = createOpenRouterClient({ apiKey: '' });
    await expect(client.complete('a', 'b')).rejects.toThrow(/OPENROUTER_API_KEY/);
  });
});
