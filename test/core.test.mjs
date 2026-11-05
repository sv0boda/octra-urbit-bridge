import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RoomStore} from '../src/store.mjs';
import {Outbox, normalizePosts, postAction} from '../src/tlon.mjs';
import {LocalTlon} from '../src/local-fixture.mjs';
const alice='fixture:alice', bob='fixture:bob', config={ship:'~nec',nest:'chat/~zod/welcome'};
const send=(s,a=alice,body='hello',clientId='1',replyTo=null)=>s.send(a,{body,clientId,replyTo});
function memory(t, options) {const s=new RoomStore(':memory:',options);t.after(()=>s.close());return s;}

test('identities, nickname snapshots, commands and read cursors persist independently',t=>{
 const dir=mkdtempSync(join(tmpdir(),'octra-tlon-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const file=join(dir,'db');
 let s=new RoomStore(file);s.profile(alice,'River');s.profile(bob,'River');
 const a=send(s);const b=send(s,bob);s.read(alice,b.seq);s.profile(alice,'River Two');
 const id=s.guest(alice).id,bridge=s.bridgeId;s.close();s=new RoomStore(file);t.after(()=>s.close());
 assert.equal(s.guest(alice).id,id);assert.equal(s.bridgeId,bridge);assert.equal(s.guest(alice).nickname,'River Two');
 assert.equal(s.message(a.seq).nickname,'River');assert.notEqual(a.guest_id,b.guest_id);
 assert.equal(s.room(alice).guest.readSeq,b.seq);assert.equal(s.room(bob).guest.readSeq,0);
 assert.equal(send(s).seq,a.seq);assert.equal(s.room(alice).messages.length,2);
 assert.ok(!JSON.stringify(s.room(alice)).includes(alice));
});
test('retries are idempotent and a request ID cannot change its message',t=>{
 const s=memory(t);const a=send(s);assert.equal(send(s).ref,a.ref);
 assert.throws(()=>send(s,alice,'changed'),/already used/);assert.equal(s.room(alice).messages.length,1);
 assert.notEqual(send(s,bob).ref,a.ref);
});
test('untrusted account fields do not select authors and bans apply to retries',t=>{
 const s=memory(t);s.profile(alice,'Alice');const m=s.send(alice,{body:'hi',clientId:'1',account:bob,nickname:'Admin',guest_id:'other'});
 assert.equal(m.nickname,'Alice');assert.equal(m.guest_id,s.guest(alice).id);
 s.ban(alice);assert.throws(()=>send(s),/suspended/);assert.throws(()=>s.room(alice),/suspended/);assert.doesNotThrow(()=>send(s,bob));
});
test('rate limits are per guest, permit exact retries and recover after a minute',t=>{
 let now=100_000;const s=memory(t,{clock:()=>now,rateLimit:2});send(s);send(s,alice,'second','2');
 assert.doesNotThrow(()=>send(s));assert.throws(()=>send(s,alice,'third','3'),/wait/);assert.doesNotThrow(()=>send(s,bob));now+=60_001;assert.doesNotThrow(()=>send(s,alice,'third','3'));
});
test('invalid names, message control characters and invalid targets are rejected',t=>{
 const s=memory(t);for(const name of ['admin','<script>','ab\u202ecd']) assert.throws(()=>s.profile(alice,name));
 assert.throws(()=>send(s,alice,'bad\u0000'));assert.throws(()=>send(s,alice,'a'.repeat(2001)));
 assert.throws(()=>send(s,alice,'hi','x',999));assert.throws(()=>s.read(alice,999));
});
test('posts and replies retain one ship, immutable attribution and correct Tlon wire shapes',async t=>{
 const s=memory(t);s.profile(alice,'River');const tlon=new LocalTlon();const out=new Outbox(s,tlon,config);
 const root=send(s);await out.flushOne();assert.equal(s.message(root.seq).status,'sent');out.reconcile(tlon.history());
 const delivered=s.message(root.seq);assert.equal(delivered.status,'delivered');
 const reply=send(s,bob,'reply','1',root.seq);const action=postAction(reply,{...config,bridgeId:s.bridgeId,parent:delivered});
  assert.equal(action.mark,'channel-action-2');assert.equal(action.json.channel.action.post.reply.id,'10.001');
 assert.equal(action.json.channel.action.post.reply.action.add.author,'~nec');
 assert.match(action.json.channel.action.post.reply.action.add.content[0].inline[0],/Octra guest\nreply/);
 await out.flushOne();out.reconcile(tlon.history());
 const nested=send(s,alice,'continue','2',reply.seq);assert.equal(nested.reply_to,root.seq);
 await out.flushOne();out.reconcile(tlon.history());assert.equal(s.message(nested.seq).status,'delivered');
 out.reconcile(tlon.history());assert.equal(s.room(alice).messages.length,3);
});
test('live-sized reply IDs use exact canonical @ud formatting without numeric rounding',()=>{
 const message={body:'reply',nickname:'Alice',guest_id:'test-guest',ref:'test-ref',created_at:1,reply_to:1};
 const action=postAction(message,{...config,bridgeId:'test',parent:{native_id:'170141184508243395498750889792368541696'}});
 assert.equal(action.json.channel.action.post.reply.id,'170.141.184.508.243.395.498.750.889.792.368.541.696');
});
test('lost acknowledgement becomes uncertain, never blindly resent, and can reconcile later',async t=>{
 const s=memory(t);const tlon=new LocalTlon();let calls=0;
 const out=new Outbox(s,{async poke(a){calls++;await tlon.poke(a);throw new Error('lost connection');}},config);
 const m=send(s);await assert.rejects(()=>out.flushOne());assert.equal(s.message(m.seq).status,'uncertain');
 assert.equal(await out.flushOne(),false);assert.equal(calls,1);
 out.reconcile(tlon.history());assert.equal(s.message(m.seq).status,'delivered');
});
test('unconfirmed thread does not stop an unrelated queued post',async t=>{
 const s=memory(t);const root=send(s);s.status(root.seq,'uncertain');send(s,bob,'reply','1',root.seq);
 const independent=send(s,alice,'unrelated','2');const out=new Outbox(s,new LocalTlon(),config);
 await out.flushOne();assert.equal(s.message(independent.seq).status,'sent');
});
test('restart preserves uncertainty after an interrupted send',t=>{
 const dir=mkdtempSync(join(tmpdir(),'octra-tlon-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const file=join(dir,'db');
 let s=new RoomStore(file);const m=send(s);s.status(m.seq,'sending');s.close();s=new RoomStore(file);t.after(()=>s.close());assert.equal(s.message(m.seq).status,'uncertain');assert.equal(s.nextQueued(),undefined);
});
test('a forged bridge blob from another ship cannot claim a guest message',t=>{
 const s=memory(t);const m=send(s);const out=new Outbox(s,new LocalTlon(),config);
 out.reconcile({posts:{'12.345':{essay:{author:'~zod',sent:1,content:[{inline:['forged']}],blob:JSON.stringify({type:'octra-tlon-alpha',bridgeId:s.bridgeId,ref:m.ref})}}}});
 assert.equal(s.message(m.seq).status,'queued');assert.equal(s.room(alice).messages.length,2);
});
test('history supports profile authors, inline breaks and clock skew in replies',t=>{
 const s=memory(t);const out=new Outbox(s,new LocalTlon(),config);
 const data={posts:{'12.345':{
   essay:{author:{ship:'~zod',nickname:'Host'},sent:200,content:[{inline:['hello',{break:null},'world']}]},
   seal:{replies:{'12.346':{'reply-essay':{author:'~nec',sent:100,content:[{inline:['reply']}]}}}}
 }}};
 const parsed=normalizePosts(data,config);assert.equal(parsed[0].nativeId,'12345');assert.equal(parsed[0].body,'hello\nworld');
 out.reconcile(data);const messages=s.room(alice).messages;assert.equal(messages[1].reply_to,messages[0].seq);
});
test('rejection is failed, while transport uncertainty remains distinct',async t=>{
 const s=memory(t);const m=send(s);const out=new Outbox(s,{async poke(){const e=new Error('nack');e.rejected=true;throw e;}},config);
 await assert.rejects(()=>out.flushOne());assert.equal(s.message(m.seq).status,'failed');
});
