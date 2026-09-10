import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {nativeTool,hostedPaths} from './hosted-paths.mjs';
import {regularBytes,sha256} from './bytes.mjs';
import {validateQualificationReceiptForRepository} from '../../src/internals/delivery-governance.ts';
const catalog='samartomar/aih-catalog',core='samartomar/ai-harness';
export const catalogSource='98d95263aa0901504c9d480628f6c06c4a1fe453';
const priorRuns=[33162188708,34278014513,34298865399,34342417057];
const priorSources=['ea64c29471f12fd5ac1de53a72cb6edd0fc0d142','5e18dd66e42f91c30e4c5acd81d41f1e33cd987a','b019b4e9d6260915a49d177bcc22b58518305dd4','0ce02656d5e281262af2177571033449f277dc46'];
const command=(file,args,cwd)=>{const r=spawnSync(file,args,{cwd,encoding:'utf8',timeout:300000,maxBuffer:16*1024*1024,windowsHide:true});assert(!r.error&&r.status===0,'public input acquisition refused');return r.stdout;};
const positive=value=>{assert(/^[1-9][0-9]{0,14}$/u.test(value??''));return value;};
export const maxSourceBytes=8*1024*1024;
export const maxTarballBytes=64*1024*1024;
/** Transport authentication only; native provenance and live authority remain required. */
export function validateQualifiedTarball(bytes,expectedSha256){
 assert(Buffer.isBuffer(bytes)&&bytes.length>0&&bytes.length<=maxTarballBytes,'public tarball size refused');
 assert(/^[0-9a-f]{64}$/u.test(expectedSha256??'')&&!/^0+$/u.test(expectedSha256),'qualified tarball digest required');
 assert.equal(sha256(bytes),'sha256:'+expectedSha256,'qualified tarball digest mismatch');
 return bytes;
}
/** Byte transport validation only; does not confer qualification authority. */
export function validateSourceBytes(metadata,bytes,expectedSha256){
 assert.equal(metadata.type,'file');
 assert(Number.isSafeInteger(metadata.size)&&metadata.size>0&&metadata.size<=maxSourceBytes,'public source size refused');
 assert(Buffer.isBuffer(bytes)&&bytes.length===metadata.size,'public source byte length mismatch');
 assert(/^sha256:[0-9a-f]{64}$/u.test(expectedSha256));
 assert.equal(sha256(bytes),expectedSha256,'public source digest mismatch');
 return bytes;
}
export async function acquire(){
 const paths=hostedPaths(),gh=nativeTool('gh'),api=path=>JSON.parse(command(gh,['api',path]));
 const qRun=positive(process.env.AIH_QUALIFICATION_RUN),attempt=positive(process.env.AIH_QUALIFICATION_ATTEMPT),seq4Run=positive(process.env.AIH_CATALOG_RUN);
 assert(/^sha256:[0-9a-f]{64}$/u.test(process.env.AIH_QUALIFICATION_SHA256??''));
 const qdir=join(paths.raw,'public-qualification');mkdirSync(qdir);
 command(gh,['run','download',qRun,'--repo',core,'--name',`core-release-evidence-${qRun}-${attempt}`,'--dir',qdir]);
 const qualificationPath=join(qdir,'qualification.json');assert.equal(sha256(regularBytes(qualificationPath)),process.env.AIH_QUALIFICATION_SHA256);
 const q=validateQualificationReceiptForRepository(JSON.parse(regularBytes(qualificationPath)),core);assert.equal(String(q.workflow.runId),qRun);assert.equal(String(q.workflow.runAttempt),attempt);
 assert.equal(q.package.name,'@aihq/core');assert.equal(q.package.version,'0.6.1');assert.equal(q.source.tag,'v-core-0.6.1');assert.equal(q.workflow.revision,q.source.sha);
 mkdirSync(paths.receipts);
 for(let sequence=0;sequence<=4;sequence++){
  const runId=sequence<4?String(priorRuns[sequence]):seq4Run,source=sequence<4?priorSources[sequence]:catalogSource;
  const run=api(`repos/${catalog}/actions/runs/${runId}`);assert.equal(run.head_sha,source);assert.equal(run.head_branch,'main');assert.equal(run.event,'workflow_dispatch');assert.equal(run.path,'.github/workflows/signed-catalog-v2.yml');assert.equal(run.conclusion,'success');assert.equal(run.status,'completed');
  const dest=join(paths.receipts,`seq${sequence}`);mkdirSync(dest);
  command(gh,['run','download',runId,'--repo',catalog,'--name','signed-catalog-v2','--dir',dest]);
 }
 mkdirSync(paths.candidate);
 function sourceFile(remote,local,expectedSha256){
  assert(/^[a-zA-Z0-9._/-]+$/u.test(remote)&&!remote.includes('..'));
  const endpoint=`repos/${catalog}/contents/${remote}?ref=${catalogSource}`,metadata=api(endpoint);
  assert.equal(metadata.type,'file');assert(Number.isSafeInteger(metadata.size)&&metadata.size>0&&metadata.size<=maxSourceBytes,'public source size refused');
  // Contents JSON omits content above 1 MiB. Native raw media preserves the
  // exact bytes at the same immutable commit without trusting download_url.
  const result=spawnSync(gh,['api',endpoint,'--header','Accept: application/vnd.github.raw+json'],{encoding:null,timeout:300000,maxBuffer:maxSourceBytes,windowsHide:true});
  assert(!result.error&&result.status===0,'immutable raw public source acquisition refused');
  const bytes=validateSourceBytes(metadata,result.stdout,expectedSha256);
  mkdirSync(dirname(local),{recursive:true});writeFileSync(local,bytes,{flag:'wx'});
 }
 const candidatePath=join(paths.candidate,'unsigned-candidate-seq4.json');sourceFile('catalog/workbench-core061-npm-2026-09-09/unsigned-candidate-seq4.json',candidatePath,'sha256:6423cf2a8795d5d76ca481bc6718de8425245f99701514a63e7dc415a25184d2');
 assert.equal(sha256(regularBytes(candidatePath)),'sha256:6423cf2a8795d5d76ca481bc6718de8425245f99701514a63e7dc415a25184d2');
 const candidate=JSON.parse(regularBytes(candidatePath)),entry=candidate.entries.find(x=>x.entryId==='package.picocolors');assert(entry);
 for(const row of [...entry.qualification.gaps,entry.qualification.report,...entry.qualification.rights]){
  assert(/^evidence:(?:gap|report|right):evidence\/[a-z0-9.-]+\.json$/u.test(row.identity));const path='defaults/workbench/npm/package.picocolors/'+row.identity.split(':').at(-1);sourceFile(path,join(paths.candidate,path),'sha256:'+row.sha256);assert.equal(sha256(regularBytes(join(paths.candidate,path))),'sha256:'+row.sha256);
 }
 const url='https://registry.npmjs.org/@aihq/core/-/core-0.6.1.tgz';
 const response=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(30000)});assert(response.ok&&response.url===url&&response.body);const chunks=[];let size=0;for await(const chunk of response.body){size+=chunk.length;assert(size<=maxTarballBytes);chunks.push(chunk);}
 // Persist only the exact digest in the hash-bound, schema-validated qualification.
 // The destination is fixed in private staging; nothing is extracted or executed here.
 const tarballBytes=validateQualifiedTarball(Buffer.concat(chunks),q.artifact.tarballSha256);
 const coreTarball=join(paths.raw,'core-0.6.1.tgz');writeFileSync(coreTarball,tarballBytes,{flag:'wx',mode:0o600});
 // Scripts-disabled install of genuine registry version, independently compared with retained tar by original validator.
 const consumer=join(paths.root,'consumer');mkdirSync(consumer);writeFileSync(join(consumer,'package.json'),JSON.stringify({name:'aih-public-acceptance-consumer',version:'1.0.0',private:true}));
 const npmCli=join(dirname(process.execPath),'node_modules/npm/bin/npm-cli.js');regularBytes(npmCli);
 command(process.execPath,[npmCli,'install','--ignore-scripts','--no-audit','--no-fund','--save-exact','--registry=https://registry.npmjs.org/','@aihq/core@0.6.1'],consumer);
 const input={qualificationPath,qualificationSha256:process.env.AIH_QUALIFICATION_SHA256,coreTarball,corePackageRoot:join(consumer,'node_modules/@aihq/core'),seq4Receipt:join(paths.receipts,'seq4','receipts','package.picocolors.json'),seq4SourceSha:catalogSource};
 const inputPath=join(paths.raw,'inputs.json');writeFileSync(inputPath,JSON.stringify(input));return inputPath;
}
