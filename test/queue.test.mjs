import test from 'node:test';
import assert from 'node:assert/strict';
import {byteLength, decodeQueueMessage} from '../shared/queue-message.mjs';
import {queueTransport} from '../web/queue-transport.mjs';

const alice = 'oct' + 'A'.repeat(44), bob = 'oct' + 'B'.repeat(44);
const tuple = fields => fields.map(f => `${byteLength(String(f))}#${f}`).join('');
const outgoing = (body = 'Hello 🌙', native = '') => tuple([1, alice, 'Zoë', body, 0, 1798990, native]);

test('decodes byte lengths, delimiters inside content and delivery acknowledgements', () => {
  const result = decodeQueueMessage(1, outgoing('Hello 🌙 # 你好'));
  assert.equal(result.body, 'Hello 🌙 # 你好');
  assert.equal(result.nickname, 'Zoë');
  assert.equal(result.status, 'awaiting-tlon');
  assert.equal(decodeQueueMessage(1, outgoing('Hello', 'native-1')).status, 'delivered');
  assert.equal(decodeQueueMessage(2, tuple([2, '~zod', '~zod', 'Reply', 1, 10, 'n2'])).status, 'from-tlon');
});

test('refuses malformed, oversized and inconsistent queue records', () => {
  for (const bad of [outgoing() + '0#', outgoing().slice(0, -1), '9999#x',
    tuple([1, alice, 'Zoë', 'a'.repeat(2001), 0, 1, '']),
    tuple([1, alice, 'Zoë', 'Hello', 1, 1, '']),
    tuple([1, '~zod', 'Zoë', 'Hello', 0, 1, '']),
    tuple([0, alice, 'Zoë', 'Hello', 0, 1, '']),
    tuple([1, alice, 'Zoë', 'Hello', 0, '9007199254740992', ''])]) {
    assert.throws(() => decodeQueueMessage(1, bad));
  }
});

function host(overrides = {}) {
  const calls = [], state = {address: alice, prior: 0, value: outgoing(), ...overrides};
  const bridge = {async request(method, payload) {
    calls.push({method, payload});
    if (method === 'wallet.info') return {address: state.address};
    if (method === 'program.call') {
      if (state.call) return state.call(payload);
      return {tx_hash: 'pending-hash', status: 'accepted'};
    }
    assert.equal(method, 'program.view');
    const views = {get_reactions: '[]', get_head: 1, get_nickname: 'Zoë', get_request: state.prior, get_message: state.value};
    return {result: views[payload.method]};
  }};
  return {client: queueTransport({spacing:0,bridge}), calls, state};
}
const draft = {body: 'Hello 🌙', nickname: 'Zoë', requestId: 'stable-request-id'};

test('cleared history is excluded even with an old cursor; later messages remain readable', async () => {
  const ids=[];
  const bridge={async request(method,payload){
    if(method==='wallet.info')return {address:alice};
    assert.equal(method,'program.view');
    if(payload.method==='get_head')return {result:11};
    if(payload.method==='get_nickname')return {result:'Zoë'};
    if(payload.method==='get_reactions')return {result:'[]'};
    assert.equal(payload.method,'get_message');ids.push(payload.params[0]);
    return {result:outgoing('New conversation')};
  }};
  const room=await queueTransport({spacing:0,bridge,visibleAfter:9}).read({after:0});
  assert.deepEqual(ids,[10,11]);assert.deepEqual(room.messages.map(m=>m.id),[10,11]);
  assert.equal(room.head,11);
});

test('serializes message views and recovers from temporary Circle contention', async () => {
  let active=0, busyOnce=true;
  const delays=[];
  const bridge={async request(method,payload){
    if(method==='wallet.info')return {address:alice};
    assert.equal(method,'program.view');
    if(payload.method==='get_head')return {result:3};
    if(payload.method==='get_nickname')return {result:'Zoë'};
    if(payload.method==='get_reactions')return {result:'[]'};
    assert.equal(active,0,'Concurrent views would be rejected by devnet');
    active++;
    try{
      await new Promise(resolve=>setImmediate(resolve));
      if(busyOnce){busyOnce=false;throw new Error('RPC octra_circleViewAuth: circle view busy');}
      return {result:outgoing()};
    }finally{active--;}
  }};
  const room=await queueTransport({spacing:0,bridge,wait:async ms=>delays.push(ms)}).read();
  assert.equal(room.messages.length,3);assert.deepEqual(delays,[250]);
});

test('busy retries are bounded and unrelated view failures are not retried', async () => {
  let calls=0;
  const bridge={async request(){calls++;throw new Error('circle view busy');}};
  const client=queueTransport({spacing:0,bridge,wait:async()=>{}});
  await assert.rejects(client.head(),/circle view busy/);assert.equal(calls,5);
  calls=0;bridge.request=async()=>{calls++;throw new Error('Unauthorized');};
  await assert.rejects(client.head(),/Unauthorized/);assert.equal(calls,1);
});

test('uses native wallet calls without target, author, amount or relayer overrides', async () => {
  const h = host(); const room = await h.client.read();
  assert.equal(room.address, alice); assert.equal(room.messages.length, 1);
  const result = await h.client.send({...draft, author: bob, circle_id: 'attacker'});
  assert.equal(result.state, 'submitted'); assert.equal(result.message, undefined);
  assert.deepEqual(h.calls.filter(c => c.method === 'program.call'), [{method: 'program.call', payload: {
    method: 'send', params: ['Hello 🌙', 'Zoë', 0, 'stable-request-id'], ou: '1000',
  }}]);
});

