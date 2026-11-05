import {createServer} from 'node:http';
import {InputError} from './store.mjs';
import {reportedWalletIdentity, REPORTED_WALLET_KIND} from '../shared/guest-identity.mjs';

const METHODS = new Set(['room.get', 'profile.set', 'message.send', 'room.read']);

// Alpha defaults to the owner's selected client-reported address policy.
// This identifies guests by assertion; it does not verify wallet ownership.
export function createRelayServer({store, authenticate = reportedWalletIdentity, delivery = null, allowPosting = false}) {
  if (!store) throw new Error('A persistent room store is required');
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const reply = (status, data) => {res.writeHead(status, {'Content-Type':'application/json'});res.end(JSON.stringify(data));};
    try {
      if (req.method === 'GET' && req.url === '/health') return reply(200, {ok:true, service:'octra-tlon-alpha', protocol:1, posting:allowPosting});
      if (req.method !== 'POST' || req.url !== '/request') return reply(404, {ok:false,error:'Not found'});
      if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '')) return reply(415, {ok:false,error:'JSON required'});
      if (Number(req.headers['content-length']) > 16_384) return reply(413, {ok:false,error:'Request too large'});
      const chunks=[];let size=0;
      for await (const chunk of req) {
        size+=chunk.length;
        if (size > 16_384) return reply(413, {ok:false,error:'Request too large'});
        chunks.push(chunk);
      }
      let request;
      try {request=JSON.parse(Buffer.concat(chunks).toString('utf8'));} catch {throw new InputError('Invalid JSON');}
      if (!request || typeof request !== 'object' || Array.isArray(request) || request.app !== 'octra-tlon-alpha' || request.version !== 1 || !METHODS.has(request.method)) throw new InputError('Unsupported relay operation');
      const params=request.params ?? {};
      if (!params || typeof params !== 'object' || Array.isArray(params)) throw new InputError('Invalid parameters');
      // Only this policy selects the internal account; ignore account/ship overrides.
      const principal=await authenticate(request.auth);
      if (!principal || typeof principal.account !== 'string' || !['octra-wallet','invite',REPORTED_WALLET_KIND].includes(principal.kind)) return reply(401,{ok:false,error:'Guest identity required'});
      const account=principal.account;
      store.guest(account); // Bans also apply to reads and profile changes.
      let result;
      switch(request.method) {
        case 'room.get':
          if(delivery) await delivery.refresh();
          result=store.room(account);break;
        case 'profile.set':result=store.profile(account,params.nickname);break;
        case 'room.read':result=store.read(account,params.seq);break;
        case 'message.send': {
          if(!allowPosting || !delivery) return reply(503,{ok:false,error:'Posting is not enabled yet'});
          const message=store.send(account,params);
          await delivery.flush();result=store.message(message.seq);break;
        }
      }
      return reply(200,{ok:true,result,identityKind:principal.kind});
    } catch(error) {
      return reply(error instanceof InputError?400:503,{ok:false,error:error instanceof InputError?error.message:'Relay temporarily unavailable; retry with the same request ID'});
    }
  });
  server.requestTimeout=15_000;server.headersTimeout=10_000;server.keepAliveTimeout=5_000;
  return server;
}
