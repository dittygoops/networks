// Cheap-tier LLM prompts (D6a). The extraction prompt turns a fetched free-text
// page into candidate ontology facts; the summary prompt writes a short profile.
// Temperature 0, JSON out for extraction. No em dashes (repo style).

export const EXTRACT_SYSTEM = [
  'You extract structured facts about a specific researcher from a single web page.',
  'Return ONLY a JSON array (no prose, no code fences). Each element must be:',
  '{ "facet": "academic"|"trajectory"|"interest", "key": string, "value": string,',
  '  "confidence": number, "proposedTier": "A"|"B"|"C" }.',
  '',
  'Facet meaning (use these exact key strings; prefer them over synonyms):',
  '- academic: research_area, method, dataset, key_paper, venue, advisor, lab, collaborator, project.',
  '- trajectory: institution, company, role, location (career/affiliation history).',
  '- interest: hobby, side_project, oss_project, community, writing (personal facets).',
  'Prefer keys from that vocabulary; use the singular snake_case form.',
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

export const SELF_EXTRACT_SYSTEM = [
  'You extract facts ABOUT ADITYA (the author) from one of his own documents.',
  'Return ONLY a JSON array (no prose, no code fences). Each element:',
  '{ "facet": "academic"|"trajectory"|"interest", "key": string, "value": string,',
  '  "confidence": number, "proposedTier": "A"|"B"|"C" }.',
  '',
  'Extract only facts about ADITYA himself:',
  '- what he built or did (academic: method, dataset, project, key_paper),',
  '- what he studies or is moving toward (academic: research_area),',
  '- his background and trajectory (trajectory: role, institution, location),',
  '- his stated interests and side work (interest: hobby, side_project, oss_project).',
  'These documents are often topic notes. Do NOT extract encyclopedia facts about the',
  'topic itself (e.g. "NeRF represents scenes as radiance fields"). Only facts that',
  'describe Aditya. If the document says nothing about him, return [].',
  '',
  'value is a short first-person-free phrase (e.g. "built a Gaussian splat of a banana").',
  'proposedTier: A for professional/research work, B for personal-but-shareable, C for',
  'sensitive. If unsure, omit confidence (a default is applied).',
].join('\n');

export function buildSelfExtractUser(sourceLabel: string, text: string): string {
  return [`Document: ${sourceLabel}`, '', text.slice(0, 6000)].join('\n');
}

export const INTERSECT_SYSTEM = [
  'You find genuine overlaps between MY facts and ANOTHER person\'s facts, to seed',
  'a warm outreach email. Return ONLY a JSON array (no prose, no code fences).',
  'Each element: { "self": "s<i>", "person": "p<j>", "strength": number,',
  '  "rationale": string } referencing the indices given in the input.',
  '',
  'Strength rubric:',
  '- 0.9 to 1.0: same specific research problem, method, or artifact.',
  '- 0.7 to 0.8: same subfield plus a concrete shared element (venue, dataset, ecosystem, institution).',
  '- 0.5 to 0.6: same broad field, or a specific non-academic overlap (same city, same community).',
  '- 0.3 to 0.4: generic overlap (both do ML, both like hiking).',
  '- below 0.3: do not include.',
  '',
  'rationale is one short sentence naming the concrete shared thing. Only include',
  'real overlaps grounded in both fact lists. If none, return [].',
].join('\n');

// Build the intersection user message: both fact lists, each fact indexed.
export function buildIntersectUser(
  selfFacts: { facet: string; key: string; value: string }[],
  personFacts: { facet: string; key: string; value: string }[],
): string {
  const fmt = (prefix: string, facts: { facet: string; key: string; value: string }[]): string[] =>
    facts.map((f, i) => `${prefix}${i}: [${f.facet}/${f.key}] ${f.value}`);
  return [
    'MY facts:',
    ...fmt('s', selfFacts),
    '',
    "THE OTHER PERSON's facts:",
    ...fmt('p', personFacts),
  ].join('\n');
}
