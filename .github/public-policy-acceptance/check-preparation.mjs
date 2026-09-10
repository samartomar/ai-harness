import assert from 'node:assert/strict';
import {assertInputs,bindIdentity,validatePublicInputs} from './validate-public-inputs.mjs';
import {regularBytes,compareInstalledTarball} from './bytes.mjs';
const root=import.meta.dirname.replaceAll('\\','/');
const input={qualificationPath:root+'/absent-qualification.json',qualificationSha256:'sha256:'+'a'.repeat(64),coreTarball:root+'/absent-core.tgz',corePackageRoot:root+'/absent-installed',seq4Receipt:root+'/absent-public-seq4.json',seq4SourceSha:'a'.repeat(40)};
let checks=0;
assert.throws(()=>assertInputs({...input,execute:true}),/exact input keys/u);checks++;
assert.throws(()=>assertInputs({...input,coreTarball:'local.tgz'}),/absolute coreTarball/u);checks++;
assert.throws(()=>assertInputs({...input,qualificationSha256:'sha256:'+'0'.repeat(64)}),/reviewed qualification digest/u);checks++;
assert.throws(()=>assertInputs({...input,seq4SourceSha:'0'.repeat(40)}),/real seq4 source/u);checks++;
assert.throws(()=>bindIdentity({}, {}, Buffer.from('not a release')),/package|schemaVersion|Invalid/u);checks++;
await assert.rejects(validatePublicInputs(input),e=>e.code==='ENOENT'&&e.path.replaceAll('\\','/')===input.seq4Receipt);checks++;
console.log(`PREPARATION_${checks}_CONTROLS_PASS; no network, target writes, fixture authority, public0.6 or execution claim`);

import {run832} from './run-832.mjs';
import {runManaged} from './run-managed.mjs';
import {run848} from './run-848.mjs';
import {assertAuthorized} from './release-authority.mjs';
import {main} from './run-public-acceptance.mjs';
for(const run of [run832,runManaged,run848]){await assert.rejects(run({}),/live public authority context required/u);checks++;}
assert.throws(()=>assertAuthorized(Object.freeze({authorityVerified:true,liveExecutionReady:true})),/live public authority context required/u);checks++;
await assert.rejects(main([]),/usage/u);checks++;
console.log(`DRIVER_PREPARATION_${checks}_CONTROLS_PASS; imports inert, all three injected contexts refused, no live run`);
import {readFileSync} from 'node:fs';
import {decisionDispositionForSequence} from './policy-authoring.mjs';
const formSource=readFileSync('src/org-policy/studio-protected-authority.ts','utf8');
const select=formSource.match(/<select id="protected-disposition">([\s\S]*?)<\/select>/u)?.[1];
assert(select,'current native disposition form exists');
const allowed=[...select.matchAll(/<option value="([^"]+)">/gu)].map(match=>match[1]);
for(let sequence=0;sequence<=4;sequence++)assert(allowed.includes(decisionDispositionForSequence(sequence)),`producer disposition supported by native form for seq${sequence}`);
assert.deepEqual([0,1,2,3].map(decisionDispositionForSequence),Array(4).fill('approved'));
assert.equal(decisionDispositionForSequence(4),'accepted-with-conditions');checks++;
assert.throws(()=>decisionDispositionForSequence(5),/public sequence/u);checks++;
const runtime=readFileSync('src/org-policy/studio-protected-authority-runtime.js','utf8');
assert.match(runtime,/disposition: values\.disposition/u); // Native output retains this enum; authorAndCheck must expect approved, not accepted.
console.log(`DISPOSITION_PREPARATION_${checks}_CONTROLS_PASS; actual form options and normalized runtime enum agree`);
for(const name of ['run-832.mjs','run-managed.mjs','run-848.mjs']) {
 const source=readFileSync(root+'/'+name,'utf8');
 const finalCheck=source.indexOf('await recheck(context);');
 const report=source.indexOf('const report = {');
 const pass=source.indexOf('acceptance PASS;')>=0?source.indexOf('acceptance PASS;'):source.indexOf('SUPPORTED_NPM_ACCEPTANCE_PASS');
 assert(finalCheck>=0&&finalCheck<report&&report<pass,`final gate precedes success report and PASS in ${name}`);
 assert.equal(source.lastIndexOf('await recheck(context);'),finalCheck,'no trailing post-PASS integrity gate');checks++;
}
console.log(`FINAL_GATE_PREPARATION_${checks}_CONTROLS_PASS; all three final rechecks precede success report creation and PASS`);
