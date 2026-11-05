import {readFileSync,writeFileSync,renameSync,statSync,mkdirSync} from 'node:fs';
import {ROOT,operator,rpc,view,submitOperation,acquireLocalLock} from '../src/devnet.mjs';
import {RoomStore} from '../src/store.mjs';
import {EyreTlon} from '../src/eyre.mjs';
import {Gateway} from '../src/gateway.mjs';
import {decodeQueueMessage} from '../shared/queue-message.mjs';

process.umask(0o077);
const config=JSON.parse(readFileSync(ROOT+'config/target.json','utf8'));
if(config.postingEnabled!==true)throw new Error('Set postingEnabled only after verifying your target group and Circle');
mkdirSync(ROOT+'evidence',{recursive:true});
if(!config.circleId || !config.gatewayMoon)throw new Error('Verified Circle and gateway moon required');
const lock=acquireLocalLock('gateway');
const store=new RoomStore(ROOT+'.private/gateway.sqlite',{rateLimit:10000});
let stop=false;
process.on('SIGTERM',()=>{stop=true;});process.on('SIGINT',()=>{stop=true;});
const origin=config.moonOrigin || 'http://127.0.0.1:8080';
const codePath=ROOT+'.private/moon-web-login.txt';
let gateway;
async function connect(){
  if(statSync(codePath).mode&0o077)throw new Error('Moon credential permissions too broad');
  const response=await fetch(origin+'/~/login',{method:'POST',redirect:'manual',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({password:readFileSync(codePath,'utf8').trim()}),signal:AbortSignal.timeout(30000)});
  const cookie=response.headers.getSetCookie().map(v=>v.split(';')[0]).find(v=>v.startsWith(`urbauth-${config.gatewayMoon}=`));await response.body?.cancel();
  if(!cookie)throw new Error('Moon login failed');
  const tlon=new EyreTlon({url:origin,ship:config.gatewayMoon,nest:config.channel,cookie,allowWrites:true,timeoutMs:45000});
  const session=await tlon.request('/session.js');
  if((await session.text()).trim()!==`window.ship = "${config.gatewayMoon.slice(1)}";`)throw new Error('Unexpected ship');
  const bridge=await view(config.circleId,'get_bridge');if(bridge.result!==operator.address)throw new Error('Unexpected Circle operator');
  const chain={
    head:async()=> (await view(config.circleId,'get_head')).result,
    message:async id=>decodeQueueMessage(id,(await view(config.circleId,'get_message',[id])).result),
    reactions:async()=>({revision:(await view(config.circleId,'get_reaction_revision')).result,snapshot:(await view(config.circleId,'get_reactions')).result}),
    call:async(label,method,params)=>{
      const balance=await rpc('octra_balance',[operator.address]);
      if(balance.nonce!==balance.pending_nonce)throw Object.assign(new Error('Waiting for operator transaction confirmation'),{code:'CONFIRMATION_PENDING'});
      return submitOperation(label,{op:'circle_call',to:config.circleId,message:JSON.stringify(params),encryptedData:method},{apply:true});
    }
  };
  gateway=new Gateway({store,tlon,chain,ship:config.gatewayMoon,nest:config.channel});
}
function record(state){const result={checkedAt:new Date().toISOString(),circle:config.circleId,moon:config.gatewayMoon,...state};const path=ROOT+'evidence/gateway-status.json';writeFileSync(path+'.tmp',JSON.stringify(result,null,2)+'\n');renameSync(path+'.tmp',path);console.log(JSON.stringify(result));}
try{
  do{
    try{if(!gateway)await connect();record({ok:true,...await gateway.tick()});}
    catch(e){
      if(e.code==='CONFIRMATION_PENDING')record({ok:true,action:'waiting-for-confirmation'});
      else {record({ok:false,error:e.message});gateway=undefined;if(process.argv.includes('--once'))process.exitCode=1;}
    }
    if(process.argv.includes('--once'))break;
    for(let i=0;i<15&&!stop;i++)await new Promise(r=>setTimeout(r,1000));
  }while(!stop);
}finally{store.close();lock.close();}
