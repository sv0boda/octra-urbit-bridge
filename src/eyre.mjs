import {randomUUID} from 'node:crypto';
import {channel, postIdForWire} from './tlon.mjs';

// Server-side only. Never pass this object, its cookie, or ship auth to a guest.
// One short-lived Eyre channel per poke keeps failure/recovery explicit.
export class EyreTlon {
  #cookie;
  constructor({url, ship, nest, cookie, allowWrites = false, timeoutMs = 15_000, fetchImpl = fetch}) {
    const base = new URL(url);
    if (base.username || base.password || base.search || base.hash || base.pathname !== '/') throw new Error('Expected a ship origin');
    if (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(base.hostname))) throw new Error('HTTPS required outside loopback');
    if (!/^~[a-z-]+$/.test(ship)) throw new Error('Invalid gateway ship');
    if (typeof cookie !== 'string' || !new RegExp(`^urbauth-${ship}=[^;\\s]+$`).test(cookie)) throw new Error('Expected the gateway ship session cookie');
    Object.assign(this, {origin: base.origin, ship, nest: channel(nest), allowWrites, timeoutMs, fetchImpl});
    this.#cookie = cookie;
  }
  async request(path, {signal = AbortSignal.timeout(this.timeoutMs), ...options} = {}) {
    try {
      const response = await this.fetchImpl(this.origin + path, {...options, signal, redirect: 'error', headers: {Cookie: this.#cookie, ...options.headers}});
      if (!response.ok) { await response.body?.cancel(); throw new Error('HTTP failure'); }
      return response;
    } catch { throw new Error('Gateway ship request failed; check connection and authentication'); }
  }
  async history(count = 100) {
    if (!Number.isInteger(count) || count < 1 || count > 200) throw new Error('History count must be 1–200');
    const response = await this.request(`/~/scry/channels/v5/${this.nest}/posts/newest/${count}/post.json`);
    if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('Unsupported ship response');
    return response.json();
  }
  async allHistory() {
    const pages = [await this.history(200)], seen = new Set();
    for (let i = 0; pages.at(-1).older; i++) {
      if (i >= 49) throw new Error('Alpha history limit reached');
      const cursor = postIdForWire(String(pages.at(-1).older).replaceAll('.', ''));
      if (seen.has(cursor)) throw new Error('History cursor repeated');
      seen.add(cursor);
      const response = await this.request(`/~/scry/channels/v5/${this.nest}/posts/older/${cursor}/200/post.json`);
      if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('Unsupported ship response');
      pages.push(await response.json());
    }
    return pages.reverse();
  }
  async poke(action) {
    if (!this.allowWrites) throw new Error('Live posting is disabled');
    const post = action?.json?.channel?.action?.post;
    if (action?.app !== 'channels' || action.mark !== 'channel-action-2' || action.json.channel.nest !== this.nest || !post) throw new Error('Action is outside the configured channel');
    // Only accept the two message-creation shapes this adapter emits.
    if (Object.keys(action.json).join() !== 'channel' || Object.keys(action.json.channel).sort().join() !== 'action,nest' || Object.keys(action.json.channel.action).join() !== 'post') throw new Error('Unsupported channel action');
    const isPost = Object.keys(post).join() === 'add';
    const isReply = Object.keys(post).join() === 'reply' && Object.keys(post.reply).sort().join() === 'action,id' && Object.keys(post.reply.action).join() === 'add' && /^(?:0|[1-9]\d{0,2})(?:\.\d{3})*$/.test(post.reply.id);
    if (!isPost && !isReply) throw new Error('Only new posts and replies are allowed');
    const essay = isPost ? post.add : post.reply.action.add;
    if (essay?.author !== this.ship) throw new Error('Unexpected message author');
    const path = '/~/channel/octra-alpha-' + randomUUID();
    const signal = AbortSignal.timeout(this.timeoutMs);
    const put = (actions, requestSignal = signal) => this.request(path, {method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify(actions), signal:requestSignal});
    let reader;
    try {
      await put([{id:1, action:'poke', ship:this.ship.slice(1), app:action.app, mark:action.mark, json:action.json}]);
      const response = await this.request(path, {signal, headers:{Accept:'text/event-stream'}});
      if (!response.headers.get('content-type')?.includes('text/event-stream')) throw new Error('Expected Eyre event stream');
      reader = response.body.getReader();
      const decoder = new TextDecoder(); let buffer = '';
      for (;;) {
        const {done, value} = await reader.read();
        if (done) throw new Error('Eyre closed before acknowledging the post');
        buffer += decoder.decode(value, {stream:true});
        if (buffer.length > 65_536) throw new Error('Oversized Eyre event');
        for (;;) {
          const boundary = /\r?\n\r?\n/.exec(buffer); if (!boundary) break;
          const block = buffer.slice(0, boundary.index); buffer = buffer.slice(boundary.index + boundary[0].length);
          const lines = block.split(/\r?\n/);
          const id = lines.find(line => line.startsWith('id:'))?.slice(3).trim();
          const data = lines.filter(line => line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');
          if (!data) continue;
          if (!/^\d+$/.test(id ?? '') || !Number.isSafeInteger(Number(id))) throw new Error('Invalid Eyre event ID');
          const event = JSON.parse(data);
          await put([{id:2,action:'ack','event-id':Number(id)}]);
          if (event.id !== 1 || event.response !== 'poke') continue;
          if (Object.hasOwn(event,'err')) { const error = new Error('Tlon rejected the post'); error.rejected = true; throw error; }
          if (event.ok === 'ok') return;
          throw new Error('Unrecognized poke acknowledgement');
        }
      }
    } finally {
      await reader?.cancel().catch(()=>{});
      // Separate bounded cleanup even when the posting deadline has elapsed.
      await put([{id:3,action:'delete'}], AbortSignal.timeout(Math.min(this.timeoutMs, 2000))).catch(()=>{});
    }
  }
}
