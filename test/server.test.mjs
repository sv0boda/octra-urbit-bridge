import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {request} from 'node:http';
import {createLocalServer} from '../src/server.mjs';
async function start(t, options) {
 const app=createLocalServer(options);await new Promise((resolve,reject)=>{app.server.once('error',reject);app.server.listen(0,'127.0.0.1',resolve);});
 t.after(()=>app.close());const url='http://127.0.0.1:'+app.server.address().port;
 const html=await (await fetch(url)).text();const csrf=JSON.parse(/window.alphaBootstrap=(\{.*?\});/.exec(html)[1]).csrf;
 return {app,url,csrf,html};
}
async function guest(server,persona) {
 let cookie='';const request=async(path,body,headers={})=>{
  const response=await fetch(server.url+'/api/'+path,{method:body===undefined?'GET':'POST',headers:{Cookie:cookie,'Content-Type':'application/json','X-Alpha-Csrf':server.csrf,...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
  if(response.headers.has('set-cookie'))cookie=response.headers.get('set-cookie').split(';')[0];return {status:response.status,data:await response.json()};
 };await request('login',{persona});return request;
}
test('HTTP requires a session, same-origin requests and CSRF for mutations',async t=>{
 const server=await start(t);assert.equal((await fetch(server.url+'/api/room')).status,401);
 assert.equal((await fetch(server.url+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"persona":"alice"}'})).status,403);
 const alice=await guest(server,'alice');assert.equal((await alice('messages',{body:'no',clientId:'x'},{Origin:'https://attacker.example'})).status,403);
 const hostileHost=await new Promise((resolve,reject)=>{const req=request(server.url+'/api/room',{headers:{Host:'attacker.example'}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);req.end();});
 assert.equal(hostileHost,403);
 assert.equal((await alice('room',undefined,{Cookie:'alpha_session=forged'})).status,401);
 const response=await fetch(server.url);assert.match(response.headers.get('content-security-policy'),/frame-ancestors 'none'/);
});
test('two browser sessions share a room with distinct identities, persistent names and threads',async t=>{
 const server=await start(t);const alice=await guest(server,'alice'),bob=await guest(server,'bob');
 await alice('profile',{nickname:'Alice'});await bob('profile',{nickname:'Bob'});
 const sent=await alice('messages',{body:'hello from Alice',clientId:'a',account:'fixture:octra-bob'});assert.equal(sent.status,200);assert.equal(sent.data.nickname,'Alice');assert.equal(sent.data.status,'delivered');
 const reply=await bob('messages',{body:'hello back',clientId:'b',replyTo:sent.data.seq});assert.equal(reply.data.reply_to,sent.data.seq);
 assert.notEqual(reply.data.guest_id,sent.data.guest_id);
 await alice('fixture-reply',{body:'welcome from Urbit',replyTo:reply.data.seq});
 const room=(await bob('room')).data;assert.equal(room.messages.at(-1).reply_to,sent.data.seq);assert.equal(room.messages.at(-1).source,'urbit');
 await alice('read',{seq:reply.data.seq});assert.equal((await bob('room')).data.guest.readSeq,0);
 await alice('logout',{});assert.equal((await alice('room')).status,401);await alice('login',{persona:'alice'});assert.equal((await alice('room')).data.guest.nickname,'Alice');
});
test('fixture survives process restart without reusing message IDs or losing thread roots',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'octra-tlon-server-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const dbFile=join(dir,'db');let app=createLocalServer({dbFile});const s=app.store;
 const root=s.send('fixture:octra-alice',{body:'root',clientId:'1'});
 s.db.prepare("UPDATE messages SET status='delivered',native_id='10002' WHERE seq=?").run(root.seq);
 s.ingest({nativeId:'10003',author:'~zod',body:'reply',sent:1,parentNativeId:'10002'});
 app.store.close();
 const server=await start(t,{dbFile});const alice=await guest(server,'alice');
 const next=await alice('messages',{body:'next',clientId:'2',replyTo:root.seq});assert.equal(next.data.native_id,'10004');assert.equal(next.data.reply_to,root.seq);
 const room=(await alice('room')).data;assert.equal(room.messages.length,4);
});
