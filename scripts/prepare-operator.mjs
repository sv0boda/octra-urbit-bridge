import {generateKeyPairSync,createPublicKey,createHash} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync,existsSync,chmodSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve,dirname} from 'node:path';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const dir=resolve(root,'.private');mkdirSync(dir,{recursive:true,mode:0o700});chmodSync(dir,0o700);
const keyPath=resolve(dir,'circle-operator.pk8');
if(!existsSync(keyPath)) {
 const {privateKey}=generateKeyPairSync('ed25519');
 writeFileSync(keyPath,privateKey.export({type:'pkcs8',format:'der'}),{mode:0o600,flag:'wx'});
}
chmodSync(keyPath,0o600);
const publicKey=createPublicKey({key:readFileSync(keyPath),type:'pkcs8',format:'der'}).export({type:'spki',format:'der'}).subarray(-32);
const alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
let n=BigInt('0x'+createHash('sha256').update(publicKey).digest('hex')),encoded='';
while(n){encoded=alphabet[Number(n%58n)]+encoded;n/=58n;}
const result={network:'devnet',address:'oct'+encoded.padStart(44,'1'),publicKey:publicKey.toString('base64'),purpose:'Dedicated Circle deployment and Tlon reply publisher'};
mkdirSync(resolve(root,'config'),{recursive:true});
writeFileSync(resolve(root,'config/operator.json'),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({address:result.address,network:result.network,privateKey:'protected local file; never displayed'}));
