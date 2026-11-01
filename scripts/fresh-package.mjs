// Install a release archive into a new prefix/cache, then execute its actual CLI.
import {spawn} from 'node:child_process';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const archive=process.argv[2];if(!archive)throw new Error('Supply the reviewed release .tgz path or URL');
const root=await fs.mkdtemp(path.join(os.tmpdir(),'sentinel-package-'));
const prefix=path.join(root,'install'),store=path.join(root,'evidence');
const begun=performance.now(),steps=[];let firstMeaningfulMs;
async function run(command,args,cwd){
 const started=performance.now();let stdout='',stderr='';
 const child=spawn(command,args,{cwd,env:{...process.env,npm_config_cache:path.join(root,'empty-cache'),NO_COLOR:'1'},stdio:['ignore','pipe','pipe']});
 child.stdout.on('data',bytes=>{stdout+=bytes;process.stdout.write(bytes);if(firstMeaningfulMs===undefined&&stdout.includes('CONTRADICTED')&&stdout.includes('ordinary tests passed'))firstMeaningfulMs=Math.round(performance.now()-begun);});
 child.stderr.on('data',bytes=>{stderr+=bytes;process.stderr.write(bytes);});
 const exitCode=await new Promise(resolve=>{child.on('error',error=>{stderr+=error;resolve(-1)});child.on('close',resolve)});
 steps.push({command:[command,...args],exitCode,durationMs:Math.round(performance.now()-started)});if(exitCode!==0)throw new Error(stderr||`${command} exited ${exitCode}`);return stdout;
}
await run('npm',['install','--prefix',prefix,'--ignore-scripts','--no-audit','--no-fund',archive],root);
const cli=path.join(prefix,'node_modules','sentinel-verified','dist','cli.js');
const version=(await run(process.execPath,[cli,'--version'],root)).trim();
await run(process.execPath,[cli,'demo','--store',store],root);
const result={schemaVersion:1,date:new Date().toISOString(),archive,version,node:process.version,platform:process.platform,arch:process.arch,emptyNpmCache:true,freshInstallPrefix:true,lifecycleScriptsDisabled:true,preinstalled:['Node.js','npm','Git','Compatible installed browser'],firstMeaningfulMs,totalMs:Math.round(performance.now()-begun),under90Seconds:typeof firstMeaningfulMs==='number'&&firstMeaningfulMs<90000,steps};
const output=process.argv[3]??path.join(root,'fresh-package.json');await fs.writeFile(output,JSON.stringify(result,null,2)+'\n');console.log(`Fresh package measurement: ${output}`);
