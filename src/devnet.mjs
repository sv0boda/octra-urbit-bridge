// Server-side only. The dedicated operator signs; browser guests use their wallet host.
import assert from 'node:assert/strict';
import {createHash, createPrivateKey, createPublicKey, sign, verify} from 'node:crypto';
import {spawn} from 'node:child_process';
import {readFileSync, writeFileSync, existsSync, openSync, closeSync, fsyncSync, mkdirSync, statSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
export const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const RPC = 'https://devnet.octrascan.io/rpc';
export const sha = value => createHash('sha256').update(value).digest('hex');
export const operator = JSON.parse(readFileSync(ROOT + 'config/operator.json', 'utf8'));
export function acquireLocalLock(name) {
  assert.match(name, /^[a-z-]+$/);
  const db = new DatabaseSync(ROOT + '.private/' + name + '-lock.sqlite');
  try {db.exec('CREATE TABLE IF NOT EXISTS mutex(id INTEGER PRIMARY KEY); BEGIN EXCLUSIVE;'); return db;}
  catch (e) {db.close(); throw new Error(`Another ${name} process holds the lock`);}
}

export function rpc(method, params = []) {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/curl', ['--fail-with-body', '-sS', '--max-time', '45',
      '-H', 'Content-Type: application/json', '--data-binary', '@-', RPC], {stdio: ['pipe', 'pipe', 'pipe']});
    let output = '', size = 0;
    child.stdout.on('data', data => {size += data.length; if (size > 4_000_000) child.kill(); else output += data;});
    child.stderr.resume();
    child.on('error', () => reject(new Error('Devnet RPC transport failed')));
    child.on('close', code => {
      if (code !== 0) return reject(new Error('Devnet RPC transport failed'));
      try {
        const reply = JSON.parse(output);
        assert.equal(reply.id, 1); assert.equal(reply.jsonrpc, '2.0');
        if (reply.error) {const e = new Error(`RPC ${method}: ${reply.error.message}`); e.code = reply.error.code; throw e;}
        resolve(reply.result);
      } catch (e) {reject(e);}
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({jsonrpc: '2.0', id: 1, method, params}));
  });
}

