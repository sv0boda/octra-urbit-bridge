import {reportedWalletReader} from './circle-transport.mjs';
import {byteLength, queueInteger, decodeQueueMessage} from '../shared/queue-message.mjs';
import {decodeReactions} from '../shared/reactions.mjs';

// The wallet host binds every call/view to the currently opened Circle.
// This adapter supplies no RPC, relayer URL, ship credentials or target override.
export function queueTransport({bridge, visibleAfter = 0, spacing = 500, now = Date.now, wait = ms => new Promise(resolve => setTimeout(resolve, ms))}) {
  visibleAfter = queueInteger(visibleAfter);
  if (!bridge || typeof bridge.request !== 'function') throw new Error('Open this app inside an Octra Circle');
  const wallet = reportedWalletReader(bridge);
  let reads = Promise.resolve();
  let blockedUntil = 0, backoff = 30000, nextRead = 0, nickname;
  const messagesById = new Map();
  const limited = () => Object.assign(new Error('Devnet is rate limited. Checking again shortly; no message will be resent.'), {code:'RATE_LIMITED'});
  const guard = () => {if(now() < blockedUntil)throw limited();};
  const rateLimit = error => {
    if(!/\b429\b|too many requests|rate.?limit/i.test(error.message))return error;
    if(now() >= blockedUntil){blockedUntil=now()+backoff;backoff=Math.min(backoff*2,120000);}
    return limited();
  };
  const performView = async (method, params = []) => {
    guard();
    for(let attempt=0;;attempt++){
      try{
        const delay=nextRead-now();if(delay>0)await wait(delay);
        guard();nextRead=now()+spacing;
        const response = await bridge.request('program.view', {method, params});
        if (!response || !Object.hasOwn(response, 'result')) throw new Error('Invalid Circle view response');
        return response.result;
      }catch(error){
        error = rateLimit(error);
        if(attempt>=4 || !/circle view busy/i.test(error.message))throw error;
        await wait(250 * 2 ** attempt);
      }
    }
  };
  const view = (method, params = []) => {
    const next = reads.then(() => performView(method, params));
    reads = next.catch(() => {});
    return next;
  };
  const message = async id => {
    const cached=messagesById.get(id);
    if(cached && cached.status !== 'awaiting-tlon')return cached;
    const result=decodeQueueMessage(id,await view('get_message',[id]));
    messagesById.set(id,result);return result;
  };
  let sending = false;
  return {
    async head(){return queueInteger(await view('get_head'));},
    async check(requestId) {
      guard();
      const {address} = await wallet();
      const id = queueInteger(await view('get_request', [address, requestId]));
      return id ? message(id) : null;
    },
    async message(id) {return message(id);},
    async read({after, limit = 50, progress = () => {}} = {}) {
      guard();
      progress('Allow wallet address access (1 of 2)…');
      const {address} = await wallet();
      progress('Wallet connected. Allow room data access (2 of 2)…');
      limit = queueInteger(limit, 100);
      const head = queueInteger(await view('get_head'));
      after = after === undefined ? Math.max(0, head - limit) : queueInteger(after);
      after = Math.max(after, visibleAfter);
      progress('Access granted. Loading the conversation…');
      nickname ??= await view('get_nickname', [address]);
      if (typeof nickname !== 'string' || byteLength(nickname) > 24) throw new Error('Invalid nickname response');
      const messages = [];
      const reactions = decodeReactions(await view('get_reactions'));
      // Devnet serializes views per Circle. Concurrent reads return "circle view busy".
      for (let id = after + 1; id <= Math.min(head, after + limit); id++) {
        messages.push({...await message(id),reactions:reactions.get(id) || []});
      }
      for(const id of messagesById.keys())if(id<=after || id>after+limit)messagesById.delete(id);
      backoff=30000;
      return {address, nickname, head, messages};
    },
    async send({body, nickname, parent = 0, requestId}, progress = () => {}) {
      guard();
      if (sending) throw new Error('A wallet confirmation is already in progress');
      for (const [text, max, name] of [[body, 2000, 'Message'], [nickname, 24, 'Nickname'], [requestId, 64, 'Request ID']]) {
        if (typeof text !== 'string' || !text.trim() || byteLength(text) > max) throw new Error(`${name} is missing or too long`);
      }
      parent = queueInteger(parent);
      sending = true;
      try {
        const {address} = await wallet();
        const root = parent ? (await message(parent)).parent || parent : 0;
        const prior = queueInteger(await view('get_request', [address, requestId]));
        if (prior) {
          const existing = await message(prior);
          if (existing.kind !== 1 || existing.author !== address || existing.body !== body
              || existing.nickname !== nickname || existing.parent !== root) throw new Error('Request ID conflict');
          return {state: 'confirmed', message: existing};
        }
        // Preserve requestId after BOTH success and errors until get_request confirms.
        // A host error can occur after submission. Never retry automatically here.
        await wallet();
        progress('wallet');
        const submission = await bridge.request('program.call', {
          method: 'send', params: [body, nickname, root, requestId], ou: '1000',
        });
        return {state: 'submitted', requestId, submission};
      } catch(error) {
        // Official webcli raises this before constructing, signing or submitting a call.
        if(error.message==='cannot read account nonce'){
          blockedUntil=now()+30000;error.code='NOT_SUBMITTED';
        }
        throw rateLimit(error);
      } finally { sending = false; }
    },
  };
}
