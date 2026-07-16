// Cheap-tier LLM prompts (D6a). The extraction prompt turns a fetched free-text
// page into candidate ontology facts; the summary prompt writes a short profile.
// Temperature 0, JSON out for extraction. No em dashes (repo style).

const ENTITY_RULES = [
  'CRITICAL: `value` is a short canonical ENTITY, not a sentence. It is a name or',
  'term of 1 to 4 words that another person could share: a dataset ("nuScenes"), a',
  'method ("3D Gaussian Splatting"), a tool ("COLMAP"), a company ("PayPal"), a city',
  '("Phoenix"), a hobby ("chess"). Put the specific context in `detail`.',
  'ENUMERATE every distinct entity as its own fact. Do NOT summarize or combine:',
  'three cities means three location facts; two datasets means two dataset facts.',
  'Never put a whole accomplishment in `value` (wrong: "used nuScenes to measure',
  'recall"; right: value "nuScenes", detail "measured detection recall against it").',
  '',
  'Keys (exact snake_case, singular):',
  '- academic: research_area, method, dataset, tool, key_paper, venue, advisor, lab, collaborator, project.',
  '- trajectory: institution, company, role, location.',
  '- interest: hobby, side_project, oss_project, community, writing.',
].join('\n');

export const EXTRACT_SYSTEM = [
  'You extract structured facts about a specific researcher from a single web page.',
  'Return ONLY a JSON array (no prose, no code fences). Each element must be:',
  '{ "facet": "academic"|"trajectory"|"interest", "key": string, "value": string,',
  '  "detail": string, "confidence": number, "proposedTier": "A"|"B"|"C" }.',
  '',
  ENTITY_RULES,
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
  '  "detail": string, "stance": "done"|"exploring", "confidence": number, "proposedTier": "A"|"B"|"C" }.',
  '',
  'Extract only facts about ADITYA himself (what he built, studies, or is; his',
  'background; his interests). These documents are often topic notes. Do NOT extract',
  'encyclopedia facts about the topic (e.g. "NeRF represents scenes as radiance',
  'fields"). If the document says nothing about him, return [].',
  '',
  'STANCE is a strict honesty marker, judge it carefully:',
  '- "done": he ACTUALLY built, implemented, ran, shipped, or measured it (completed work).',
  '- "exploring": a research direction, gap, idea, or proposal he is considering but has',
  '  NOT built yet. Documents titled "Research Gap", "Research Proposal", "Research Path",',
  '  or that use words like "propose", "would", "planned", "idea", "gap" are exploring.',
  'When unsure, use "exploring". Never mark something "done" that he only proposed or',
  'thought about. This decides whether the email can claim he did the work.',
  '',
  ENTITY_RULES,
  '',
  'proposedTier: A for professional/research work, B for personal-but-shareable.',
  'If unsure, omit confidence (a default is applied).',
].join('\n');

export function buildSelfExtractUser(sourceLabel: string, text: string): string {
  return [`Document: ${sourceLabel}`, '', text.slice(0, 6000)].join('\n');
}

export interface DraftPromptInput {
  recipient: { name: string; affiliation?: string | null; profileSummary?: string; paperTitle?: string };
  hooks: { selfValue: string; personValue: string; selfDetail?: string; personDetail?: string; selfStance?: 'done' | 'exploring'; tier: 'A' | 'B' | 'C' }[];
  intent: string;
  senderName: string;
  senderFacts?: { text: string; stance?: 'done' | 'exploring' }[];
}

// DR3: hard style rules for the outreach draft. Casual but polite, hook-first,
// ruthlessly concise, grounded only in given facts, no send.
export const DRAFT_SYSTEM = [
  'You write a short cold outreach email from a student (Aditya) to a researcher.',
  'Return ONLY JSON: { "subject": string, "body": string }. No prose, no code fences.',
  '',
  'STRUCTURE (in this order, no greeting filler before the hook):',
  '1. Hook: open on the specific shared thing (the top hook), stated concretely.',
  '2. One line who-you-are + ONE concrete thing Aditya has done that is relevant.',
  '3. ONE clear, low-friction ask for direction/guidance in the recipient\'s area.',
  '4. Brief sign-off.',
  '',
  'STYLE (non-negotiable):',
  '- Casual but polite. Contractions are fine. No corporate stiffness.',
  '- Ruthlessly concise: body UNDER 120 words, aim 80 to 110. Cut adjectives and filler.',
  '- Address "Hi <FirstName>,". Sign "Best,\\nAditya".',
  '- BANNED: "I hope this email finds you well", "I am reaching out", "I would love to pick',
  '  your brain", "I have been following your work", empty superlatives, flattery.',
  '- No em dashes.',
  '',
  'TRUTH (critical): use at least one specific recipient fact AND one specific Aditya fact.',
  'Never invent shared history, prior contact, meetings, or papers not given.',
  'HONESTY BY STANCE, this is the most important rule:',
  '- Facts marked [done] are things Aditya actually built or ran. You MAY say he built/did them.',
  '- Facts marked [exploring] are directions/gaps he is only thinking about. You must NOT claim',
  '  he built, worked on, or did them. Phrase them honestly: "I have been digging into X",',
  '  "I have been thinking about the gap in Y", "I am hoping to explore Z". This is usually the',
  '  RIGHT framing for the ask, since he is writing to get direction on exactly that.',
  'Lead the credibility line with a [done] fact when one is relevant; frame [exploring] facts as',
  'the thing he wants guidance on. If you would have to overstate to make it impressive, understate.',
  '',
  'Subject: short, specific, lowercase-casual, no "Re:".',
].join('\n');

export function buildDraftUser(input: DraftPromptInput): string {
  const r = input.recipient;
  const hooks = input.hooks.map((h, i) =>
    `  ${i + 1}. shared: ${h.selfValue === h.personValue ? h.selfValue : `${h.selfValue} / ${h.personValue}`}` +
    (h.personDetail ? `\n     them: ${h.personDetail}` : '') +
    (h.selfDetail ? `\n     me [${h.selfStance ?? 'exploring'}]: ${h.selfDetail}` : `\n     me [${h.selfStance ?? 'exploring'}]`),
  );
  const facts = (input.senderFacts ?? []).map((f) => `  - [${f.stance ?? 'done'}] ${f.text}`);
  return [
    `Recipient: ${r.name}${r.affiliation ? ` (${r.affiliation})` : ''}`,
    r.paperTitle ? `Their paper: ${r.paperTitle}` : '',
    r.profileSummary ? `About them: ${r.profileSummary}` : '',
    '',
    'Top shared hooks (lead with #1). Each "me" fact is tagged [done] or [exploring]:',
    ...hooks,
    '',
    `Aditya's intent: ${input.intent}`,
    facts.length ? `Aditya's relevant facts ([done] = did it, [exploring] = only considering):\n${facts.join('\n')}` : '',
  ].filter(Boolean).join('\n');
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
