import test from 'node:test';
import assert from 'node:assert/strict';
import {RoomStore} from '../src/store.mjs';
import {LocalTlon} from '../src/local-fixture.mjs';
import {Outbox} from '../src/tlon.mjs';
import {createRelayServer} from '../src/relay.mjs';
import {circleTransport} from '../web/circle-transport.mjs';
import {REPORTED_WALLET_KIND} from '../shared/guest-identity.mjs';

async function setup(t,options={}) {
 const store=new RoomStore();const tlon=new LocalTlon();const outbox=new Outbox(store,tlon,{ship:'~nec',nest:'chat/~zod/lobby'});
 const server=createRelayServer({store,delivery:{async refresh(){outbox.reconcile(tlon.history());},async flush(){while(await outbox.flushOne())outbox.reconcile(tlon.history());}},...options});
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 t.after(async()=>{await new Promise(r=>server.close(r));store.close();});
 const base='http://127.0.0.1:'+server.address().port;
 const raw=async(body)=>{const r=await fetch(base+'/request',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:r.status,body:await r.json()};};
 const request=(method,params={},auth)=>raw({app:'octra-tlon-alpha',version:1,method,params,auth});
 return {store,base,raw,request};
}
// The following verifier is a TEST FIXTURE, never a deployment default.
const authenticate=async proof=>['alice-token','bob-token'].includes(proof)?{account:'invite:'+proof,kind:'invite'}:null;

test('shared relay rejects malformed or unspecified identity assertions',async t=>{
 const s=await setup(t);const response=await s.raw({app:'octra-tlon-alpha',version:1,method:'room.get',auth:{address:'octraFake',verified:true},account:'octra:claimed'});
 assert.equal(response.status,401);assert.equal(s.store.db.prepare('SELECT COUNT(*) AS n FROM guests').get().n,0);
});

const addressA='oct'+'A'.repeat(44),addressB='oct'+'B'.repeat(44);
test('reported address restores the same profile, with no signature or invite code',async t=>{
 const s=await setup(t,{allowPosting:true});
 const bridge=address=>({async request(method,payload){
  if(method==='wallet.info')return {address,public_key:'not-needed'};
  assert.equal(method,'relay.request');assert.deepEqual(payload.auth,{kind:REPORTED_WALLET_KIND,address});
  return (await s.raw(payload)).body;
 }});
 const a=circleTransport({bridge:bridge(addressA)});await a('profile.set',{nickname:'River'});
 const message=await a('message.send',{body:'hello',clientId:'1'});
 const reconnect=circleTransport({bridge:bridge(addressA)});const room=await reconnect('room.get');
 assert.equal(room.guest.nickname,'River');assert.equal(room.guest.id,message.guest_id);
 const b=circleTransport({bridge:bridge(addressB)});assert.notEqual((await b('room.get')).guest.id,room.guest.id);
 assert.ok(!JSON.stringify(room).includes(addressA));
});
test('alpha explicitly trusts a declared address without treating it as verified',async t=>{
 const s=await setup(t);const auth={kind:REPORTED_WALLET_KIND,address:addressA,verified:true,role:'admin'};
 const response=await s.request('room.get',{},auth);
 assert.equal(response.status,200);assert.equal(response.body.identityKind,REPORTED_WALLET_KIND);
 assert.equal(s.store.guest('reported-octra:'+addressA).id,response.body.result.guest.id);
 // This is the accepted alpha limitation: a direct caller can assert the same ID.
 const impersonator=await s.request('room.get',{},auth);assert.equal(impersonator.body.result.guest.id,response.body.result.guest.id);
 for(const address of ['',addressA.toUpperCase(),addressA+' ',addressA.replace('A','0')])assert.equal((await s.request('room.get',{},{kind:REPORTED_WALLET_KIND,address})).status,401);
});
test('wallet changes, missing wallets and permission denial never forward a write',async()=>{
 let address=addressA,calls=0;const client=circleTransport({bridge:{async request(method){if(method==='wallet.info')return {address};calls++;return {ok:true,result:{}};}}});
 await client('room.get');address=addressB;await assert.rejects(()=>client('message.send',{body:'draft',clientId:'1'}),/wallet changed/);assert.equal(calls,1);
 const absent=circleTransport({bridge:{async request(){return {};}}});await assert.rejects(()=>absent('room.get'),/Open an Octra wallet/);
 const denied=circleTransport({bridge:{async request(){throw new Error('Permission denied');}}});await assert.rejects(()=>denied('room.get'),/Permission denied/);
});
test('one relay serves two principals while ignoring author and destination overrides',async t=>{
 const s=await setup(t,{authenticate,allowPosting:true});
 await s.request('profile.set',{nickname:'Alice'},'alice-token');await s.request('profile.set',{nickname:'Bob'},'bob-token');
 const a=await s.request('message.send',{body:'Hello',clientId:'1',account:'invite:bob-token',nickname:'Bob',ship:'~zod'},'alice-token');assert.equal(a.body.result.nickname,'Alice');assert.equal(a.body.result.status,'delivered');
 const b=await s.request('message.send',{body:'Reply',clientId:'1',replyTo:a.body.result.seq},'bob-token');assert.equal(b.body.result.nickname,'Bob');assert.notEqual(a.body.result.guest_id,b.body.result.guest_id);
 assert.equal((await s.request('room.get',{},'bob-token')).body.result.messages.length,2);
 assert.equal((await s.request('message.send',{body:'Hello',clientId:'1'},'alice-token')).body.result.seq,a.body.result.seq);
});
test('relay exposes no generic ship actions and posting must be explicitly enabled',async t=>{
 const s=await setup(t,{authenticate});assert.equal((await s.request('message.send',{body:'hi',clientId:'1'},'alice-token')).status,503);
 for(const method of ['poke','scry','dojo','wallet.export']) assert.equal((await s.request(method,{},'alice-token')).status,400);
 assert.equal((await fetch(s.base+'/~/login')).status,404);
});
test('revoked or banned guest cannot read the room, and oversized bodies are rejected',async t=>{
 const s=await setup(t,{authenticate});await s.request('room.get',{},'alice-token');s.store.ban('invite:alice-token');
 assert.equal((await s.request('room.get',{},'alice-token')).status,400);assert.equal((await s.request('room.get',{},'revoked')).status,401);
 assert.equal((await s.request('room.get',{padding:'x'.repeat(20000)},'bob-token')).status,413);
});
test('Circle transport uses relay.request and preserves retry IDs end to end',async t=>{
 const s=await setup(t,{authenticate,allowPosting:true});let last;
 const client=circleTransport({authentication:async()=>'alice-token',bridge:{async request(method,payload){assert.equal(method,'relay.request');last=payload;return (await s.raw(payload)).body;}}});
 const first=await client('message.send',{body:'hello',clientId:'persistent-id'});const second=await client('message.send',{body:'hello',clientId:'persistent-id'});
 assert.equal(first.seq,second.seq);assert.equal(last.app,'octra-tlon-alpha');assert.equal((await client('room.get')).messages.length,1);
});
