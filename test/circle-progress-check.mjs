// UX state tests. All wallet/RPC replies are synthetic; no transactions are signed.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFileSync,writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
const root=new URL('../',import.meta.url).pathname;
const {chromium}=await import(pathToFileURL(process.env.ALPHA_PLAYWRIGHT || new URL('../node_modules/playwright/index.mjs',import.meta.url).pathname));
// These synthetic records predate the live cleanup boundary; use a fresh fixture room.
const server=createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end(readFileSync(root+'build/index.html','utf8').replace('const visibleAfter = 9;','const visibleAfter = 0;'));});
await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser;
try {
 browser=await chromium.launch({headless:true,executablePath:process.env.ALPHA_CHROMIUM || undefined});
 const page=await browser.newPage({viewport:{width:1200,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>{
  window.setInterval=cb=>{window.testPoll=cb;return 1;};
  window.testState={calls:0,confirmed:false,delivered:false,body:'Hello from Octra',reacts:'[[1,[["👍",1]]]]',mode:'success'};
  const address='oct'+'A'.repeat(44);let walletGranted=false,roomGranted=false,loaded=false;
  window.OctraCircle={context:{circle_id:'oct'+'B'.repeat(44)},async request(method,payload){
   if(method==='wallet.info'){if(!walletGranted){await new Promise(r=>window.allowWallet=r);walletGranted=true;}return {address};}
   if(method==='program.call'){
    window.testState.calls++;await new Promise(r=>window.sign=r);
    if(window.testState.mode==='cancel')throw new Error('program call cancelled');
    if(window.testState.mode==='unknown')throw new Error('bridge request timed out');
    return {tx_hash:'a'.repeat(64)};
   }
   if(method!=='program.view')throw new Error('Unexpected method');
   if(!roomGranted){await new Promise(r=>window.allowRoom=r);roomGranted=true;}
   if(payload.method==='get_head')return {result:window.testState.confirmed?2:1};
   if(payload.method==='get_nickname'){if(!loaded){await new Promise(r=>window.loadRoom=r);loaded=true;}return {result:'Guest'};}
   if(payload.method==='get_reactions')return {result:window.testState.reacts};
   if(payload.method==='get_request')return {result:window.testState.confirmed?2:0};
   if(payload.method==='get_message'){
    const native=window.testState.delivered?'10002':'';
    const fields=payload.params[0]===1?[2,'~zod','~zod','Welcome from Urbit',0,1,'10001']:[1,address,'Guest',window.testState.body,0,1,native];
    return {result:fields.map(v=>new TextEncoder().encode(String(v)).length+'#'+v).join('')};
   }
   throw new Error('Unexpected view');
  }};
 });
 const notice=page.locator('#notice');
 await page.goto('http://127.0.0.1:'+server.address().port);
 await page.locator('#connect').click();await page.locator('#connection').filter({hasText:'1 of 2'}).waitFor();assert.equal(await page.locator('#connect').isDisabled(),true);
 await page.evaluate(()=>window.allowWallet());await page.locator('#connection').filter({hasText:'2 of 2'}).waitFor();
 await page.evaluate(()=>window.allowRoom());await page.locator('#connection').filter({hasText:'Access granted. Loading'}).waitFor();
 await page.screenshot({path:root+'evidence/circle-loading-preview.png'});
 await page.waitForFunction(()=>typeof window.loadRoom==='function');
 await page.evaluate(()=>window.loadRoom());await page.locator('#composer').waitFor({state:'visible'});
 assert.equal(await page.locator('.reaction').textContent(),'👍 1');
 await page.locator('#body').fill('Hello from Octra');await page.locator('#send').click();
 await notice.filter({hasText:'Waiting for wallet approval'}).waitFor();assert.equal(await page.locator('#body').isDisabled(),true);
 await page.evaluate(()=>window.sign());await notice.filter({hasText:'Transaction submitted'}).waitFor();
 await page.waitForFunction(()=>!document.getElementById('send').disabled);
 assert.equal(await page.locator('#transaction-link').getAttribute('href'),'https://devnet.octrascan.io/tx.html?hash='+'a'.repeat(64));
 await page.locator('#send').click();await page.waitForFunction(()=>!document.getElementById('send').disabled);
 assert.equal(await page.evaluate(()=>window.testState.calls),1);assert.equal(await page.locator('#body').isDisabled(),true);
 await page.screenshot({path:root+'evidence/circle-submitted-preview.png',fullPage:true});
 await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await page.screenshot({path:root+'evidence/circle-submitted-mobile.png',fullPage:true});
 await page.evaluate(async()=>{window.testState.confirmed=true;await window.testPoll();});
 await notice.filter({hasText:'Message confirmed on devnet'}).waitFor();assert.equal(await page.locator('#body').inputValue(),'');assert.equal(await page.locator('#body').isDisabled(),false);
 await page.evaluate(async()=>{window.testState.delivered=true;window.testState.reacts='[]';await window.testPoll();});
 await notice.filter({hasText:'Delivered to Tlon'}).waitFor();assert.equal(await page.locator('.reaction').count(),0);
 // An explicit wallet cancellation preserves the draft and enables a fresh attempt.
 await page.evaluate(()=>{window.testState.confirmed=false;window.testState.mode='cancel';});
 await page.locator('#body').fill('Cancelled draft');await page.locator('#send').click();await notice.filter({hasText:'Waiting for wallet approval'}).waitFor();
 await page.evaluate(()=>window.sign());await notice.filter({hasText:'Sending cancelled'}).waitFor();assert.equal(await page.locator('#body').inputValue(),'Cancelled draft');assert.equal(await page.locator('#body').isDisabled(),false);
 // A lost result stays locked and every status check remains read-only.
 await page.evaluate(()=>window.testState.mode='unknown');await page.locator('#send').click();await notice.filter({hasText:'Waiting for wallet approval'}).waitFor();
 await page.evaluate(()=>window.sign());await notice.filter({hasText:'Checking submission status'}).waitFor();
 await page.waitForFunction(()=>!document.getElementById('send').disabled);await page.locator('#send').click();await page.waitForFunction(()=>!document.getElementById('send').disabled);
 assert.equal(await page.evaluate(()=>window.testState.calls),3);assert.equal(await page.locator('#body').isDisabled(),true);
 assert.deepEqual(errors,[]);
 const result={checkedAt:new Date().toISOString(),mode:'Synthetic wallet; zero live writes',checks:['Separate wallet/room permissions and immediate loading state','Draft locks during approval and remains locked while pending','Returned receipt shows exact devnet explorer URL','Check status never signs or resubmits','Confirmation clears draft and unlocks composer','Native delivery advances final step','Reaction display and removal update on refresh','Cancellation preserves editable draft; unknown result stays locked','390px mobile layout fits'],pageErrors:errors};
 writeFileSync(root+'evidence/circle-progress-check.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
}finally{await browser?.close();await new Promise(r=>server.close(r));}
