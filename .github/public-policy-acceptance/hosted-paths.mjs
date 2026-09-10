import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {realpathSync,lstatSync} from 'node:fs';
import {join,isAbsolute} from 'node:path';
export function nativeTool(name){
 assert(['gh','git'].includes(name));
 const r=spawnSync('where.exe',[name+'.exe'],{encoding:'utf8',windowsHide:true});
 assert.equal(r.status,0,'required native tool unavailable');
 const path=realpathSync.native(r.stdout.trim().split(/\r?\n/u)[0]);
 assert(lstatSync(path).isFile()&&path.toLowerCase().endsWith('.exe'));
 return path;
}
export function hostedPaths(){
 const root=process.env.AIH_HOSTED_ROOT;
 assert(root&&isAbsolute(root),'hosted staging root required');
 return {root,raw:join(root,'raw'),receipts:join(root,'raw','public-receipts'),candidate:join(root,'raw','candidate')};
}
