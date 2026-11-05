import { createServer } from 'node:http';
import { readFileSync, mkdirSync, chmodSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { RoomStore, InputError, text } from './store.mjs';
import { Outbox } from './tlon.mjs';
import { LocalTlon } from './local-fixture.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const personas = Object.freeze({alice: 'fixture:octra-alice', bob: 'fixture:octra-bob'});

// Deliberately local-only: test personas are NOT wallet authentication.
export function createLocalServer({dbFile = ':memory:'} = {}) {
  const store = new RoomStore(dbFile);
  const tlon = new LocalTlon();
  // Persisted fixture posts are restored so restart tests can still thread replies.
  for (const m of store.db.prepare("SELECT * FROM messages WHERE native_id IS NOT NULL ORDER BY seq").all()) {
    tlon.serial = Math.max(tlon.serial, Number(m.native_id));
    const essay = {author: m.source === 'octra' ? '~nec' : m.nickname, content: [{inline: [m.body]}], sent: m.created_at,
      blob: null};
    const parent = m.reply_to ? store.message(m.reply_to) : null;
    if (parent && tlon.posts[parent.native_id]) tlon.posts[parent.native_id].seal.replies[m.native_id] = {'reply-essay': essay, seal: {id: m.native_id}};
    else tlon.posts[m.native_id] = {essay, seal: {id: m.native_id, replies: {}}};
  }
  const outbox = new Outbox(store, tlon, {ship: '~nec', nest: 'chat/~zod/octra-welcome'});
  const sessions = new Map();
  const csrf = randomBytes(24).toString('hex');
  if (!store.db.prepare('SELECT seq FROM messages LIMIT 1').get()) {
    tlon.reply('Welcome to the local alpha. Try Alice and Bob in separate browser sessions. Messages here are simulated; no live community is connected.');
    outbox.reconcile(tlon.history());
  }
  const flush = async () => {
    for (let i = 0; i < 20 && await outbox.flushOne(); i++) outbox.reconcile(tlon.history());
  };
  const server = createServer(async (req, res) => {
    const address = server.address();
    const host = `127.0.0.1:${address?.port}`;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const json = (code, body) => { res.writeHead(code, {'Content-Type': 'application/json'}); res.end(JSON.stringify(body)); };
    try {
      if (req.headers.host !== host) return json(403, {error: 'Local host required'});
      if (req.headers.origin && req.headers.origin !== `http://${host}`) return json(403, {error: 'Origin refused'});
      const url = new URL(req.url, `http://${host}`);
      if (req.method === 'GET' && url.pathname === '/') {
        const nonce = randomBytes(16).toString('base64');
        const html = readFileSync(resolve(root, 'web/index.html'), 'utf8')
          .replace('/* BOOTSTRAP */', `window.alphaBootstrap=${JSON.stringify({csrf})};`)
          .replaceAll('SCRIPT_NONCE', nonce);
        res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`);
        res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'}); return res.end(html);
      }
      if (!url.pathname.startsWith('/api/')) return json(404, {error: 'Not found'});
      let body = {};
      if (req.method === 'POST') {
        if (req.headers['x-alpha-csrf'] !== csrf) return json(403, {error: 'Reload the alpha before continuing'});
        if (!req.headers['content-type']?.startsWith('application/json')) return json(415, {error: 'JSON required'});
        let raw = ''; for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > 16_384) throw new InputError('Request too large'); }
        try { body = JSON.parse(raw); } catch { throw new InputError('Invalid JSON'); }
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new InputError('Invalid request');
      }
      const token = /(?:^|; )alpha_session=([a-f0-9]+)/.exec(req.headers.cookie ?? '')?.[1];
      const session = sessions.get(token);
      const account = session?.expires > Date.now() ? session.account : null;
      if (req.method === 'POST' && url.pathname === '/api/login') {
        if (!Object.hasOwn(personas, body.persona)) throw new InputError('Choose a local test guest');
        const next = randomBytes(32).toString('hex');
        if (token) sessions.delete(token);
        sessions.set(next, {account: personas[body.persona], expires: Date.now() + 3600_000});
        res.setHeader('Set-Cookie', `alpha_session=${next}; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600`);
        return json(200, {guest: store.publicGuest(store.guest(personas[body.persona]))});
      }
      if (!account) return json(401, {error: 'Choose a local test guest to enter'});
      if (req.method === 'GET' && url.pathname === '/api/room') return json(200, store.room(account));
      if (req.method === 'POST' && url.pathname === '/api/profile') return json(200, store.profile(account, body.nickname));
      if (req.method === 'POST' && url.pathname === '/api/messages') {
        const m = store.send(account, body); await flush(); return json(200, store.message(m.seq));
      }
      if (req.method === 'POST' && url.pathname === '/api/read') return json(200, store.read(account, body.seq));
      if (req.method === 'POST' && url.pathname === '/api/fixture-reply') {
        let parent = body.replyTo ? store.message(body.replyTo) : null;
        if (body.replyTo && !parent) throw new InputError('Unknown reply target');
        if (parent?.reply_to) parent = store.message(parent.reply_to);
        if (parent && !parent.native_id) throw new InputError('Wait for delivery before replying');
        tlon.reply(text(body.body, 2000, 'reply'), parent?.native_id); outbox.reconcile(tlon.history());
        return json(200, {ok: true});
      }
      if (req.method === 'POST' && url.pathname === '/api/logout') {
        sessions.delete(token); res.setHeader('Set-Cookie', 'alpha_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
        return json(200, {ok: true});
      }
      return json(404, {error: 'Not found'});
    } catch (error) {
      // Do not expose service URLs, credentials, message text or stack traces.
      return json(error instanceof InputError ? 400 : 500, {error: error instanceof InputError ? error.message : 'The gateway could not complete this request'});
    }
  });
  return {server, store, async close() { await new Promise(r => server.close(r)); store.close(); }};
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const privateDir = resolve(root, '.private'); mkdirSync(privateDir, {recursive: true, mode: 0o700}); chmodSync(privateDir, 0o700);
  const app = createLocalServer({dbFile: resolve(privateDir, 'alpha.sqlite')});
  const port = Number(process.env.ALPHA_PORT || 8787);
  app.server.listen(port, '127.0.0.1', () => console.log(`Local simulation: http://127.0.0.1:${app.server.address().port}`));
  let closing = false;
  const stop = async () => { if (closing) return; closing = true; await app.close(); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
