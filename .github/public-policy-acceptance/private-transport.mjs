import assert from 'node:assert/strict';
import {createHash,createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
import {gzipSync,gunzipSync} from 'node:zlib';
import {mkdirSync,writeFileSync,readdirSync,lstatSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
export const pins=Object.freeze({
 'scan-evidence-1.1.0.json':[2272,'7150dd39f90539385480be110e6870c7bcd26aa21cc7b09f8facf7ce52ab027a'],
 'scan-command-1.1.0.json':[80254,'d435cca2350660b8e56b769eb76bcde9a7aef7bab7647f12679f52c53c3bb3a3'],
 'scan-evidence-1.1.1.json':[2274,'8572f0a9b236e328b99a1e2253146aca83d50e8f1b9f960ce24abd97f9ddc211'],
 'scan-command-1.1.1.json':[45394,'ba36006efd8d01c832e80de339effd6d71b40a0704426434282f75b777122fb6'],
});
export const hash=b=>createHash('sha256').update(b).digest('hex');
export function base64(value,max){
 assert(typeof value==='string'&&value.length>0&&value.length<=max&&/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value),'invalid bounded base64');
 const bytes=Buffer.from(value,'base64');assert.equal(bytes.toString('base64'),value);return bytes;
}
export function decodeScans(value){
 const raw=gunzipSync(base64(value,48*1024),{maxOutputLength:200000});
 const text=new TextDecoder('utf-8',{fatal:true}).decode(raw);assert(Buffer.from(text).equals(raw));
 const input=JSON.parse(text);assert.deepEqual(Object.keys(input).sort(),['files','format']);
 assert.equal(input.format,'aih-core061-private-scans/v1');
 assert(input.files&&typeof input.files==='object'&&!Array.isArray(input.files));
 assert.deepEqual(Object.keys(input.files).sort(),Object.keys(pins).sort());
 const entries=Object.entries(pins).map(([name,[size,digest]])=>{
  assert.equal(typeof input.files[name],'string');const bytes=Buffer.from(input.files[name],'utf8');
  assert.equal(bytes.length,size);assert.equal(hash(bytes),digest,'original scan bytes changed');return [name,bytes];
 });
 return entries; // all four validated before caller can write any bytes
}
export function writeScans(root,value){const entries=decodeScans(value);mkdirSync(root);for(const[n,b]of entries)writeFileSync(join(root,n),b,{flag:'wx'});}
export function dataKey(value){const key=base64(value,44);assert.equal(key.length,32,'AES-256 key required');return key;}
const aad=Buffer.from('aih-core061-private-evidence/v1');
export function encrypt(bytes,key){assert.equal(key.length,32);const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(aad);const ciphertext=Buffer.concat([cipher.update(bytes),cipher.final()]);return Buffer.concat([aad,Buffer.from([0]),iv,cipher.getAuthTag(),ciphertext]);}
export function decrypt(bytes,key){assert(bytes.subarray(0,aad.length).equals(aad)&&bytes[aad.length]===0);const offset=aad.length+1;const decipher=createDecipheriv('aes-256-gcm',key,bytes.subarray(offset,offset+12));decipher.setAAD(aad);decipher.setAuthTag(bytes.subarray(offset+12,offset+28));return Buffer.concat([decipher.update(bytes.subarray(offset+28)),decipher.final()]);}
export function safeArchivePath(path){assert(typeof path==='string'&&/^[A-Za-z0-9_. -]+(?:\/[A-Za-z0-9_. -]+)*$/u.test(path)&&!path.split('/').some(p=>p==='.'||p==='..'),'unsafe archive path');return path;}
export function archive(root){
 const files=[];let total=0;
 function walk(dir,prefix=''){for(const name of readdirSync(dir).sort()){
  const path=join(dir,name),rel=safeArchivePath(prefix+name),stat=lstatSync(path);assert(!stat.isSymbolicLink(),'archive symlink refused');
  if(stat.isDirectory())walk(path,rel+'/');else{assert(stat.isFile()&&stat.nlink===1&&stat.size<=128*1024*1024);total+=stat.size;assert(total<=512*1024*1024&&files.length<20000,'raw evidence archive limit');const bytes=readFileSync(path);assert.equal(bytes.length,stat.size);files.push({path:rel,sha256:hash(bytes),data:bytes.toString('base64')});}
 }}walk(root);return gzipSync(Buffer.from(JSON.stringify({format:'aih-core061-raw-files/v1',files})));
}
export function childEnvironment(env){const result={...env};for(const key of Object.keys(result))if(/^AIH_CORE061_(?:SCAN_INPUTS|EVIDENCE_KEY)$/iu.test(key))delete result[key];return result;}
