import { tavily } from '@tavily/core';
import type { PageFetcher, SearchClient, WebPage } from '../pipeline/contacts.js';

// Thin adapter: everything testable lives behind SearchClient/PageFetcher in
// contacts.ts. Search returns ranked result snippets; extract pulls full page
// text (where emails actually live).
export function createTavilyClient(apiKey: string, maxResults = 6): SearchClient & PageFetcher {
  const client = tavily({ apiKey });
  return {
    async search(query: string): Promise<WebPage[]> {
      const response = await client.search(query, { maxResults });
      return response.results.map((r) => ({ url: r.url, title: r.title, content: r.content }));
    },
    async fetch(urls: string[]): Promise<WebPage[]> {
      if (urls.length === 0) return [];
      const response = await client.extract(urls, {});
      return response.results.map((r) => ({
        url: r.url,
        title: '',
        content: (r as { rawContent?: string }).rawContent ?? '',
      }));
    },
  };
}
