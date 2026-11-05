import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';

export class InputError extends Error {}
const fail = message => { throw new InputError(message); };
export function text(value, max, name) {
  if (typeof value !== 'string') fail(`${name} is required`);
  const clean = value.normalize('NFC').trim();
  if (!clean || [...clean].length > max || /[\u0000-\u0008\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(clean)) fail(`Invalid ${name}`);
  return clean;
}

// identity is supplied by an authenticated transport, never taken from command JSON.
export class RoomStore {
  constructor(file = ':memory:', { clock = Date.now, rateLimit = 12 } = {}) {
    this.clock = clock;
    this.rateLimit = rateLimit;
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS guests(
        account TEXT PRIMARY KEY, id TEXT UNIQUE NOT NULL, nickname TEXT NOT NULL,
        banned INTEGER NOT NULL DEFAULT 0, read_seq INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS messages(
        seq INTEGER PRIMARY KEY AUTOINCREMENT, ref TEXT UNIQUE NOT NULL,
        source TEXT NOT NULL, guest_id TEXT, nickname TEXT NOT NULL, body TEXT NOT NULL,
        reply_to INTEGER REFERENCES messages(seq), status TEXT NOT NULL,
        native_id TEXT UNIQUE, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS commands(
        account TEXT NOT NULL, client_id TEXT NOT NULL, digest TEXT NOT NULL,
        seq INTEGER NOT NULL REFERENCES messages(seq), PRIMARY KEY(account, client_id));`);
    this.db.prepare('INSERT OR IGNORE INTO settings VALUES (?,?)').run('bridge_id', randomUUID());
    this.bridgeId = this.db.prepare('SELECT value FROM settings WHERE key=?').get('bridge_id').value;
    // A process crash after the network write leaves delivery unknown. Never blindly resend.
    this.db.exec("UPDATE messages SET status='uncertain' WHERE status='sending'");
  }
  close() { this.db.close(); }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  guest(account) {
    if (typeof account !== 'string' || account.length > 200 || !account.includes(':')) fail('Authenticated account required');
    let guest = this.db.prepare('SELECT * FROM guests WHERE account=?').get(account);
    if (!guest) {
      const id = createHash('sha256').update(account).digest('hex').slice(0, 12);
      this.db.prepare('INSERT INTO guests(account,id,nickname) VALUES (?,?,?)').run(account, id, `Guest ${id.slice(0, 4)}`);
      guest = this.db.prepare('SELECT * FROM guests WHERE account=?').get(account);
    }
    if (guest.banned) fail('This guest is suspended');
    return guest;
  }
  profile(account, nickname) {
    const guest = this.guest(account);
    const clean = text(nickname, 24, 'nickname');
    if (!/^[\p{L}\p{N} _.-]+$/u.test(clean) || /^(admin|moderator|system|gateway|tlon)$/i.test(clean)) fail('Choose another nickname');
    this.db.prepare('UPDATE guests SET nickname=? WHERE id=?').run(clean, guest.id);
    return this.publicGuest(this.guest(account));
  }
  publicGuest(g) { return {id: g.id, nickname: g.nickname, readSeq: g.read_seq}; }
  ban(account, banned = true) {
    const row = this.db.prepare('SELECT id FROM guests WHERE account=?').get(account);
    if (!row) fail('Unknown guest');
    this.db.prepare('UPDATE guests SET banned=? WHERE account=?').run(banned ? 1 : 0, account);
  }
  send(account, command) {
    return this.transaction(() => {
      const guest = this.guest(account);
      const body = text(command.body, 2000, 'message');
      const clientId = text(command.clientId, 100, 'request ID');
      let replyTo = command.replyTo ?? null;
      if (replyTo !== null && (!Number.isSafeInteger(replyTo) || !this.message(replyTo))) fail('Unknown reply target');
      // Tlon has one reply level. Replying to a reply continues its root thread.
      if (replyTo !== null) replyTo = this.message(replyTo).reply_to ?? replyTo;
      const digest = createHash('sha256').update(JSON.stringify([body, replyTo])).digest('hex');
      const previous = this.db.prepare('SELECT * FROM commands WHERE account=? AND client_id=?').get(account, clientId);
      if (previous) {
        if (previous.digest !== digest) fail('Request ID was already used for another message');
        return this.message(previous.seq);
      }
      const recent = this.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE guest_id=? AND created_at>?').get(guest.id, this.clock() - 60_000).n;
      if (recent >= this.rateLimit) fail('Please wait before sending more messages');
      const result = this.db.prepare(`INSERT INTO messages(ref,source,guest_id,nickname,body,reply_to,status,created_at)
        VALUES (?,?,?,?,?,?,?,?)`).run(randomUUID(), 'octra', guest.id, guest.nickname, body, replyTo, 'queued', this.clock());
      const seq = Number(result.lastInsertRowid);
      this.db.prepare('INSERT INTO commands VALUES (?,?,?,?)').run(account, clientId, digest, seq);
      return this.message(seq);
    });
  }
  message(seq) { return this.db.prepare('SELECT * FROM messages WHERE seq=?').get(seq); }
  room(account) {
    const guest = this.guest(account);
    return {guest: this.publicGuest(guest), messages: this.db.prepare('SELECT * FROM (SELECT * FROM messages ORDER BY seq DESC LIMIT 100) ORDER BY seq').all()};
  }
  read(account, seq) {
    const guest = this.guest(account);
    if (!Number.isSafeInteger(seq) || seq < 0 || (seq && !this.message(seq))) fail('Invalid read position');
    this.db.prepare('UPDATE guests SET read_seq=MAX(read_seq,?) WHERE id=?').run(seq, guest.id);
    return this.publicGuest(this.guest(account));
  }
  nextQueued() { return this.db.prepare(`SELECT m.* FROM messages m LEFT JOIN messages p ON p.seq=m.reply_to
    WHERE m.status='queued' AND (m.reply_to IS NULL OR p.native_id IS NOT NULL) ORDER BY m.seq LIMIT 1`).get(); }
  status(seq, status) {
    if (!['sending', 'sent', 'uncertain', 'failed'].includes(status)) fail('Invalid delivery status');
    this.db.prepare('UPDATE messages SET status=? WHERE seq=?').run(status, seq);
  }
  ingest({ nativeId, author, body, sent, parentNativeId, bridgeRef }) {
    const existing = this.db.prepare('SELECT * FROM messages WHERE native_id=?').get(nativeId);
    if (existing) return existing;
    if (bridgeRef) {
      const ours = this.db.prepare('SELECT * FROM messages WHERE ref=?').get(bridgeRef);
      if (ours) {
        this.db.prepare("UPDATE messages SET status='delivered',native_id=? WHERE seq=?").run(nativeId, ours.seq);
        return this.message(ours.seq);
      }
    }
    const parent = parentNativeId ? this.db.prepare('SELECT seq FROM messages WHERE native_id=?').get(parentNativeId) : null;
    const result = this.db.prepare(`INSERT INTO messages(ref,source,nickname,body,reply_to,status,native_id,created_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(randomUUID(), 'urbit', text(author, 120, 'author'), text(body, 8000, 'message'), parent?.seq ?? null, 'delivered', nativeId, sent);
    return this.message(Number(result.lastInsertRowid));
  }
}
