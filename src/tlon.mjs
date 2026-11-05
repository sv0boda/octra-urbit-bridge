// Wire shapes verified against tloncorp/tlon-apps feee8da552faf55cbf5f94b058925faa92488eb1.
import { InputError } from './store.mjs';
import {reactionCounts} from '../shared/reactions.mjs';

export function channel(value) {
  if (typeof value !== 'string' || !/^chat\/~[a-z-]+\/[a-z0-9-]+$/.test(value)) throw new InputError('Expected a Tlon chat channel identifier');
  return value;
}
export function postIdForWire(value) {
  if (typeof value !== 'string' || !/^\d{1,64}$/.test(value)) throw new InputError('Invalid internal post ID');
  // Tlon expects canonical @ud text; IDs exceed JavaScript's safe integer range.
  return BigInt(value).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}
export function postAction(message, { ship, nest, bridgeId, parent }) {
  channel(nest);
  if (!/^~[a-z-]+$/.test(ship)) throw new InputError('Invalid gateway ship');
  if (message.reply_to && !parent?.native_id) throw new InputError('Wait for the original message to reach Tlon before replying');
  const label = `${message.nickname} · ${message.guest_id.slice(0, 6)} — Octra guest`;
  const essay = {
    author: ship,
    content: [{inline: [`${label}\n${message.body}`]}],
    sent: message.created_at,
    blob: JSON.stringify({type: 'octra-tlon-alpha', bridgeId, ref: message.ref})
  };
  // Text attribution is the compatibility baseline; no global profile changes.
  const action = parent
    ? {post: {reply: {id: postIdForWire(parent.native_id), action: {add: essay}}}}
    : {post: {add: {...essay, kind: '/chat', meta: null}}};
  return {app: 'channels', mark: 'channel-action-2', json: {channel: {nest, action}}};
}

function plain(content) {
  const inline = value => typeof value === 'string' ? value
    : value && typeof value === 'object' && 'break' in value ? '\n'
    : value && typeof value === 'object' && 'ship' in value ? String(value.ship)
    : '[rich content]';
  return (Array.isArray(content) ? content : []).map(v => Array.isArray(v.inline) ? v.inline.map(inline).join('') : '[attachment]').join('\n').trim();
}
export function normalizePosts(payload, {ship, bridgeId, includeReactions = false}) {
  if (!payload || typeof payload.posts !== 'object' || !payload.posts) throw new InputError('Unsupported Tlon history response');
  const output = [];
  const add = (id, essay, parentNativeId = null, reacts = {}) => {
    if (!essay || !essay.author || !Number.isFinite(essay.sent)) return;
    const author = typeof essay.author === 'string' ? essay.author : essay.author.ship;
    if (typeof author !== 'string' || !/^~[a-z-]+$/.test(author)) return;
    let bridgeRef;
    if (author === ship && typeof essay.blob === 'string') {
      try { const b = JSON.parse(essay.blob); if (b.type === 'octra-tlon-alpha' && b.bridgeId === bridgeId) bridgeRef = b.ref; } catch {}
    }
    output.push({nativeId: String(id).replaceAll('.', ''), author, body: plain(essay.content) || '[empty message]', sent: essay.sent, parentNativeId, bridgeRef,
      ...(includeReactions ? {reactions: reactionCounts(reacts)} : {})});
  };
  for (const [key, post] of Object.entries(payload.posts)) {
    if (!post?.essay) continue;
    const id = String(post.seal?.id ?? key).replaceAll('.', '');
    add(id, post.essay, null, post.seal?.reacts);
    for (const [replyId, reply] of Object.entries(post.seal?.replies ?? {})) add(reply.seal?.id ?? replyId, reply['reply-essay'], id, reply.seal?.reacts);
  }
  // Parents must be ingested before replies, even if sender clocks disagree.
  return output;
}

export class Outbox {
  constructor(store, adapter, config) { Object.assign(this, {store, adapter, config}); this.busy = false; }
  async flushOne() {
    if (this.busy) return false;
    this.busy = true;
    let m;
    try {
      m = this.store.nextQueued();
      if (!m) return false;
      const parent = m.reply_to ? this.store.message(m.reply_to) : undefined;
      if (parent && !parent.native_id) return false;
      const action = postAction(m, {...this.config, bridgeId: this.store.bridgeId, parent});
      this.store.status(m.seq, 'sending');
      await this.adapter.poke(action);
      // An acknowledged poke is not yet a confirmed channel post.
      if (this.store.message(m.seq).status === 'sending') this.store.status(m.seq, 'sent');
      return true;
    } catch (error) {
      if (m && this.store.message(m.seq).status === 'sending') this.store.status(m.seq, error.rejected ? 'failed' : 'uncertain');
      throw error;
    } finally { this.busy = false; }
  }
  reconcile(payload) {
    for (const p of normalizePosts(payload, {...this.config, bridgeId: this.store.bridgeId})) this.store.ingest(p);
  }
}
