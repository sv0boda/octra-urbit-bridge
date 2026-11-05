// Compact public snapshots: [[queueId, [[emoji, count], ...]], ...].
export function reactionCounts(reacts) {
  const counts = new Map();
  for (const [ship, emoji] of Object.entries(reacts ?? {})) {
    if (!/^~[a-z-]{1,119}$/.test(ship) || typeof emoji !== 'string' || !emoji.trim()
        || new TextEncoder().encode(emoji).length > 128 || /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(emoji)) continue;
    counts.set(emoji, (counts.get(emoji) || 0) + 1);
  }
  return [...counts].sort(([a],[b])=>a < b ? -1 : a > b ? 1 : 0);
}

export function decodeReactions(value) {
  if (value === '') return new Map();
  if (typeof value !== 'string' || new TextEncoder().encode(value).length > 16000) throw new Error('Invalid reaction snapshot');
  const rows = JSON.parse(value), result = new Map();
  if (!Array.isArray(rows) || rows.length > 10000) throw new Error('Invalid reaction rows');
  for (const row of rows) {
    if (!Array.isArray(row) || row.length !== 2) throw new Error('Invalid reaction row');
    const [id, reactions] = row;
    if (!Number.isInteger(id) || id < 1 || id > 10000 || result.has(id) || !Array.isArray(reactions)) throw new Error('Invalid reaction message');
    const seen = new Set();
    for (const pair of reactions) {
      if (!Array.isArray(pair) || pair.length !== 2) throw new Error('Invalid reaction');
      const [emoji,count] = pair;
      if (!reactionCounts({'~zod':emoji}).length || seen.has(emoji) || !Number.isInteger(count) || count < 1 || count > 10000) throw new Error('Invalid reaction count');
      seen.add(emoji);
    }
    result.set(id,reactions);
  }
  return result;
}