function key() {
  const path = ROOT + '.private/circle-operator.pk8';
  assert.equal(statSync(path).mode & 0o077, 0);
  const privateKey = createPrivateKey({key: readFileSync(path), type: 'pkcs8', format: 'der'});
  assert.equal(createPublicKey(privateKey).export({type: 'spki', format: 'der'}).subarray(-32).toString('base64'), operator.publicKey);
  return privateKey;
}
export function base58(bytes) {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = BigInt('0x' + bytes.toString('hex')), text = '', zeroes = 0;
  while (n) {text = alphabet[Number(n % 58n)] + text; n /= 58n;}
  for (const b of bytes) {if (b !== 0) break; zeroes++;}
  return '1'.repeat(zeroes) + text;
}
export function framedHash(tag, parts) {
  const hash = createHash('sha256').update(tag).update(Buffer.from([0]));
  for (const part of parts) {const b = Buffer.isBuffer(part) ? part : Buffer.from(part); const length = Buffer.alloc(4); length.writeUInt32BE(b.length); hash.update(length).update(b);}
  return hash.digest();
}
export function circleId(deployer, nonce, payload) {
  const n = Buffer.alloc(8); n.writeBigUInt64BE(BigInt(nonce));
  const payloadHash = framedHash('octra:circle_deploy_payload:v1', [JSON.stringify(payload)]).toString('hex');
  const encoded = base58(framedHash('octra:circle_deploy_id:v1', [deployer, n, payloadHash]));
  return 'oct' + (encoded || '1').repeat(44).slice(0, 44);
}
export function deploymentPayload(code) {
  return {runtime: 'octb', privacy_class: 'public', browser_mode: 'native_sealed', resource_mode: 'public_resources',
    code_b64: code.toString('base64'), policy_hash: null, members_root: null, export_policy: null,
    limits: {max_stable_bytes: '33554432', max_assets_bytes: '33554432', max_inline_value: '65536', max_wasm_bytes: '33554432'}};
}
// Current webcli canonicalization: fixed field order, raw decimal strings, integer time as float.
export function transactionText(tx, ledger = false) {
  assert.ok(Number.isSafeInteger(tx.timestamp) && tx.timestamp > 0);
  const fields = ledger ? ['from','to_','amount','nonce','ou','timestamp','signature','op_type','public_key','message','encrypted_data']
    : ['from','to_','amount','nonce','ou','timestamp','op_type', ...['encrypted_data','message'].filter(k => tx[k])];
  return '{' + fields.map(k => JSON.stringify(k) + ':' + (k === 'timestamp' ? tx.timestamp + '.0' : JSON.stringify(tx[k] ?? null).replaceAll('\x7f', '\\u007f'))).join(',') + '}';
}
export function signTransaction(tx, privateKey) {
  const canonical = Buffer.from(transactionText(tx));
  const signature = sign(null, canonical, privateKey);
  assert.ok(verify(null, canonical, createPublicKey(privateKey), signature));
  const packet = {...tx, signature: signature.toString('base64'), public_key: createPublicKey(privateKey).export({type: 'spki', format: 'der'}).subarray(-32).toString('base64')};
  return {packet, hash: sha(transactionText(packet, true))};
}
function persist(path, data) {
  const fd = openSync(path, 'wx', 0o600);
  try {writeFileSync(fd, JSON.stringify(data, null, 2) + '\n'); fsyncSync(fd);} finally {closeSync(fd);}
  const dir = openSync(ROOT + '.private/operator-outbox', 'r'); try {fsyncSync(dir);} finally {closeSync(dir);}
}
export async function submitOperation(label, {op, to, message, encryptedData = ''}, {apply = false} = {}) {
  assert.match(label, /^[a-z0-9_-]{1,100}$/);
  const fees = {deploy_circle: 200000, circle_program_update: 200000, circle_asset_put: 20000, circle_call: 1000};
  assert.ok(Object.hasOwn(fees, op));
  mkdirSync(ROOT + '.private/operator-outbox', {recursive: true, mode: 0o700});
  const path = ROOT + '.private/operator-outbox/' + label + '.json';
  const intent = sha(JSON.stringify([op, typeof to === 'function' ? 'derived' : to, message, encryptedData]));
  const lock = acquireLocalLock('operator');
  try {
    if (existsSync(path)) {
      const saved = JSON.parse(readFileSync(path, 'utf8')); assert.equal(saved.intent, intent, 'Saved operation differs');
      return {hash: saved.hash, to: saved.packet.to_, status: await rpc('octra_transaction', [saved.hash]), reused: true};
    }
    const proof = await rpc('octra_validatorSetProof'); assert.equal(proof.chain_id, 'octra-devnet-9871-cluster');
    const balance = await rpc('octra_balance', [operator.address]);
    assert.equal(balance.nonce, balance.pending_nonce, 'Operator has an unsettled transaction');
    const fee = await rpc('octra_recommendedFee', [op]);
    assert.ok(Number(fee.recommended) > 0 && Number(fee.recommended) <= fees[op], 'Fee changed; inspect before signing');
    if (op === 'circle_asset_put') {
      const bytes = Buffer.from(encryptedData, 'base64').length;
      assert.ok(bytes > 0 && bytes <= 32768, 'This publisher supports assets up to 32 KiB');
      fee.recommended = String(Math.max(Number(fee.recommended), bytes <= 4096 ? 5000 : bytes <= 16384 ? 10000 : 20000));
    }
    assert.ok(BigInt(balance.balance_raw) >= BigInt(fee.recommended));
    const nonce = Number(balance.nonce) + 1;
    const target = typeof to === 'function' ? to(nonce) : to; assert.match(target, /^oct[1-9A-HJ-NP-Za-km-z]{44}$/);
    const summary = {to: target, nonce, feeRaw: fee.recommended, op, messageSha256: sha(message)};
    if (!apply) return {...summary, status: 'prepared; unsigned'};
    const unsigned = {from: operator.address, to_: target, amount: '0', nonce, ou: String(fee.recommended), timestamp: Math.floor(Date.now()/1000), op_type: op};
    if (encryptedData) unsigned.encrypted_data = encryptedData;
    if (message) unsigned.message = message;
    const signed = signTransaction(unsigned, key());
    const fresh = await rpc('octra_balance', [operator.address]); assert.equal(fresh.pending_nonce, balance.nonce);
    persist(path, {intent, ...signed, preparedAt: new Date().toISOString()});
    persist(path + '.attempt', {hash: signed.hash, submittedAt: new Date().toISOString()});
    const response = await rpc('octra_submit', [signed.packet]);
    assert.equal(response.tx_hash, signed.hash, 'Node transaction hash differs');
    persist(path + '.response', response);
    return {...summary, hash: signed.hash, status: response.status, reused: false};
  } finally {lock.close();}
}
export async function view(circle, method, params = []) {
  const subject = method + '|' + sha(JSON.stringify(params)) + '|0';
  const fields = ['octra_circle_view', circle, operator.address, subject];
  const frame = 'octra_circle_auth_v2' + fields.map(f => '|' + Buffer.byteLength(f) + ':' + f).join('');
  const signature = sign(null, Buffer.from(frame), key()).toString('base64');
  return rpc('octra_circleViewAuth', [circle, method, params, operator.address, operator.publicKey, signature, false]);
}
