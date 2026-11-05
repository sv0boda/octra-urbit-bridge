// Browser-only feedback regression. Synthetic wallet host; no signing or RPC.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFileSync,writeFileSync} from 'node:fs';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const {chromium}=await import(pathToFileURL(process.env.ALPHA_PLAYWRIGHT || new URL('../node_modules/playwright/index.mjs',import.meta.url).pathname));
const html=readFileSync(root+'build/index.html','utf8').replace('const visibleAfter = 9;','const visibleAfter = 0;');
const server=createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end(html);});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
let browser;
try{
 browser=await chromium.launch({headless:true,executablePath:process.env.ALPHA_CHROMIUM || undefined});
 const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>{
   window.setInterval=callback=>{window.testPoll=callback;return 1;};
   window.testState={calls:0,views:0,confirmed:false,failRead:true,time:0};Date.now=()=>window.testState.time;
   const address='oct'+'A'.repeat(44);
   window.OctraCircle={context:{circle_id:'oct'+'B'.repeat(44)},async request(method,payload){
    if(method==='wallet.info')return {address};
    if(method==='program.call'){window.testState.calls++;throw new Error('RPC HTTP 429');}
    if(method!=='program.view')throw new Error('Unexpected bridge method');window.testState.views++;if(window.testState.failRead)throw new Error('RPC HTTP 429');
    if(payload.method==='get_reactions')return {result:'[]'};
    if(payload.method==='get_nickname')return {result:'Feedback Test'};
    if(payload.method==='get_head'||payload.method==='get_request')return {result:window.testState.confirmed?1:0};
    if(payload.method==='get_message')return {result:[1,address,'Feedback Test','feedback check',0,1,''].map(v=>new TextEncoder().encode(String(v)).length+'#'+v).join('')};
    throw new Error('Unexpected view');
   }};
 });
 await page.goto('http://127.0.0.1:'+server.address().port);
 await page.getByRole('button',{name:'Enter with Octra wallet'}).click();
 await page.locator('#room-state').filter({hasText:'Rate limited'}).waitFor();
 const first=await page.evaluate(()=>window.testState.views);
 await page.evaluate(async()=>{window.testState.failRead=false;await window.testPoll();});
 assert.equal(await page.evaluate(()=>window.testState.views),first);
 await page.evaluate(async()=>{window.testState.time=30000;await window.testPoll();});
 await page.locator('#composer').waitFor({state:'visible'});
 await page.locator('#body').fill('feedback check');await page.locator('#send').click();
 await page.locator('#notice').filter({hasText:'Checking submission status'}).waitFor();
 await page.waitForFunction(()=>!document.getElementById('send').disabled);
 assert.equal(await page.locator('#body').isDisabled(),true);
 const before=await page.evaluate(()=>window.testState.views);
 await page.locator('#send').click();await page.waitForFunction(()=>!document.getElementById('send').disabled);
 await page.evaluate(async()=>{await window.testPoll();});
 assert.equal(await page.evaluate(()=>window.testState.views),before);
 assert.equal(await page.evaluate(()=>window.testState.calls),1);
 assert.match(await page.locator('#connection').textContent(),/Pausing requests/);
 await page.screenshot({path:root+'evidence/circle-rate-limit-preview.png',fullPage:true});
 await page.evaluate(async()=>{window.testState.time=60000;window.testState.confirmed=true;await window.testPoll();});
 assert.equal(await page.locator('#body').inputValue(),'');assert.equal(await page.locator('#body').isDisabled(),false);
 assert.equal(await page.locator('#error').textContent(),'');assert.equal(await page.evaluate(()=>window.testState.calls),1);
 assert.deepEqual(errors,[]);
 const result={checkedAt:new Date().toISOString(),mode:'Synthetic wallet; zero live writes',checks:['Login rate limit pauses reads and automatically recovers','Send 429 keeps draft locked and displays pause','Status clicks during cooldown make no RPC calls','Later confirmation clears error without resubmission'],pageErrors:errors};
 writeFileSync(root+'evidence/circle-rate-limit-check.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
}finally{await browser?.close();await new Promise(r=>server.close(r));}
