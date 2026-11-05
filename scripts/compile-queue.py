#!/usr/bin/env python3
"""Read-only devnet compilation, using curl for compatibility with its public edge."""
import base64, hashlib, json, subprocess
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
(ROOT/'evidence').mkdir(exist_ok=True)
operator=json.loads((ROOT/'config/operator.json').read_text())
source=(ROOT/'program/queue.aml.in').read_text().replace('__BRIDGE_ADDRESS__',operator['address'])
build=ROOT/'build';build.mkdir(exist_ok=True)
(build/'queue.aml').write_text(source)
request=json.dumps({'jsonrpc':'2.0','id':1,'method':'octra_compileAml','params':[source,True]})
response=subprocess.run(['curl','--fail-with-body','-sS','--max-time','60','-H','Content-Type: application/json','--data-binary','@-','https://devnet.octrascan.io/rpc'],input=request,text=True,capture_output=True)
if response.returncode:raise SystemExit('Compilation HTTP request failed')
result=json.loads(response.stdout)
if 'error' in result:print(json.dumps(result['error']));raise SystemExit(1)
result=result['result'];bytecode=base64.b64decode(result['bytecode'],validate=True)
(build/'queue-compiled.json').write_text(json.dumps(result,indent=2)+'\n')
(build/'queue.disasm').write_text(result['disasm']+'\n')
(build/'queue.octb').write_bytes(bytecode)
receipt={'sourceSha256':hashlib.sha256(source.encode()).hexdigest(),'bytecodeSha256':hashlib.sha256(bytecode).hexdigest(),'bytes':len(bytecode),'instructions':result['instructions'],'compiler':result['version'],'operator':operator['address'],'submittedTransactions':0}
(ROOT/'evidence/queue-compilation.json').write_text(json.dumps(receipt,indent=2)+'\n')
print(json.dumps(receipt,indent=2))
