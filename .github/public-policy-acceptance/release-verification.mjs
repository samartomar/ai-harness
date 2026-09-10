import assert from 'node:assert/strict';

export function assertReleaseVerification(output){
 assert.equal(output?.capability,'verify-release','release verification execution envelope required');
 const report=output.report;
 assert.equal(report?.ok,true,'release verification must pass');
 assert.deepEqual(report?.counts,{pass:3,fail:0,skip:0},'all three release verification legs required');
 assert(Array.isArray(report.checks),'release verification checks required');
 assert.deepEqual(report.checks.map(check=>[check.name,check.verdict]).sort(),[
  ['release cosign bundle','pass'],['release npm signatures','pass'],['release tarball hash','pass'],
 ],'exact three release verification checks required');
 return report;
}