test('lost response followed by confirmation reconciles the request without another transaction', async () => {
  const h = host({call: async () => {h.state.prior = 1; throw new Error('Connection closed');}});
  await assert.rejects(h.client.send(draft), /Connection closed/);
  const result = await h.client.send(draft);
  assert.equal(result.state, 'confirmed'); assert.equal(result.message.status, 'awaiting-tlon');
  assert.equal(h.calls.filter(c => c.method === 'program.call').length, 1);
  await assert.rejects(h.client.send({...draft, body: 'different content'}), /conflict/);
});

test('wallet changes refuse further sends and cannot inherit the prior wallet profile', async () => {
  const h = host(); await h.client.read(); h.state.address = bob;
  await assert.rejects(h.client.send(draft), /wallet changed/);
  assert.equal(h.calls.filter(c => c.method === 'program.call').length, 0);
});

test('concurrent clicks cannot open multiple approval flows', async () => {
  let release;
  const pending = new Promise(resolve => {release = resolve;});
  const h = host({call: () => pending});
  const first = h.client.send(draft);
  await assert.rejects(h.client.send(draft), /already in progress/);
  release({status: 'accepted'}); await first;
  assert.equal(h.calls.filter(c => c.method === 'program.call').length, 1);
});

test('validates UTF-8 limits before requesting the wallet', async () => {
  const h = host();
  for (const invalid of [{body: '🌙'.repeat(501)}, {nickname: '🌙'.repeat(7)}, {requestId: ''}, {parent: -1}]) {
    await assert.rejects(h.client.send({...draft, ...invalid}));
  }
  assert.equal(h.calls.length, 0);
});

test('idle refresh reuses settled messages but still reads delivery and reactions',async()=>{
  const h=host({value:outgoing('Hello','delivered-native')});
  await h.client.read();h.calls.length=0;
  await h.client.read();
  assert.deepEqual(h.calls.filter(x=>x.method==='program.view').map(x=>x.payload.method),['get_head','get_reactions']);
  const pending=host();await pending.client.read();pending.state.value=outgoing('Hello 🌙','now-delivered');
  assert.equal((await pending.client.read()).messages[0].status,'delivered');
  pending.calls.length=0;await pending.client.read();
  assert.equal(pending.calls.filter(x=>x.payload?.method==='get_message').length,0);
});

test('429 pauses every read and send, backs off, and resumes without duplicate calls',async()=>{
  let time=0,fail=true,calls=0;
  const bridge={async request(){calls++;if(fail)throw new Error('RPC HTTP 429');return {result:0};}};
  const client=queueTransport({spacing:0,bridge,now:()=>time});
  await assert.rejects(client.head(),{code:'RATE_LIMITED'});
  for(const request of [()=>client.head(),()=>client.read(),()=>client.check('id'),()=>client.send(draft)])
    await assert.rejects(request(),{code:'RATE_LIMITED'});
  assert.equal(calls,1);
  time=30000;await assert.rejects(client.head(),{code:'RATE_LIMITED'});assert.equal(calls,2);
  time=60000;await assert.rejects(client.head(),{code:'RATE_LIMITED'});assert.equal(calls,2);
  time=90000;fail=false;assert.equal(await client.head(),0);assert.equal(calls,3);
});

test('an ambiguous send 429 preserves the request for read-only reconciliation',async()=>{
  let time=0,calls=0,confirmed=false;
  const client=queueTransport({spacing:0,now:()=>time,bridge:{async request(method,payload){
    if(method==='wallet.info')return {address:alice};
    if(method==='program.call'){calls++;confirmed=true;throw new Error('RPC HTTP 429');}
    return {result:payload.method==='get_request'?(confirmed?1:0):outgoing()};
  }}});
  await assert.rejects(client.send(draft),{code:'RATE_LIMITED'});
  await assert.rejects(client.check(draft.requestId),{code:'RATE_LIMITED'});
  time=30000;assert.equal((await client.check(draft.requestId)).body,draft.body);
  assert.equal(calls,1);
});

test('a partially loaded room keeps completed messages across a rate-limit pause',async()=>{
  let time=0,blocked=true;const ids=[];
  const client=queueTransport({spacing:0,now:()=>time,bridge:{async request(method,payload){
    if(method==='wallet.info')return {address:alice};
    const values={get_head:3,get_nickname:'Zoë',get_reactions:'[]'};
    if(payload.method!=='get_message')return {result:values[payload.method]};
    const id=payload.params[0];ids.push(id);
    if(id===2 && blocked)throw new Error('RPC HTTP 429');
    return {result:tuple([2,'~zod','~zod','Message '+id,0,1,'native-'+id])};
  }}});
  await assert.rejects(client.read(),{code:'RATE_LIMITED'});
  blocked=false;time=30000;assert.equal((await client.read()).messages.length,3);
  assert.deepEqual(ids,[1,2,2,3]);
});

test('nonce-read failure is pre-submission and pauses new attempts',async()=>{
  let time=0,calls=0;
  const client=queueTransport({spacing:0,now:()=>time,bridge:{async request(method){
    if(method==='wallet.info')return {address:alice};
    if(method==='program.call'){calls++;throw new Error('cannot read account nonce');}
    return {result:0};
  }}});
  await assert.rejects(client.send(draft),{code:'NOT_SUBMITTED'});
  await assert.rejects(client.send(draft),{code:'RATE_LIMITED'});assert.equal(calls,1);
});

test('serialized reads are paced even without RPC latency',async()=>{
  let time=0;const starts=[];
  const client=queueTransport({now:()=>time,wait:async delay=>{time+=delay;},bridge:{async request(){starts.push(time);return {result:0};}}});
  await Promise.all([client.head(),client.head(),client.head()]);
  assert.deepEqual(starts,[0,500,1000]);
});
