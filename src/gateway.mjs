import {Outbox, normalizePosts} from './tlon.mjs';
import {createHash} from 'node:crypto';
import {decodeReactions} from '../shared/reactions.mjs';
import {queueInteger} from '../shared/queue-message.mjs';

export class Gateway {
  constructor({store, tlon, chain, ship, nest}) {
    Object.assign(this, {store, tlon, chain, ship, nest});
    this.outbox = new Outbox(store, tlon, {ship, nest});
    store.db.exec(`CREATE TABLE IF NOT EXISTS queue_links(
      queue_id INTEGER PRIMARY KEY, room_seq INTEGER UNIQUE NOT NULL REFERENCES messages(seq), kind INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS gateway_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
  }
  link(id) {return this.store.db.prepare('SELECT * FROM queue_links WHERE queue_id=?').get(id);}
  queueForRoom(seq) {return this.store.db.prepare('SELECT queue_id FROM queue_links WHERE room_seq=?').get(seq)?.queue_id;}
  async readQueue() {
    const head = queueInteger(await this.chain.head());
    const last = this.store.db.prepare('SELECT COALESCE(MAX(queue_id),0) AS n FROM queue_links').get().n;
    for (let id = last + 1; id <= Math.min(head, last + 100); id++) {
      const m = await this.chain.message(id);
      const parent = m.parent ? this.link(m.parent) : null;
      if (m.parent && !parent) throw new Error('Queue parent mapping missing');
      let local;
      if (m.kind === 1) {
        const account = 'devnet:' + m.author;
        // Keep arbitrary chain strings from creating misleading labels/control sequences in Tlon.
        try {this.store.profile(account, m.nickname);} catch {this.store.profile(account, 'Guest ' + m.author.slice(-6));}
        const body = m.body.replace(/[\u0000-\u0008\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '').trim() || '[empty message]';
        local = this.store.send(account, {body, clientId: `queue-${id}`, replyTo: parent?.room_seq ?? null});
        if (m.nativeId) this.store.ingest({nativeId: m.nativeId, author: this.ship, body, sent: local.created_at, bridgeRef: local.ref});
      } else {
        local = this.store.ingest({nativeId: m.nativeId, author: m.author, body: m.body, sent: Date.now(),
          parentNativeId: parent ? this.store.message(parent.room_seq).native_id : null});
      }
      this.store.db.prepare('INSERT INTO queue_links(queue_id,room_seq,kind) VALUES (?,?,?)').run(id, local.seq, m.kind);
    }
  }
  async readTlon() {
    const pages = await this.tlon.allHistory();
    for (const page of pages) this.outbox.reconcile(page);
    this.pages = pages;
  }
  async tick() {
    await this.readQueue();
    await this.readTlon();
    await this.outbox.flushOne();
    await this.readTlon();
    const outgoing = this.store.db.prepare(`SELECT l.queue_id,m.native_id FROM queue_links l JOIN messages m ON m.seq=l.room_seq
      WHERE l.kind=1 AND m.status='delivered' ORDER BY l.queue_id`).all();
    for (const m of outgoing) {
      const current = await this.chain.message(m.queue_id);
      if (current.nativeId) {
        if (current.nativeId !== m.native_id) throw new Error('Delivery acknowledgement differs from Tlon');
        continue;
      }
      await this.chain.call(`ack-${m.queue_id}`, 'ack_delivery', [m.queue_id, m.native_id]);
      return {action: 'acknowledge', queueId: m.queue_id};
    }
    const incoming = this.store.db.prepare(`SELECT m.* FROM messages m LEFT JOIN queue_links l ON l.room_seq=m.seq
      WHERE m.source='urbit' AND l.queue_id IS NULL ORDER BY m.seq`).all();
    for (const m of incoming) {
      const parent = m.reply_to ? this.queueForRoom(m.reply_to) : 0;
      if (m.reply_to && !parent) continue;
      // Public room supports text only. Trim at UTF-8 boundary to the queue limit.
      let body = m.body; while (Buffer.byteLength(body) > 2000) body = [...body].slice(0, -1).join('');
      await this.chain.call(`publish-${m.native_id}`, 'publish_tlon', [m.native_id, m.nickname, body, parent]);
      return {action: 'publish', nativeId: m.native_id};
    }
    if (this.chain.reactions) {
      const rows = this.store.db.prepare(`SELECT l.queue_id,m.native_id FROM queue_links l JOIN messages m ON m.seq=l.room_seq ORDER BY l.queue_id`).all();
      const head = rows.at(-1)?.queue_id || 0;
      let sync = JSON.parse(this.store.db.prepare("SELECT value FROM gateway_settings WHERE key='reaction_sync'").get()?.value || '{"head":0,"complete":true}');
      const save = () => this.store.db.prepare("INSERT INTO gateway_settings(key,value) VALUES ('reaction_sync',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(sync));
      // Reaction-only activity waits for a new message. Freeze that message's snapshot
      // durably so delayed confirmation/restarts cannot turn into periodic reaction writes.
      if (head > sync.head) {
        const reactions = new Map(this.pages.flatMap(page => normalizePosts(page, {ship:this.ship,bridgeId:this.store.bridgeId,includeReactions:true}))
          .map(post => [post.nativeId,post.reactions]));
        const snapshot = JSON.stringify(rows.map(row=>[row.queue_id,reactions.get(row.native_id) || []]).filter(([,reacts])=>reacts.length));
        decodeReactions(snapshot);
        sync = {head,snapshot,complete:false};save();
      }
      if (sync.complete) return {action:'idle'};
      const current = await this.chain.reactions();
      if ((current.snapshot || '[]') !== sync.snapshot) {
        const revision = queueInteger(current.revision, Number.MAX_SAFE_INTEGER);
        const digest = createHash('sha256').update(sync.snapshot).digest('hex').slice(0,24);
        await this.chain.call(`reactions-${revision+1}-${digest}`, 'sync_reactions', [revision,sync.snapshot]);
        return {action:'reactions',revision:revision+1};
      }
      sync.complete = true;save();
    }
    return {action: 'idle'};
  }
}
