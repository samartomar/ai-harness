import assert from 'node:assert/strict';
import {isAbsolute,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {regularBytes} from './bytes.mjs';
import {authorizePublic,recheck} from './release-authority.mjs';
import {validatePublicInputs} from './validate-public-inputs.mjs';
import {run832} from './run-832.mjs';
import {runManaged} from './run-managed.mjs';
import {run848} from './run-848.mjs';
export async function main(args){
 assert(args.length===2||args.length===6,'usage: --inputs absolute.json [--scan-root absolute --execute all|832|managed|848]');
 assert.equal(args[0],'--inputs');assert(isAbsolute(args[1]));const input=JSON.parse(regularBytes(args[1],8192));
 if(args.length===2){console.log(JSON.stringify(await validatePublicInputs(input)));return;}
 assert.equal(args[2],'--scan-root');assert(isAbsolute(args[3]));assert.equal(args[4],'--execute');assert(['all','832','managed','848'].includes(args[5]));
 const context=await authorizePublic(input,args[3]);
 for(const [name,run]of [['832',run832],['managed',runManaged],['848',run848]])if(args[5]==='all'||args[5]===name){await recheck(context);await run(context);}
 console.log(`PUBLIC061_JOURNEYS_PASS ${context.evidenceRoot}`);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)await main(process.argv.slice(2));
