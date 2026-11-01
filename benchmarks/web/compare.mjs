// Actual trustbut comparison on the same pinned Express source and original Mocha assertions.
import {promises as fs} from 'node:fs';import path from 'node:path';import os from 'node:os';import {fileURLToPath} from 'node:url';import {createHash} from 'node:crypto';
import {prepareProject,runtime} from './prepare.mjs';import {runCommand} from '../../dist/process.js';
if(!process.argv.includes('--allow-local'))throw Error('Review the public sources and pass --allow-local.');
const here=path.dirname(fileURLToPath(import.meta.url)),output=path.resolve(process.argv.find(a=>a.startsWith('--out='))?.slice(6)??'benchmark-results/web-comparison');await fs.mkdir(output,{recursive:true});
const temp=await fs.mkdtemp(path.join(os.tmpdir(),'sentinel-web-compare-'));const config=path.join(temp,'trustbut.json');await fs.writeFile(config,JSON.stringify({runner:'mocha',args:['upstream-mocha.cjs'],timeoutSec:30}));
const cases=JSON.parse(await fs.readFile(path.join(here,'cases.json'),'utf8')).filter(c=>c.project==='express'&&c.oracle!=='missing-server');const results=[];
const git=async(repo,args)=>{const r=await runCommand(['git','-c','core.hooksPath=/dev/null','-c','commit.gpgsign=false',...args],repo);if(r.exitCode!==0)throw Error(r.stderr);return r.stdout.trim();};
for(const item of cases){
 const repo=path.join(temp,item.id);await prepareProject('express',repo,item.baseline);await git(repo,['init','-b','main']);await git(repo,['add','--all']);await git(repo,['-c','user.name=SENTINEL','-c','user.email=sentinel@localhost','commit','-m','Pinned public baseline']);const base=await git(repo,['rev-parse','HEAD']);
 for(const entry of await fs.readdir(repo))if(entry!=='.git')await fs.rm(path.join(repo,entry),{recursive:true,force:true});await prepareProject('express',repo,item.candidate);await git(repo,['add','--all']);await git(repo,['-c','user.name=SENTINEL','-c','user.email=sentinel@localhost','commit','--allow-empty','-m','Declared public evaluation candidate']);const head=await git(repo,['rev-parse','HEAD']);
 const ordinary=await runCommand([process.execPath,path.join(runtime,'mocha/bin/mocha.js'),'upstream-mocha.cjs','--reporter','json'],repo,{timeoutMs:30000});let stats;try{stats=JSON.parse(ordinary.stdout).stats;}catch{}
 const receiptFile=path.join(output,item.id+'.trustbut.json'),command=[process.execPath,path.join(runtime,'trustbut/dist/cli.js'),'verify','--base',base,'--head',head,'--runner','mocha','--config',config,'--json','--receipt-json',receiptFile];
 const comparison=await runCommand(command,repo,{timeoutMs:120000});let receipt;try{receipt=JSON.parse(await fs.readFile(receiptFile,'utf8'));}catch{}
 const sourceHash=createHash('sha256').update(await fs.readFile(path.join(repo,'app.cjs'))).digest('hex');
 await fs.writeFile(path.join(output,item.id+'.raw.json'),JSON.stringify({id:item.id,sourceHash,base,head,ordinary,comparison},null,2)+'\n');
 results.push({id:item.id,sourceHash,ordinary:{exitCode:ordinary.exitCode,durationMs:ordinary.durationMs,tests:stats?.tests,passed:stats?.passes,failed:stats?.failures},trustbut:{exitCode:comparison.exitCode,durationMs:comparison.durationMs,receipt:receipt??null}});console.log(item.id,ordinary.exitCode,receipt?.verdict??'no receipt');
}
const versions=Object.fromEntries(await Promise.all(['trustbut','mocha','supertest','express'].map(async name=>[name,JSON.parse(await fs.readFile(path.join(runtime,name,'package.json'),'utf8')).version])));
await fs.writeFile(path.join(output,'results.json'),JSON.stringify({schemaVersion:1,date:new Date().toISOString(),node:process.version,platform:process.platform,arch:process.arch,versions,config:{runner:'mocha',args:['upstream-mocha.cjs'],timeoutSec:30},limitations:['Same original11Mocha assertions, no extra contract supplied totrustbut. Generic dependency/change-not-proven warnings are not counted as concrete defect detection.','No React/Cypress comparison was executed here.'],results},null,2)+'\n');
console.log(output);
