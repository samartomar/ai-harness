import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
export function validateHostClaims(env,platform){
 assert.equal(platform,'win32');assert.equal(env.GITHUB_ACTIONS,'true');assert.equal(env.RUNNER_ENVIRONMENT,'github-hosted');
 assert.equal(env.GITHUB_REPOSITORY,'samartomar/ai-harness');assert.equal(env.GITHUB_EVENT_NAME,'workflow_dispatch');assert.equal(env.GITHUB_REF,'refs/heads/main');
 assert.equal(env.GITHUB_REF_PROTECTED,'true');assert.equal(env.GITHUB_WORKFLOW_REF,'samartomar/ai-harness/.github/workflows/public-policy-acceptance.yml@refs/heads/main');
 assert(/^[a-f0-9]{40}$/u.test(env.GITHUB_SHA??''));assert(/^[1-9][0-9]*$/u.test(env.GITHUB_RUN_ID??''));assert(/^[1-9][0-9]*$/u.test(env.GITHUB_RUN_ATTEMPT??''));assert(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}(?:\[bot\])?$/u.test(env.GITHUB_ACTOR??''));
}
export function assertFreshHost(){
 validateHostClaims(process.env,process.platform);
 assert(!existsSync('C:/ProgramData/aih/supported-qualification/v2'),'existing custody must be preserved');
 const r=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command','if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { exit 1 }'],{windowsHide:true,encoding:'utf8'});
 assert.equal(r.status,0,'hosted administrator required');
}
