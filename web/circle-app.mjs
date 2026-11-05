const el = id => document.getElementById(id);
const node = (tag, cls, text) => {const e = document.createElement(tag); e.className = cls; e.textContent = text; return e;};
let transport, address, parent = 0, polling = false, pending = null, busy = false, timer, sendError = '', connecting = false, receipt = null, sendStage = '', slowTimer;
const bridge = window.OctraCircle;
// Set a display boundary at build time if an operator has cleared old test records.
const visibleAfter = 0;
function startPolling(){if(!timer)timer=setInterval(()=>{if(!busy && !document.hidden)return refresh();},20000);}
function render(messages) {
  const feed = el('messages'), nearBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 100;
  feed.replaceChildren();
  if (!messages.length) feed.append(node('div','empty','Be the first to say hello.'));
  for (const m of messages) {
    const article = node('article', m.parent ? 'reply' : '', '');
    const byline = node('div','byline','');
    byline.append(node('strong','',m.nickname), node('span','source',m.kind === 2 ? 'URBIT' : `OCTRA · ${m.author.slice(-6)}`));
    article.append(byline);
    if (m.parent) article.append(node('div','reply-context',`Reply to message #${m.parent}`));
    article.append(node('div','body',m.body));
    if (m.reactions?.length) {
      const reactions = node('div','reactions','');reactions.setAttribute('aria-label','Reactions from Tlon');
      for (const [emoji,count] of m.reactions) {
        const badge = node('span','reaction',`${emoji} ${count}`);
        badge.title=`${count} ${count === 1 ? 'reaction' : 'reactions'} from Tlon`;
        badge.setAttribute('aria-label',`${emoji}: ${count} ${count === 1 ? 'reaction' : 'reactions'} from Tlon`);
        reactions.append(badge);
      }
      article.append(reactions);
    }
    const footer = node('div','byline','');
    const labels = {'from-tlon':'From Tlon',delivered:'Delivered to Tlon','awaiting-tlon':'Confirmed · waiting for Tlon'};
    footer.append(node('span','delivery',labels[m.status]));
    const button = node('button','reply-button','Reply');
    button.onclick = () => {if(busy || pending)return;parent=m.parent || m.id;showReply(m.nickname);el('body').focus();};
    footer.append(button); article.append(footer); feed.append(article);
  }
  if (nearBottom) feed.scrollTop = feed.scrollHeight;
}
function showReply(name) {
  el('replying').replaceChildren(node('span','',`Replying to ${name} `));
  const cancel=node('button','reply-button','Cancel reply');cancel.onclick=()=>{parent=0;el('replying').classList.add('hidden');};
  el('replying').append(cancel);el('replying').classList.remove('hidden');
}
function lockComposer(locked) {
  for (const id of ['body','nickname']) el(id).disabled = locked;
  el('replying').inert = locked;
  el('composer').setAttribute('aria-busy', String(locked));
}
function showProgress(stage, detail) {
  sendStage = stage;
  const labels = {checking:'Checking this message…', wallet:'Waiting for wallet approval…',
    submitted:'Transaction submitted', unknown:'Checking submission status',
    confirmed:'Message confirmed on devnet', delivered:'Delivered to Tlon', cancelled:'Sending cancelled', failed:'Message not submitted'};
  el('notice').textContent = labels[stage] || detail;
  el('send-detail').textContent = detail || '';
  el('send-progress').classList.remove('hidden');
  el('send-progress').dataset.stage = stage;
  if (stage === 'checking') el('send-progress').scrollIntoView({block:'nearest',behavior:'smooth'});
  el('send-progress').setAttribute('aria-busy', String(['checking','wallet','submitted','unknown','confirmed'].includes(stage)));
  const completed = {checking:0,wallet:0,submitted:1,unknown:0,confirmed:2,delivered:3,cancelled:0,failed:0}[stage];
  for (const [i, item] of [...el('send-steps').children].entries()) {
    item.classList.toggle('done', i < completed);
    item.classList.toggle('current', i === completed && completed < 3 && !['cancelled','failed'].includes(stage));
  }
  clearTimeout(slowTimer);
  if (['submitted','unknown','confirmed'].includes(stage)) slowTimer=setTimeout(()=>{
    if (sendStage !== stage) return;
    el('send-detail').textContent = stage === 'confirmed'
      ? 'Your message is on devnet. We are still waiting for Tlon delivery; you do not need to send it again.'
      : 'Still checking. Confirmation is taking longer. Keep this page open, or check your wallet transaction history. Check status never submits a payment.';
  },30000);
}
function transactionReceipt(submission) {
  const hash = submission?.tx_hash;
  if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/i.test(hash)) return false;
  const url = 'https://devnet.octrascan.io/tx.html?hash=' + hash;
  el('transaction-link').href=url;
  el('transaction-url').value=url;
  el('transaction').classList.remove('hidden');
  return true;
}
function confirmMessage(message) {
  if (pending) {
    receipt = {id:message.id};pending=null;sendError='';el('error').textContent='';
    el('body').value='';parent=0;el('replying').classList.add('hidden');lockComposer(false);
    el('send').textContent='Send message';el('send').disabled=busy;
  }
  showProgress(message.status === 'delivered' ? 'delivered' : 'confirmed',
    message.status === 'delivered' ? 'Your message has reached the Urbit room.' : 'Waiting for the bridge to deliver it to Tlon. You can write another message.');
}
async function refresh() {
  if(polling || !transport)return;polling=true;
  try{
    // Resolve the send first, before reading the rest of the room.
    if (pending && !busy) {
      const found = await transport.check(pending.requestId);
      if (found) confirmMessage(found);
    }
    const room=await transport.read({limit:50,progress:connecting ? text=>{el('connection').textContent=text;el('login-help').textContent=text;} : undefined});
    address=room.address;el('wallet').title=address;el('wallet').textContent=`${address.slice(0,9)}…${address.slice(-6)}`;
    if(!el('nickname').value)el('nickname').value=room.nickname || 'Guest '+address.slice(-4);
    render(room.messages);
    el('composer').classList.remove('hidden');el('messages').classList.remove('hidden');el('entry').classList.add('hidden');el('entry-foot').classList.add('hidden');el('connect').classList.add('hidden');el('login-help').classList.add('hidden');
    startPolling();
    if (receipt && !pending && !busy && sendStage !== 'delivered') {
      const message = room.messages.find(m=>m.id===receipt.id) || await transport.message(receipt.id);
      confirmMessage(message);
    }
    el('error').textContent=sendError;
    el('connection').textContent='Bridge chat · connected';el('room-state').textContent='Connected';el('room-state').classList.add('online');
    return true;
  }catch(e){if(e.code==='RATE_LIMITED')startPolling();el('error').textContent=[sendError,e.message].filter(Boolean).join('\n');el('connection').textContent=e.code==='RATE_LIMITED'?'Devnet is busy. Pausing requests; checking again automatically…':'Connection interrupted. Checking again shortly…';el('room-state').textContent=e.code==='RATE_LIMITED'?'Rate limited':'Reconnecting…';el('room-state').classList.remove('online');return false;}
  finally{polling=false;}
}
el('connect').onclick=async()=>{
  if(connecting)return;connecting=true;el('connect').disabled=true;el('connect').textContent='Connecting…';
  el('error').textContent='';el('connection').textContent='Connecting your wallet…';el('room-state').textContent='Connecting…';
  el('login-help').textContent='The wallet asks separately for your address and access to room data. Neither permission sends a payment.';
  try{
    transport ??= queueTransport({bridge,visibleAfter});
    await refresh();
  }catch(e){el('error').textContent=e.message;el('connection').textContent='Room not connected. You can try again.';el('room-state').textContent='Not connected';el('room-state').classList.remove('online');}
  finally{connecting=false;el('connect').disabled=false;el('connect').textContent='Enter with Octra wallet';}
};
el('transaction-url').onclick=()=>el('transaction-url').select();
el('send').onclick=async()=>{
  if(busy)return;
  // Status checks are strictly read-only, even after a timeout or missing receipt.
  if(pending){
    el('send').disabled=true;el('send').textContent='Checking status…';
    try{while(polling)await new Promise(r=>setTimeout(r,50));await refresh();}finally{el('send').disabled=false;el('send').textContent=pending?'Check status':'Send message';}
    return;
  }
  busy=true;el('send').disabled=true;el('send').textContent='Preparing…';sendError='';el('error').textContent='';receipt=null;
  el('transaction').classList.add('hidden');lockComposer(true);
  let walletStarted=false;
  try{
    const body=el('body').value.trim().normalize('NFC'),nickname=el('nickname').value.trim().normalize('NFC');
    const input=JSON.stringify([bridge.context?.circle_id,visibleAfter,address,nickname,body,parent]);
    // Stable content IDs recover confirmed messages after leaving/reopening the Circle.
    const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(input));
    const requestId=Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
    pending={body,nickname,parent,requestId};
    showProgress('checking','Checking whether this message is already confirmed.');
    const result=await transport.send(pending,()=>{
      walletStarted=true;el('send').textContent='Waiting for wallet…';
      showProgress('wallet','In the wallet: enter 0 for the amount and Continue, then enter your PIN and Sign. Keep this page open.');
    });
    if(result.state==='confirmed')confirmMessage(result.message);
    else if(transactionReceipt(result.submission))showProgress('submitted','Your wallet returned a transaction receipt. Waiting for devnet confirmation; we will check automatically.');
    else showProgress('unknown','The wallet did not return a transaction receipt. We are checking whether your message was confirmed. Do not sign it again yet.');
  }catch(e){
    sendError=e.message;el('error').textContent=sendError;
    // Only explicit pre-submission cancellation/denial is safe to unlock immediately.
    if(e.code==='NOT_SUBMITTED'){
      pending=null;lockComposer(false);showProgress('failed','The wallet could not read your account counter. It stopped before signing or submitting. Your draft is saved; wait at least 30 seconds before trying again.');
    }else if(!walletStarted || /^(program call cancelled|runtime access denied: program.call)$/.test(e.message)){
      pending=null;lockComposer(false);showProgress('cancelled','Your draft is kept. No transaction was submitted by this attempt.');
    }else showProgress('unknown','Submission could not be verified. Your draft is locked while we check for confirmation. Check status never sends another transaction.');
  }finally{
    busy=false;el('send').disabled=false;el('send').textContent=pending?'Check status':'Send message';
  }
  await refresh();
};
