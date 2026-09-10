// Loaded before any driver import. Complete command output is private evidence.
import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {appendFileSync,openSync,closeSync,readFileSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {childEnvironment} from './private-transport.mjs';
const original=cp.spawnSync;
let sequence=0;
cp.spawnSync=function(file,args,options={}){
 const prefix=join(process.env.AIH_HOSTED_ROOT,'raw',`command-${String(++sequence).padStart(5,'0')}`);
 const out=openSync(prefix+'.stdout','wx'),err=openSync(prefix+'.stderr','wx');
 let result;
 try{result=original(file,args,{...options,env:childEnvironment(options.env??process.env),stdio:['pipe',out,err]});}
 finally{closeSync(out);closeSync(err);}
 for(const[name,suffix]of [['stdout','.stdout'],['stderr','.stderr']]){
  if(statSync(prefix+suffix).size>128*1024*1024)throw new Error('native output exceeded parse bound; raw file retained');
  const bytes=readFileSync(prefix+suffix);result[name]=options.encoding?bytes.toString(options.encoding):bytes;
 }
 result.output=[null,result.stdout,result.stderr];
 const path=join(process.env.AIH_HOSTED_ROOT,'raw','native-command-output.jsonl');
 appendFileSync(path,JSON.stringify({file,args,status:result.status,signal:result.signal,error:result.error?.stack,outputPrefix:prefix})+'\n');
 return result;
};
syncBuiltinESMExports();
