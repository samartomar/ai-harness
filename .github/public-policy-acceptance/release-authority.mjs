import {nativeTool,hostedPaths} from './hosted-paths.mjs';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,realpathSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join,resolve,isAbsolute,relative,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {validatePublicInputs,identity} from './validate-public-inputs.mjs';
import {regularBytes,sha256,compareInstalledTarball} from './bytes.mjs';
import {readPublicReceiptInputs,verifyPublicReceiptAttestations} from './public-receipt-inputs.mjs';
import {readCandidateQualification} from './policy-authoring.mjs';
import {evidenceSha256} from '../../src/internals/delivery-governance.ts';
const trusted=new WeakMap();
const gh=nativeTool('gh');
const repository='samartomar/ai-harness';
const command=(file,args,cwd)=>{const r=spawnSync(file,args,{cwd,encoding:'utf8',timeout:300000,maxBuffer:16*1024*1024,windowsHide:true});assert(!r.error&&r.status===0,`native command refused: ${args[0]}`);return r.stdout;};
const api=path=>JSON.parse(command(gh,['api',path]));
export function assertAuthorized(context){assert(trusted.has(context),'live public authority context required; no injected context accepted');}
export async function recheck(context){
 assertAuthorized(context);const state=trusted.get(context);
 assert.equal(sha256(regularBytes(context.input.qualificationPath)),context.input.qualificationSha256);
 compareInstalledTarball(context.input.coreTarball,context.input.corePackageRoot,context.binding.core.tarballSha256);
 for(const [v,e,c]of state.expected){assert.equal(sha256(regularBytes(join(context.scanRoot,`scan-evidence-${v}.json`))),'sha256:'+e);assert.equal(sha256(regularBytes(join(context.scanRoot,`scan-command-${v}.json`))),'sha256:'+c);}
 for(const record of state.records)assert(regularBytes(record.path,5970).equals(record.bytes),'receipt changed');
 const pages=JSON.parse(command(gh,['api',`repos/${repository}/issues/${state.q.tracker.issueNumber}/comments?per_page=100`,'--paginate','--slurp']));
 const prefix=`AIH-CANDIDATE-STATE-V1 sha256:${evidenceSha256(state.q)} `;
 for(const row of pages.flat())if(row.user?.login?.toLowerCase()===repository.split('/')[0])for(const line of String(row.body??'').split(/\r?\n/u))assert(![prefix+'rejected',prefix+'superseded'].includes(line.trim()),'candidate invalidated');
}
export async function authorizePublic(input,scanRoot){
 assert.equal(process.platform,'win32','reviewed runner requires Windows administrator host');
 const binding=await validatePublicInputs(input); // genuine seq4 presence and live registry byte equality first; no effects.
 const q=JSON.parse(regularBytes(input.qualificationPath));
 const run=api(`repos/${repository}/actions/runs/${q.workflow.runId}/attempts/${q.workflow.runAttempt}`);
 assert.equal(run.head_sha,q.source.sha);assert.equal(run.event,'push');assert.equal(run.conclusion,'success');assert.equal(run.status,'completed');assert.equal(run.path,'.github/workflows/release.yml');assert.equal(run.run_attempt,q.workflow.runAttempt);
 const tagRef=api(`repos/${repository}/git/ref/tags/${identity.tag}`);assert.equal(tagRef.object.type,'tag');assert.equal(tagRef.object.sha,q.source.tagObject);
 const tag=api(`repos/${repository}/git/tags/${q.source.tagObject}`);assert.equal(tag.object.type,'commit');assert.equal(tag.object.sha,q.source.sha);
 const ancestry=api(`repos/${repository}/compare/${q.source.sha}...main`);assert.equal(ancestry.merge_base_commit.sha,q.source.sha,'qualified source is not main ancestor');
 const ci=api(`repos/${repository}/actions/runs/${q.protectedMainCi.runId}`);assert.equal(ci.head_sha,q.source.sha);assert.equal(ci.head_branch,'main');assert.equal(ci.event,'push');assert.equal(ci.conclusion,'success');assert.equal(ci.path,'.github/workflows/ci.yml');
 // Native GitHub verifies the retained tar itself before installed release code may be imported or run.
 const attestation=JSON.parse(command(gh,['attestation','verify',input.coreTarball,'--repo',repository,'--signer-workflow',repository+'/.github/workflows/release.yml','--source-digest',q.source.sha,'--source-ref','refs/tags/'+identity.tag,'--deny-self-hosted-runners','--format','json']));
 assert(Array.isArray(attestation)&&attestation.length>0,'tar provenance absent');
 const core=await import(pathToFileURL(join(input.corePackageRoot,'dist/index.js')).href);
 const records=readPublicReceiptInputs({core,seq4Path:input.seq4Receipt,seq4SourceSha:input.seq4SourceSha,root:hostedPaths().receipts});
 for(const row of records)assert(Date.parse(row.receipt.notBefore)<=Date.now()&&Date.now()<Date.parse(row.receipt.expiresAt),'public receipt not current');
 verifyPublicReceiptAttestations(records,gh);
 readCandidateQualification(hostedPaths().candidate,records[4].receipt);
 assert(isAbsolute(scanRoot),'absolute retained scan root required');
 // Existing actual scan provenance is retained, never relabeled as newly executed release scanning.
 const expected=[['1.1.0','7150dd39f90539385480be110e6870c7bcd26aa21cc7b09f8facf7ce52ab027a','d435cca2350660b8e56b769eb76bcde9a7aef7bab7647f12679f52c53c3bb3a3'],['1.1.1','8572f0a9b236e328b99a1e2253146aca83d50e8f1b9f960ce24abd97f9ddc211','ba36006efd8d01c832e80de339effd6d71b40a0704426434282f75b777122fb6']];
 for(const [v,e,c]of expected){assert.equal(sha256(regularBytes(join(scanRoot,`scan-evidence-${v}.json`))),'sha256:'+e);assert.equal(sha256(regularBytes(join(scanRoot,`scan-command-${v}.json`))),'sha256:'+c);}
 const consumer=realpathSync.native(resolve(input.corePackageRoot,'../../..'));
 const tempRelative=relative(realpathSync.native(tmpdir()),consumer);assert(tempRelative&&tempRelative!=='..'&&!tempRelative.startsWith('..'+sep)&&!isAbsolute(tempRelative),'public installed consumer must be disposable under the temporary root');
 assert(!existsSync('C:/ProgramData/aih/supported-qualification/v2'),'preserve existing protected custody; clean disposable host required');
 assert.equal(realpathSync.native(join(consumer,'node_modules/@aihq/core')),realpathSync.native(input.corePackageRoot),'standard installed consumer required');
 const npmCli=join(dirname(process.execPath),'node_modules/npm/bin/npm-cli.js');regularBytes(npmCli);
 // Only local evidence staging starts here; never protected custody. Qualification is fetched from its exact successful native run.
 const evidenceRoot=mkdtempSync(join(hostedPaths().raw,'authority-'));
 // Exact, identity-checked public JSON is inert retained evidence at a fixed path.
 writeFileSync(join(evidenceRoot,'registry-metadata.json'),binding.registryMetadataJson,{flag:'wx',mode:0o600});
 const qualificationDir=join(evidenceRoot,'qualification');mkdirSync(qualificationDir);
 command(gh,['run','download',String(q.workflow.runId),'--repo',repository,'--name',`core-release-evidence-${q.workflow.runId}-${q.workflow.runAttempt}`,'--dir',qualificationDir]);
 assert(regularBytes(join(qualificationDir,'qualification.json')).equals(regularBytes(input.qualificationPath)),'qualification differs from exact successful run artifact');
 compareInstalledTarball(input.coreTarball,input.corePackageRoot,binding.core.tarballSha256);
 const signature=JSON.parse(command(process.execPath,[npmCli,'audit','signatures','--json'],consumer));
 writeFileSync(join(evidenceRoot,'npm-signatures.json'),JSON.stringify(signature));
 const verify=JSON.parse(command(process.execPath,[join(input.corePackageRoot,'dist/cli.js'),'verify-release','0.6.1','--json'],consumer));
 assert.equal(verify.counts?.fail,0);assert.equal(verify.counts?.skip,0);assert.equal(verify.counts?.pass,3,'all three release verification legs required');
 writeFileSync(join(evidenceRoot,'verify-release.json'),JSON.stringify(verify));
 writeFileSync(join(evidenceRoot,'tar-attestation.json'),JSON.stringify(attestation));
 const context=Object.freeze({input:Object.freeze({...input}),binding:Object.freeze({...binding,core:Object.freeze({...binding.core})}),consumer,npmCli,scanRoot,evidenceRoot});
 trusted.set(context,{q,records,expected});await recheck(context);
 writeFileSync(join(evidenceRoot,'public-authority.json'),JSON.stringify({qualificationSha256:input.qualificationSha256,coreTarballSha256:binding.core.tarballSha256,registryIntegrity:binding.registryIntegrity,runId:q.workflow.runId,runAttempt:q.workflow.runAttempt,source:q.source,seq:records.map(r=>({sequence:r.sequence,sha256:r.sha256,sourceSha:r.sourceSha,attestation:r.attestation}))},null,2));
 return context;
}
