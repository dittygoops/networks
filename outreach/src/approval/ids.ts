// Short draft IDs (spec AL5): permanent, human-typeable, 'd' + rowid.
export function formatShortId(id: number): string {
  return `d${id}`;
}

// Accepts 'd7', 'D7', or bare '7' (phone ergonomics). Null for anything else.
export function parseShortId(text: string): number | null {
  const m = text.trim().match(/^[dD]?(\d+)$/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}
