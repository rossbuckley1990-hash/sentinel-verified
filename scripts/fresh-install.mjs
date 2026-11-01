// Release validation: new public clone, empty npm cache, isolated evidence store.
// Prerequisites Node/npm/Git are intentionally excluded from the measured interval.
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const root=await fs.mkdtemp(path.join(os.tmpdir(),'sentinel-fresh-'));
const start=performance.now();const steps=[];let firstMeaningfulMs;
async function run(command,args,cwd){
 const begun=performance.now();let stdout='',stderr='';
 const child=spawn(command,args,{cwd,env:{...process.env,npm_config_cache:path.join(root,'empty-cache'),SENTINEL_HOME:path.join(root,'evidence'),NO_COLOR:'1'},stdio:['ignore','pipe','pipe']});
 child.stdout.on('data',b=>{stdout+=b;process.stdout.write(b);if(firstMeaningfulMs===undefined&&stdout.includes('CONTRADICTED')&&stdout.includes('ordinary tests passed'))firstMeaningfulMs=Math.round(performance.now()-start);});child.stderr.on('data',b=>{stderr+=b;process.stderr.write(b);});
 const code=await new Promise(resolve=>{child.on('error',e=>{stderr+=String(e);resolve(-1);});child.on('close',resolve);});steps.push({command:[command,...args],exitCode:code,durationMs:Math.round(performance.now()-begun)});if(code!==0)throw new Error(`${command} failed: ${stderr}`);return stdout;
}
const ref=process.argv[3]??'main';if(!/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(ref))throw new Error('Invalid release ref');
await run('git',['clone','--branch',ref,'https://github.com/rossbuckley1990-hash/sentinel-verified.git','project'],root);
const repo=path.join(root,'project');
const commit=(await run('git',['rev-parse','HEAD'],repo)).trim();
await run('npm',['ci'],repo);await run('npm',['run','build'],repo);await run(process.execPath,['dist/cli.js','demo'],repo);
const result={schemaVersion:1,date:new Date().toISOString(),platform:process.platform,arch:process.arch,node:process.version,commit,ref,emptyNpmCache:true,preinstalled:['Node.js','npm','Git'],firstMeaningfulMs,totalMs:Math.round(performance.now()-start),under90Seconds:typeof firstMeaningfulMs==='number'&&firstMeaningfulMs<90000,steps};
const out=process.argv[2]??path.join(root,'fresh-install.json');await fs.writeFile(out,JSON.stringify(result,null,2)+'\n');console.log(`Fresh-install result: ${out}`);
