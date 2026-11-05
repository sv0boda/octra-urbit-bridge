// AppliedML tuples are concatenated UTF-8 byte-length-prefixed fields.
// See the compiled get_message method in build/queue.disasm.
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', {fatal: true});
export const byteLength = text => encoder.encode(text).length;

export function queueInteger(value, max = 10000) {
  if (typeof value !== 'number' && typeof value !== 'string') throw new Error('Invalid queue integer');
  if (!/^(0|[1-9][0-9]*)$/.test(String(value))) throw new Error('Invalid queue integer');
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n > max) throw new Error('Queue integer exceeds limit');
  return n;
}

export function decodeQueueMessage(id, value) {
  id = queueInteger(id);
  if (!id || typeof value !== 'string' || byteLength(value) > 4096) throw new Error('Invalid queue message');
  const bytes = encoder.encode(value), fields = [];
  let offset = 0;
  while (offset < bytes.length && fields.length < 7) {
    const end = bytes.indexOf(35, offset);
    if (end < offset || end - offset > 4) throw new Error('Invalid tuple framing');
    const length = queueInteger(decoder.decode(bytes.subarray(offset, end)), 4096);
    offset = end + 1;
    if (offset + length > bytes.length) throw new Error('Truncated tuple field');
    fields.push(decoder.decode(bytes.subarray(offset, offset + length)));
    offset += length;
  }
  if (fields.length !== 7 || offset !== bytes.length) throw new Error('Invalid tuple field count');
  const [kindText, author, nickname, body, parentText, epochText, nativeId] = fields;
  const kind = queueInteger(kindText, 2), parent = queueInteger(parentText);
  const epoch = queueInteger(epochText, Number.MAX_SAFE_INTEGER);
  if (![1, 2].includes(kind) || parent >= id || !body || byteLength(body) > 2000
      || !nickname || byteLength(nickname) > (kind === 1 ? 24 : 120)
      || byteLength(nativeId) > 100
      || !(kind === 1 ? /^oct[1-9A-HJ-NP-Za-km-z]{44}$/ : /^~[a-z-]{1,119}$/).test(author)) {
    throw new Error('Invalid queue message fields');
  }
  return {id, kind, author, nickname, body, parent, epoch, nativeId,
    status: kind === 2 ? 'from-tlon' : nativeId ? 'delivered' : 'awaiting-tlon'};
}
