import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {join,isAbsolute,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {regularBytes,sha256,compareInstalledTarball} from './bytes.mjs';
import {validateQualificationReceiptForRepository} from '../../src/internals/delivery-governance.ts';
export const identity=Object.freeze({name:'@aihq/core',version:'0.6.1',repository:'samartomar/ai-harness',tag:'v-core-0.6.1',registryMetadata:'https://registry.npmjs.org/@aihq%2fcore/0.6.1',tarball:'https://registry.npmjs.org/@aihq/core/-/core-0.6.1.tgz'});
export function exactRegistryMetadataText(bytes){
 assert(Buffer.isBuffer(bytes)&&bytes.length>0&&bytes.length<=1024*1024,'registry metadata byte limit');
 const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);
 assert(Buffer.from(text,'utf8').equals(bytes),'registry metadata byte round-trip mismatch');
 return text;
}
export function assertInputs(input){
 assert(input&&Object.getPrototypeOf(input)===Object.prototype,'plain input object required');
 assert.deepEqual(Object.keys(input).sort(),['qualificationPath','qualificationSha256','coreTarball','corePackageRoot','seq4Receipt','seq4SourceSha'].sort(),'exact input keys required');
 for(const k of ['qualificationPath','coreTarball','corePackageRoot','seq4Receipt'])assert(typeof input[k]==='string'&&isAbsolute(input[k]),`absolute ${k} required`);
 assert(/^sha256:[a-f0-9]{64}$/u.test(input.qualificationSha256)&&input.qualificationSha256!=='sha256:'+'0'.repeat(64),'reviewed qualification digest required');
 assert(/^[a-f0-9]{40}$/u.test(input.seq4SourceSha)&&!/^0+$/u.test(input.seq4SourceSha),'real seq4 source commit required');
}
export function bindIdentity(metadata,qualification,compressed){
 const q=validateQualificationReceiptForRepository(qualification,identity.repository);
 assert.equal(q.package.name,identity.name);assert.equal(q.package.version,identity.version,'released Core0.6.1 required');
 assert.equal(q.source.tag,identity.tag);assert.equal(q.workflow.revision,q.source.sha,'qualification source/workflow mismatch');
 assert.equal(metadata.name,identity.name);assert.equal(metadata.version,identity.version,'registry exact version required');
 assert.equal(metadata.dist?.tarball,identity.tarball,'canonical registry tarball URL required');
 assert(/^sha512-[A-Za-z0-9+/]{86}==$/u.test(metadata.dist?.integrity??''),'registry SHA512 integrity required');
 assert.equal('sha512-'+createHash('sha512').update(compressed).digest('base64'),metadata.dist.integrity,'registry integrity mismatch');
 assert.equal(sha256(compressed),'sha256:'+q.artifact.tarballSha256,'qualified tarball mismatch');
 return {qualification:q,sha256:sha256(compressed),integrity:metadata.dist.integrity};
}
async function publicBytes(url,limit){
 const response=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(30000),headers:{accept:url===identity.registryMetadata?'application/json':'application/octet-stream'}});
 assert(response.ok&&response.url===url,'exact public registry response required');
 const parts=[];let size=0;for await(const part of response.body){size+=part.length;assert(size<=limit,'public byte limit exceeded');parts.push(Buffer.from(part));}
 return Buffer.concat(parts);
}
/** Preparation-only. No custody writer, npm install, browser authoring or execution hook exists. */
export async function validatePublicInputs(input){
 assertInputs(input);
 // Missing seq4 refuses before any network request or installed code import.
 regularBytes(input.seq4Receipt,5970);
 const receiptBytes=regularBytes(input.qualificationPath);assert.equal(sha256(receiptBytes),input.qualificationSha256,'reviewed qualification bytes changed');
 const compressed=regularBytes(input.coreTarball,64*1024*1024);
 const metadataBytes=await publicBytes(identity.registryMetadata,1024*1024);
 const metadataText=exactRegistryMetadataText(metadataBytes);
 const bound=bindIdentity(JSON.parse(metadataText),JSON.parse(receiptBytes),compressed);
 const registryTar=await publicBytes(identity.tarball,64*1024*1024);assert(registryTar.equals(compressed),'local bytes differ from actual registry response');
 const installed=compareInstalledTarball(input.coreTarball,input.corePackageRoot,bound.sha256);
 const manifest=JSON.parse(regularBytes(join(input.corePackageRoot,'package.json')));assert.equal(manifest.name,identity.name);assert.equal(manifest.version,identity.version);
 return {status:'public-byte-binding-only',liveExecutionReady:false,authorityVerified:false,version:identity.version,qualificationSha256:input.qualificationSha256,registryMetadataSha256:sha256(metadataBytes),registryMetadataJson:metadataText,registryIntegrity:bound.integrity,core:installed,requiredBeforeCustody:['Independently verify qualification run/artifact custody, tag object/source, active candidate and public provenance using real native gh/npm/cosign.','Parse and verify original public seq0-4 through installed Core and native gh with exact workflow/source bindings.','Use run-public-acceptance.mjs for all native authority checks and adapted drivers; recheck bytes immediately before each execution.']};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 assert.equal(process.argv.length,4,'usage: node --import tsx validate-public-inputs.mjs --inputs absolute.json');assert.equal(process.argv[2],'--inputs');assert(isAbsolute(process.argv[3]));
 console.log(JSON.stringify(await validatePublicInputs(JSON.parse(regularBytes(process.argv[3],8192)))));
}
