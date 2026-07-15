import { extractText, getDocumentProxy } from 'unpdf';

// Tier-1 emails live in the paper header; cap extracted characters so huge
// papers stay cheap (20k chars is roughly the first few pages).
export async function extractPdfText(pdf: Uint8Array, maxChars = 20_000): Promise<string> {
  const { text } = await extractText(await getDocumentProxy(pdf), { mergePages: true });
  return text.slice(0, maxChars);
}
