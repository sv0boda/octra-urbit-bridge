import test from 'node:test';
import assert from 'node:assert/strict';
import {reactionCounts,decodeReactions} from '../shared/reactions.mjs';
import {normalizePosts} from '../src/tlon.mjs';
import {RoomStore} from '../src/store.mjs';
import {LocalTlon} from '../src/local-fixture.mjs';
import {Gateway} from '../src/gateway.mjs';
test('counts valid ship reactions, preserving emoji variants and ignoring unsupported rich reactions',()=>{
 assert.deepEqual(reactionCounts({'~zod':'👍','~nec':'👍','~bud':'👍🏽','~wes':{image:'x'},invalid:'❤️','~bus':'\u202e'}),[['👍',2],['👍🏽',1]]);
 assert.throws(()=>decodeReactions('[[1,[["👍",0]]]]'));
 assert.throws(()=>decodeReactions('[[1,[]],[1,[]]]'));
 assert.throws(()=>decodeReactions(' '.repeat(16001)));
 assert.deepEqual([...decodeReactions('[[6,[["👍",1]]]]')],[[6,[['👍',1]]]]);
});
test('maps root and reply reactions to their own native IDs',()=>{
 const essay={author:'~zod',sent:1,content:[{inline:['hi']}]};
 const p=normalizePosts({posts:{'1.001':{essay,seal:{reacts:{'~nec':'❤️'},replies:{'1.002':{'reply-essay':essay,seal:{reacts:{'~bud':'👍'}}}}}}}},{ship:'~nec',bridgeId:'demo',includeReactions:true});
 assert.deepEqual(p.map(x=>[x.nativeId,x.reactions]),[['1001',[['❤️',1]]],['1002',[['👍',1]]]]);
});
test('syncs reactions only after new messages, persists the trigger, recovers lost receipts, and handles A→B→A',async t=>{
 const store=new RoomStore();t.after(()=>store.close());const tlon=new LocalTlon();tlon.allHistory=async()=>[tlon.history()];
 const rows=[{id:1,kind:1,author:'oct'+'A'.repeat(44),nickname:'Guest',body:'hi',parent:0,epoch:1,nativeId:''}];
 let snapshot='[]',revision=0,lose=false,reads=0;const calls=[];
 const chain={head:async()=>rows.length,message:async id=>({...rows[id-1]}),reactions:async()=>{reads++;return {snapshot,revision};},call:async(label,method,params)=>{
  if(method==='ack_delivery'){rows[params[0]-1].nativeId=params[1];return;}
  calls.push({label,method,params});assert.equal(method,'sync_reactions');assert.equal(params[0],revision);revision++;snapshot=params[1];
  if(lose){lose=false;throw new Error('Lost receipt');}
 }};
 let gateway=new Gateway({store,tlon,chain,ship:'~nec',nest:'chat/~zod/lobby'});await gateway.tick();
 const seal=tlon.posts['10001'].seal;
 await gateway.tick();const baselineReads=reads;
 const newMessage=async()=>{rows.push({...rows[0],id:rows.length+1,body:'new message '+rows.length,nativeId:''});assert.equal((await gateway.tick()).action,'acknowledge');};
 seal.reacts={'~zod':'👍'};for(let i=0;i<3;i++)assert.equal((await gateway.tick()).action,'idle');assert.equal(reads,baselineReads);await newMessage();assert.equal((await gateway.tick()).action,'reactions');assert.equal(snapshot,'[[1,[["👍",1]]]]');
 assert.equal((await gateway.tick()).action,'idle');assert.equal(calls.length,1);
 seal.reacts={'~zod':'❤️'};await newMessage();lose=true;await assert.rejects(gateway.tick(),/Lost receipt/);
 gateway=new Gateway({store,tlon,chain,ship:'~nec',nest:'chat/~zod/lobby'});assert.equal((await gateway.tick()).action,'idle');assert.equal(calls.length,2);
 seal.reacts={'~zod':'👍'};await newMessage();await gateway.tick();assert.notEqual(calls[0].label,calls[2].label);
 seal.reacts={};await gateway.tick();assert.notEqual(snapshot,'[]');await newMessage();await gateway.tick();assert.equal(snapshot,'[]');assert.equal(revision,4);
 assert.equal((await gateway.tick()).action,'idle');assert.equal(calls.length,4);
 await newMessage();assert.equal((await gateway.tick()).action,'idle');assert.equal(calls.length,4);
});
