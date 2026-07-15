// Cheap-tier LLM prompts (D6a). The extraction prompt turns a fetched free-text
// page into candidate ontology facts; the summary prompt writes a short profile.
// Temperature 0, JSON out for extraction. No em dashes (repo style).

export const EXTRACT_SYSTEM = [
  'You extract structured facts about a specific researcher from a single web page.',
  'Return ONLY a JSON array (no prose, no code fences). Each element must be:',
  '{ "facet": "academic"|"trajectory"|"interest", "key": string, "value": string,',
  '  "confidence": number, "proposedTier": "A"|"B"|"C" }.',
  '',
  'Facet meaning:',
  '- academic: research area, method, dataset, key_paper, venue, advisor, lab.',
  '- trajectory: institution, company, role, location (career/affiliation history).',
  '- interest: hobby, side_project, oss_project, community, writing (personal facets).',
  'Prefer keys from that vocabulary.',
  '',
  'Confidence rubric (D6a):',
  '- 0.8: explicit first-person statement on the person\'s own page.',
  '- 0.6: stated on a corroborated third-party page.',
  '- below 0.5: inferred or uncertain.',
  '',
  'proposedTier is your view of usability (A institutional/professional, B',
  'professional-adjacent personal, C dig-only social/archived); code may lower it.',
  'Only include facts that are clearly about THIS person. If none, return [].',
].join('\n');

// Build the extraction user message for one page.
export function buildExtractUser(personName: string, page: { url: string; title: string; content: string }): string {
  const content = page.content.slice(0, 6000);
  return [
    `Person: ${personName}`,
    `Page URL: ${page.url}`,
    `Page title: ${page.title}`,
    '',
    'Page content:',
    content,
  ].join('\n');
}

export const SUMMARY_SYSTEM = [
  'You write a concise, factual 2 to 4 sentence profile summary of a researcher',
  'from a list of known facts. Plain text only, no lists, no speculation beyond',
  'the facts given. Do not invent details. No em dashes.',
].join('\n');

// Build the summary user message from the collected facts.
export function buildSummaryUser(
  personName: string,
  facts: { facet: string; key: string; value: string }[],
): string {
  const lines = facts.map((f) => `- [${f.facet}/${f.key}] ${f.value}`);
  return [`Person: ${personName}`, '', 'Known facts:', ...lines].join('\n');
}
