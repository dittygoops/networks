import { tavily } from '@tavily/core';
import type { SearchClient, WebPage } from '../pipeline/contacts.js';

// Thin adapter: everything testable lives behind SearchClient in contacts.ts.
export function createTavilyClient(apiKey: string, maxResults = 5): SearchClient {
  const client = tavily({ apiKey });
  return {
    async search(query: string): Promise<WebPage[]> {
      const response = await client.search(query, { maxResults });
      return response.results.map((r) => ({ url: r.url, title: r.title, content: r.content }));
    },
  };
}
