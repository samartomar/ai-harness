import {mkdtempSync,mkdirSync,writeFileSync,openSync,closeSync,existsSync,readdirSync,lstatSync,appendFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import {assertFreshHost} from './host-guard.mjs';
import {dataKey,writeScans,childEnvironment,archive,encrypt,hash} from './private-transport.mjs';
import {regularBytes} from './bytes.mjs';
export function completion(status,marker){return status===0&&marker===true;}
const outputNames=Object.freeze({encrypted_evidence:'raw-evidence.aes256gcm',ciphertext_digest:'ciphertext.sha256',public_summary:'summary.json'});
export function createEvidenceOutput(parent){return mkdtempSync(join(parent,'aih-public-acceptance-output-'));}
export function writeEvidenceOutput(directory,name,bytes){
 assert(Object.values(outputNames).includes(name),'unexpected public output name');
 const fd=openSync(join(directory,name),'wx',0o600);
 try{writeFileSync(fd,bytes);}finally{closeSync(fd);}
}
function publishOutputPaths(directory){
 assert(process.env.GITHUB_OUTPUT,'runner output channel required');
 const lines=Object.entries(outputNames).map(([name,file])=>{const path=join(directory,file);assert(!/[\r\n]/u.test(path),'invalid output path');return `${name}=${path}\n`;}).join('');
 appendFileSync(process.env.GITHUB_OUTPUT,lines);
}
function retainFinalCustody(destination){
 const custody='C:/ProgramData/aih/supported-qualification/v2';
 if(!existsSync(custody))return;
 let count=0;
 function copy(source,target){assert(lstatSync(source).isDirectory()&&!lstatSync(source).isSymbolicLink());mkdirSync(target);for(const name of readdirSync(source)){
  assert(++count<=20000);const from=join(source,name),to=join(target,name),stat=lstatSync(from);assert(!stat.isSymbolicLink(),'custody link refused');
  if(stat.isDirectory())copy(from,to);else{assert(stat.isFile());writeFileSync(to,regularBytes(from,128*1024*1024),{flag:'wx',mode:0o600});}
 }}copy(custody,destination);
}
export function run(){
 let root,key,output,passed=false,retained=false;
 const bundle=process.env.AIH_CORE061_SCAN_INPUTS,keyText=process.env.AIH_CORE061_EVIDENCE_KEY;
 delete process.env.AIH_CORE061_SCAN_INPUTS;delete process.env.AIH_CORE061_EVIDENCE_KEY;
 try{
  assertFreshHost();key=dataKey(keyText);output=createEvidenceOutput(process.env.RUNNER_TEMP??tmpdir());
  root=mkdtempSync(join(tmpdir(),'aih-hosted-core061-'));mkdirSync(join(root,'raw'));
  writeScans(join(root,'raw','scans'),bundle);
  const stdout=openSync(join(root,'raw','driver.stdout'),'wx'),stderr=openSync(join(root,'raw','driver.stderr'),'wx');
  let result;
  try{result=spawnSync(process.execPath,['--import','tsx','--import',pathToFileURL(join(import.meta.dirname,'capture-runtime.mjs')).href,join(import.meta.dirname,'hosted-child.mjs')],{cwd:process.env.GITHUB_WORKSPACE,env:{...childEnvironment(process.env),AIH_HOSTED_ROOT:root},stdio:['ignore',stdout,stderr],windowsHide:true,timeout:45*60*1000});}
  finally{closeSync(stdout);closeSync(stderr);}
  writeFileSync(join(root,'raw','child-exit.json'),JSON.stringify({status:result.status,signal:result.signal,error:result.error?.stack}),{flag:'wx',mode:0o600});
  retainFinalCustody(join(root,'raw','final-supported-custody'));
  const marker=join(root,'raw','all-journeys-complete.json');
  passed=completion(result.status,existsSync(marker));
 }catch(error){if(root)writeFileSync(join(root,'raw','failure.txt'),String(error.stack??error),{flag:'wx',mode:0o600});}
 finally{
  if(root&&key){try{const encrypted=encrypt(archive(join(root,'raw')),key);writeEvidenceOutput(output,'raw-evidence.aes256gcm',encrypted);writeEvidenceOutput(output,'ciphertext.sha256',hash(encrypted)+'\n');retained=true;}catch{passed=false;}key.fill(0);}
  passed=passed&&retained;
  if(output){try{writeEvidenceOutput(output,'summary.json',JSON.stringify({format:'aih-core061-hosted-public-summary/v1',version:'0.6.1',status:passed?'passed':'failed',encryptedEvidenceRetained:retained,journeys:passed?['832','managed','848']:[]}));publishOutputPaths(output);}catch{passed=false;}}
  console.log(passed?'PUBLIC_ACCEPTANCE_PASSED':'PUBLIC_ACCEPTANCE_FAILED');
  process.exitCode=passed?0:1;
 }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)run();
