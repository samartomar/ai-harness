import test, {after} from 'node:test';
import {tmpdir} from 'node:os';
import assert from 'node:assert/strict';
import {randomBytes,createHash} from 'node:crypto';
import {gzipSync,gunzipSync} from 'node:zlib';
import {mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {pins,decodeScans,writeScans,dataKey,encrypt,decrypt,archive,safeArchivePath,childEnvironment} from '../../.github/public-policy-acceptance/private-transport.mjs';
import {validateHostClaims} from '../../.github/public-policy-acceptance/host-guard.mjs';
import {completion} from '../../.github/public-policy-acceptance/hosted-run.mjs';
import YAML from 'yaml';
import {validateSourceBytes,maxSourceBytes} from '../../.github/public-policy-acceptance/acquire-public.mjs';
const fixture=mkdtempSync(join(tmpdir(),'aih-hosted-policy-controls-'));
after(()=>rmSync(fixture,{recursive:true,force:true}));
const envelope=files=>gzipSync(Buffer.from(JSON.stringify({format:'aih-core061-private-scans/v1',files}))).toString('base64');
test('immutable raw source accepts greater-than-1MiB encoding-none response and rejects truncation, tampering and oversize',()=>{
 // Inert transport bytes, never a qualification receipt or authority fixture.
 const bytes=Buffer.alloc(1269545,0x61),metadata={type:'file',size:bytes.length,encoding:'none',content:''};
 const digest='sha256:'+createHash('sha256').update(bytes).digest('hex');
 assert(bytes.length>1024*1024);assert.equal(validateSourceBytes(metadata,bytes,digest),bytes);
 assert.throws(()=>validateSourceBytes(metadata,bytes.subarray(1),digest),/length mismatch/u);
 const changed=Buffer.from(bytes);changed[changed.length-1]^=1;assert.throws(()=>validateSourceBytes(metadata,changed,digest),/digest mismatch/u);
 assert.throws(()=>validateSourceBytes({...metadata,size:maxSourceBytes+1},bytes,digest),/size refused/u);
 assert.throws(()=>validateSourceBytes({...metadata,type:'symlink'},bytes,digest));
});
test('bounded scan envelope rejects unexpected paths and wrong original bytes before writes',()=>{
 for(const files of [{},{'../escape':'x'},Object.fromEntries(Object.keys(pins).map(n=>[n,'x']))]){
  const dest=join(fixture,'must-not-exist');assert.throws(()=>writeScans(dest,envelope(files)));assert(!existsSync(dest));
 }
 assert.throws(()=>decodeScans('a'.repeat(49153)));
 assert.throws(()=>decodeScans(gzipSync(Buffer.alloc(200001)).toString('base64')));
});
test('AES256 GCM authenticates complete archive and rejects key, header, nonce, tag and payload alteration',()=>{
 writeFileSync(join(fixture,'private-example.txt'),'inert private-shaped diagnostic');
 const key=randomBytes(32),plain=archive(fixture),cipher=encrypt(plain,key);
 assert(decrypt(cipher,key).equals(plain));assert.throws(()=>decrypt(cipher,randomBytes(32)));
 for(const offset of [0,35,45,cipher.length-1]){const changed=Buffer.from(cipher);changed[offset]^=1;assert.throws(()=>decrypt(changed,key));}
 const unpack=JSON.parse(gunzipSync(decrypt(cipher,key)));assert(unpack.files.some(x=>x.path==='private-example.txt'&&Buffer.from(x.data,'base64').toString()==='inert private-shaped diagnostic'));
 assert.equal(dataKey(key.toString('base64')).length,32);assert.throws(()=>dataKey(Buffer.alloc(31).toString('base64')));
});
test('unsafe archive paths cannot traverse or use Windows streams',()=>{
 for(const path of ['../x','a/../x','C:/x','a:b','/root','a\\b','.','a//b'])assert.throws(()=>safeArchivePath(path));
 assert.equal(safeArchivePath('nested/evidence.json'),'nested/evidence.json');
});
test('unauthorized host claims fail closed and transport secrets never reach child environment',()=>{
 const valid={GITHUB_ACTIONS:'true',RUNNER_ENVIRONMENT:'github-hosted',GITHUB_REPOSITORY:'samartomar/ai-harness',GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_REF:'refs/heads/main',GITHUB_REF_PROTECTED:'true',GITHUB_WORKFLOW_REF:'samartomar/ai-harness/.github/workflows/public-policy-acceptance.yml@refs/heads/main',GITHUB_SHA:'a'.repeat(40),GITHUB_RUN_ID:'1',GITHUB_RUN_ATTEMPT:'1',GITHUB_ACTOR:'github-actions[bot]'};
 validateHostClaims(valid,'win32');for(const key of Object.keys(valid))assert.throws(()=>validateHostClaims({...valid,[key]:''},'win32'));
 assert.throws(()=>validateHostClaims(valid,'linux'));
 const env=childEnvironment({AIH_CORE061_SCAN_INPUTS:'inert',AIH_CORE061_EVIDENCE_KEY:'inert',Path:'native'});assert.deepEqual(env,{Path:'native'});
});
test('nonzero final result or absent terminal marker can never publish PASS',()=>{
 assert(completion(0,true));for(const pair of [[1,true],[null,true],[0,false],[-1,false]])assert.equal(completion(...pair),false);
});
test('workflow accepts only protected dispatch, read permissions and exact encrypted output allowlist',()=>{
 const flow=YAML.parse(readFileSync(new URL('../../.github/workflows/public-policy-acceptance.yml',import.meta.url),'utf8'));
 assert.deepEqual(Object.keys(flow.on),['workflow_dispatch']);assert.deepEqual(flow.permissions,{});
 const job=flow.jobs['actual-public-policy'];assert.equal(job['runs-on'],'windows-latest');assert.match(job.if,/github\.ref_protected/u);
 assert.deepEqual(job.permissions,{contents:'read',actions:'read',issues:'read',attestations:'read'});
 for(const step of job.steps.filter(s=>s.uses))assert.match(step.uses,/@[a-f0-9]{40}$/u);
 const uploads=job.steps.filter(s=>s.uses?.startsWith('actions/upload-artifact@'));assert.equal(uploads.length,1);assert.equal(uploads[0].if,'always()');
 assert.deepEqual(uploads[0].with.path.trim().split('\n').map(p=>p.split('/').at(-1)),['raw-evidence.aes256gcm','ciphertext.sha256','summary.json']);
 const privateSteps=job.steps.filter(s=>s.env?.AIH_CORE061_SCAN_INPUTS);assert.equal(privateSteps.length,1);assert.equal(privateSteps[0].run,'node .github/public-policy-acceptance/hosted-run.mjs');
});
test('failed native child output remains complete encrypted evidence',()=>{
 const script=join(fixture,'negative-child.mjs');writeFileSync(script,"import {spawnSync} from 'node:child_process'; const r=spawnSync(process.execPath,['-e',\"process.stdout.write('PRIVATE_SENTINEL'); process.stderr.write('FAIL_SENTINEL'); process.exit(7)\"],{encoding:'utf8',maxBuffer:1}); if(r.status!==7||r.stdout!=='PRIVATE_SENTINEL'||r.stderr!=='FAIL_SENTINEL')throw Error('capture failed'); process.exit(7);");
 const root=join(fixture,'child-root');
 // No authority is fabricated: this subprocess only emits inert text and fails.
 const make=spawnSync(process.execPath,['-e',"require('fs').mkdirSync(process.argv[1],{recursive:true})",join(root,'raw')]);assert.equal(make.status,0);
 const child=spawnSync(process.execPath,['--import',new URL('../../.github/public-policy-acceptance/capture-runtime.mjs',import.meta.url).href,script],{env:{...childEnvironment(process.env),AIH_HOSTED_ROOT:root},encoding:'utf8'});assert.equal(child.status,7);
 const key=randomBytes(32),cipher=encrypt(archive(join(root,'raw')),key);assert(!cipher.includes(Buffer.from('PRIVATE_SENTINEL')));
 const files=JSON.parse(gunzipSync(decrypt(cipher,key))).files;
 assert(files.some(f=>Buffer.from(f.data,'base64').toString()==='PRIVATE_SENTINEL'));assert(files.some(f=>Buffer.from(f.data,'base64').toString()==='FAIL_SENTINEL'));
});
