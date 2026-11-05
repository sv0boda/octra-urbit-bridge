import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {ROOT, rpc, operator, circleId, deploymentPayload, submitOperation, view, sha} from '../src/devnet.mjs';
const [command, arg, paramsText = '[]'] = process.argv.slice(2).filter(a => a !== '--apply');
const apply = process.argv.includes('--apply');
mkdirSync(ROOT+'evidence',{recursive:true});
const config = JSON.parse(readFileSync(ROOT + 'config/target.json', 'utf8'));
try {
  let result;
  if (command === 'deploy') {
    const code = readFileSync(ROOT + 'build/queue.octb'), payload = deploymentPayload(code);
    result = await submitOperation('queue-deploy-v1', {op: 'deploy_circle', to: nonce => circleId(operator.address, nonce, payload), message: JSON.stringify(payload)}, {apply});
    if (result.hash) writeFileSync(ROOT + 'evidence/circle-deployment.json', JSON.stringify({...result, bytecodeSha256: sha(code)}, null, 2) + '\n');
  } else if (command === 'update-program') {
    if (!config.circleId) throw new Error('Circle not verified');
    const code=readFileSync(ROOT+'build/queue.octb');
    result=await submitOperation('program-'+sha(code).slice(0,24), {op:'circle_program_update',to:config.circleId,message:JSON.stringify({code_b64:code.toString('base64')})}, {apply});
    if(result.hash)writeFileSync(ROOT+'evidence/circle-program-update.json',JSON.stringify({...result,bytecodeSha256:sha(code)},null,2)+'\n');
  } else if (command === 'status') {
    const deployment = JSON.parse(readFileSync(ROOT + 'evidence/circle-deployment.json', 'utf8'));
    result = {transaction: await rpc('octra_transaction', [deployment.hash]), circle: await rpc('circle_info', [deployment.to])};
    if (result.transaction.status === 'confirmed') {
      result.bridge = await view(deployment.to, 'get_bridge');
      result.head = await view(deployment.to, 'get_head');
      if (result.bridge.result !== operator.address) throw new Error('Deployed bridge identity mismatch');
      config.circleId = deployment.to;
      writeFileSync(ROOT + 'config/target.json', JSON.stringify(config, null, 2) + '\n');
      writeFileSync(ROOT + 'evidence/circle-deployment-confirmed.json', JSON.stringify(result, null, 2) + '\n');
    }
  } else if (command === 'upload') {
    if (!config.circleId) throw new Error('Circle not verified');
    const html = readFileSync(ROOT + 'build/index.html');
    result = await submitOperation('ui-' + sha(html).slice(0, 16), {op: 'circle_asset_put', to: config.circleId,
      message: JSON.stringify({path: '/index.html', content_type: 'text/html; charset=utf-8', encoding: 'identity'}),
      encryptedData: html.toString('base64')}, {apply});
    if (result.hash) writeFileSync(ROOT + 'evidence/circle-ui-upload.json', JSON.stringify({...result, sha256: sha(html)}, null, 2) + '\n');
  } else if (command === 'asset-status') {
    const asset = await rpc('circle_asset', [config.circleId, '/index.html']);
    const actual = sha(Buffer.from(asset.body_b64, 'base64'));
    if (actual !== sha(readFileSync(ROOT + 'build/index.html'))) throw new Error('Published UI hash mismatch');
    result = {circleId: config.circleId, path: asset.canonical_path, sha256: actual, bytes: asset.size_bytes, verified: true};
    writeFileSync(ROOT + 'evidence/circle-ui-confirmed.json', JSON.stringify(result, null, 2) + '\n');
  } else if (command === 'view') {
    if (!config.circleId) throw new Error('Circle not verified');
    result = await view(config.circleId, arg, JSON.parse(paramsText));
  } else if (command === 'call') {
    if (!config.circleId) throw new Error('Circle not verified');
    const spec = JSON.parse(readFileSync(arg, 'utf8'));
    result = await submitOperation(spec.label, {op: 'circle_call', to: config.circleId, message: JSON.stringify(spec.params), encryptedData: spec.method}, {apply});
  } else throw new Error('Use deploy, update-program, upload, status, asset-status, view METHOD PARAMS, or call SPEC.json');
  if (result?.transaction) delete result.transaction.message;
  console.log(JSON.stringify(result, null, 2));
} catch (e) {console.error(e.message); process.exitCode = 1;}
