import test from 'node:test';
import assert from 'node:assert/strict';
import {RoomStore} from '../src/store.mjs';
import {LocalTlon} from '../src/local-fixture.mjs';
import {Gateway} from '../src/gateway.mjs';
const ship='~nec',nest='chat/~zod/lobby',wallet='oct'+'A'.repeat(44);
function setup(t){
 const store=new RoomStore();t.after(()=>store.close());const tlon=new LocalTlon();tlon.allHistory=async()=>[tlon.history()];
 const rows=[{id:1,kind:1,author:wallet,nickname:'River',body:'Hello from the Circle',parent:0,epoch:1,nativeId:''}];
 const calls=[];const chain={head:async()=>rows.length,message:async id=>({...rows[id-1]}),call:async(label,method,params)=>{
  calls.push({label,method,params});
  if(method==='ack_delivery')rows[params[0]-1].nativeId=params[1];
  else{const [nativeId,author,body,parent]=params;rows.push({id:rows.length+1,kind:2,author,nickname:author,body,parent,epoch:2,nativeId});}
 }};
 const gateway=new Gateway({store,tlon,chain,ship,nest});return {store,tlon,chain,rows,calls,gateway};
}
test('committed queue posts reach Tlon once; acknowledgements do not echo back as native posts',async t=>{
 const s=setup(t);assert.equal((await s.gateway.tick()).action,'acknowledge');
 assert.equal(Object.keys(s.tlon.posts).length,1);assert.equal(s.rows[0].nativeId,'10001');
 for(let i=0;i<3;i++)assert.equal((await s.gateway.tick()).action,'idle');
 assert.equal(s.calls.length,1);assert.equal(s.store.room('devnet:'+wallet).messages[0].status,'delivered');
});
test('native Tlon reply returns to the same Circle thread without being sent back to Tlon',async t=>{
 const s=setup(t);await s.gateway.tick();s.tlon.reply('Welcome from Urbit',s.rows[0].nativeId);
 assert.equal((await s.gateway.tick()).action,'publish');
 assert.equal(s.rows[1].parent,1);assert.equal(s.rows[1].author,'~zod');
 assert.equal((await s.gateway.tick()).action,'idle');assert.equal(s.calls.length,2);
 assert.equal(Object.keys(s.tlon.posts['10001'].seal.replies).length,1);
});
test('lost ship acknowledgement reconciles the same post before any retry',async t=>{
 const s=setup(t);let pokes=0;const poke=s.tlon.poke.bind(s.tlon);
 s.tlon.poke=async action=>{pokes++;await poke(action);throw new Error('Lost HTTP connection');};
 await assert.rejects(s.gateway.tick(),/Lost HTTP/);
 assert.equal(s.store.message(1).status,'uncertain');
 assert.equal((await s.gateway.tick()).action,'acknowledge');assert.equal(pokes,1);
 assert.equal((await s.gateway.tick()).action,'idle');
});
test('Circle reply uses the delivered native parent; changed guest name remains a snapshot',async t=>{
 const s=setup(t);await s.gateway.tick();
 s.rows.push({...s.rows[0],id:2,body:'A reply',parent:1,nickname:'River Two',nativeId:''});
 await s.gateway.tick();assert.equal(s.rows[1].nativeId,'10002');
 const reply=s.tlon.posts['10001'].seal.replies['10002'];assert.match(reply['reply-essay'].content[0].inline[0],/^River Two/);
 assert.match(s.tlon.posts['10001'].essay.content[0].inline[0],/^River ·/);
});
