import test from 'node:test';
import assert from 'node:assert/strict';
import {EyreTlon} from '../src/eyre.mjs';
const config={url:'https://moon.example',ship:'~nec',nest:'chat/~zod/welcome',cookie:'urbauth-~nec=fixture-cookie'};
const action={app:'channels',mark:'channel-action-2',json:{channel:{nest:config.nest,action:{post:{add:{author:'~nec',content:[{inline:['test']}]}}}}}};
function transport(event='id: 0\r\ndata: {"id":1,"response":"poke","ok":"ok"}\r\n\r\n') {
 const requests=[];const bytes=new TextEncoder().encode(event);
 const fetchImpl=async(url,options)=>{requests.push({url,options});if(options.method==='PUT')return new Response(null,{status:204});
  return new Response(new ReadableStream({start(c){for(let i=0;i<bytes.length;i+=7)c.enqueue(bytes.slice(i,i+7));c.close();}}),{headers:{'content-type':'text/event-stream'}});
 };return {requests,fetchImpl};
}
test('Eyre adapter defaults to read-only and pins origin, ship and channel',async()=>{
 const mock=transport();const client=new EyreTlon({...config,...mock});await assert.rejects(()=>client.poke(action),/disabled/);assert.equal(mock.requests.length,0);
 assert.throws(()=>new EyreTlon({...config,url:'http://moon.example'}),/HTTPS/);assert.throws(()=>new EyreTlon({...config,cookie:'urbauth-~zod=wrong'}),/cookie/);
 const writable=new EyreTlon({...config,...mock,allowWrites:true});await assert.rejects(()=>writable.poke({...action,app:'hood'}),/outside/);assert.equal(mock.requests.length,0);
});
test('positive SSE acknowledgement is required, acked and channel cleaned up',async()=>{
 const mock=transport();await new EyreTlon({...config,...mock,allowWrites:true}).poke(action);
 const bodies=mock.requests.filter(r=>r.options.method==='PUT').map(r=>JSON.parse(r.options.body));
 assert.equal(bodies[0][0].ship,'nec');assert.equal(bodies[1][0]['event-id'],0);assert.equal(bodies[2][0].action,'delete');
 assert.ok(mock.requests.every(r=>r.options.redirect==='error'));assert.ok(mock.requests.every(r=>r.options.headers.Cookie===config.cookie));
});
test('HTTP success without a poke ack is a failure; a nack stays a failure',async()=>{
 const ended=transport(': heartbeat\n\n');await assert.rejects(()=>new EyreTlon({...config,...ended,allowWrites:true}).poke(action),/before acknowledging/);
 const nack=transport('id: 1\ndata: {"id":1,"response":"poke","err":"private traceback"}\n\n');
 await assert.rejects(()=>new EyreTlon({...config,...nack,allowWrites:true}).poke(action),e=>e.rejected===true&&!e.message.includes('private traceback'));
});
test('history uses pinned v5 post endpoint and never accepts redirect responses',async()=>{
 let seen;const client=new EyreTlon({...config,fetchImpl:async(url,options)=>{seen={url,options};return Response.json({posts:{}});}});
 assert.deepEqual(await client.history(),{posts:{}});assert.equal(seen.url,'https://moon.example/~/scry/channels/v5/chat/~zod/welcome/posts/newest/100/post.json');assert.equal(seen.options.redirect,'error');
 await assert.rejects(()=>client.history(1000));
});
test('reply guard accepts canonical @ud IDs and rejects an unformatted large ID',async()=>{
 const mock=transport();const client=new EyreTlon({...config,...mock,allowWrites:true});
 const reply=id=>({app:'channels',mark:'channel-action-2',json:{channel:{nest:config.nest,action:{post:{reply:{id,action:{add:{author:'~nec'}}}}}}}});
 await assert.rejects(()=>client.poke(reply('170141184508243395498750889792368541696')),/Only new posts/);
 assert.equal(mock.requests.length,0);
 await client.poke(reply('170.141.184.508.243.395.498.750.889.792.368.541.696'));
 assert.ok(mock.requests.length>0);
});
