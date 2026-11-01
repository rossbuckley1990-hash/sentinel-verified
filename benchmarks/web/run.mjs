// Explicit local execution of licensed, pinned public applications. No model credentials.
import {promises as fs} from 'node:fs';import path from 'node:path';import os from 'node:os';import {fileURLToPath} from 'node:url';import {createHash} from 'node:crypto';
import {prepareProject,contractFor,runtime} from './prepare.mjs';
import {captureSnapshot,putObject,getObject} from '../../dist/store.js';import {verify} from '../../dist/verifier.js';import {runCommand} from '../../dist/process.js';
const here=path.dirname(fileURLToPath(import.meta.url));
if(!process.argv.includes('--allow-local'))throw Error('This benchmark executes public project code on this machine. Review the pinned inputs and supply --allow-local.');
await fs.access(path.join(runtime,'express/package.json')).catch(()=>{throw Error('Install explicit benchmark dependencies first: npm ci --prefix benchmarks/web/runtime --ignore-scripts');});
const provenance=JSON.parse(await fs.readFile(path.join(here,'provenance.json'),'utf8'));
for(const file of provenance.files){const bytes=await fs.readFile(path.join(here,'projects',file.project,'upstream',file.path));if(createHash('sha256').update(bytes).digest('hex')!==file.sha256)throw Error('Pinned upstream source integrity failed: '+file.path);}
const fingerprintFiles=['../../dist/verifier.js','../../dist/application.js','../../dist/application-schema.js','../../dist/schema.js','../../dist/store.js','../../dist/process.js','prepare.mjs','run.mjs','runtime/package-lock.json'];
const fingerprint=async()=>Object.fromEntries(await Promise.all(fingerprintFiles.map(async name=>[name,createHash('sha256').update(await fs.readFile(path.resolve(here,name))).digest('hex')])));
const runtimeBefore=await fingerprint();
const versions=Object.fromEntries(await Promise.all(['express','mocha','supertest','react','react-dom','react-router-dom','esbuild','vitest'].map(async name=>[name,JSON.parse(await fs.readFile(path.join(runtime,name,'package.json'),'utf8')).version])));
const casesBytes=await fs.readFile(path.join(here,'cases.json'));const all=JSON.parse(casesBytes),split=process.argv.find(a=>a.startsWith('--split='))?.split('=')[1]??'all';
if(!['all','development','held-out'].includes(split))throw Error('Unknown split');
const selected=all.filter(c=>split==='all'||c.split===split);const root=await fs.mkdtemp(path.join(os.tmpdir(),'sentinel-public-web-')),store=path.join(root,'store');await fs.mkdir(store);
const results=[],started=performance.now();
const git=async(dir,args)=>{const r=await runCommand(['git','-c','core.hooksPath=/dev/null','-c','commit.gpgsign=false',...args],dir);if(r.exitCode!==0)throw Error(r.stderr);};
for(const item of selected){
 const begin=performance.now(),repo=path.join(root,item.id);console.log(`PUBLIC WEB ${item.id} (${item.split})`);
 await prepareProject(item.project,repo,item.baseline);await git(repo,['init','-b','main']);await git(repo,['add','--all']);await git(repo,['-c','user.name=SENTINEL','-c','user.email=sentinel@localhost','commit','-m','Pinned public source with explicit execution adapter']);
 const baseline=await captureSnapshot(repo,store);
 // Regenerate candidate from the same pin, preserving only the disposable Git metadata.
 for(const entry of await fs.readdir(repo))if(entry!=='.git')await fs.rm(path.join(repo,entry),{recursive:true,force:true});
 await prepareProject(item.project,repo,item.candidate);const candidate=await captureSnapshot(repo,store);const contract=contractFor(item),contractHash=await putObject(store,JSON.stringify(contract));
 let ordinary;
 if(item.project==='express')ordinary=await runCommand([process.execPath,path.join(runtime,'mocha/bin/mocha.js'),'upstream-mocha.cjs','--reporter','json'],repo,{timeoutMs:30000});
 const receipt=await verify({store,baseline,candidate,contract,contractHash,dependencies:runtime,timeoutMs:20000});const receiptHash=await putObject(store,JSON.stringify(receipt));
 const result={id:item.id,project:item.project,split:item.split,classification:item.class,origin:item.origin,expected:item.expected,observed:receipt.status,matched:item.expected===receipt.status,source:{baseline:baseline.hash,candidate:candidate.hash,contract:contractHash},receipt:receiptHash,durationMs:Math.round(performance.now()-begin),checks:receipt.checks.map(({id,status,detail})=>({id,status,detail})),ordinary:ordinary?{label:'Original upstream Mocha/Supertest suite; only require path adapted',exitCode:ordinary.exitCode,durationMs:ordinary.durationMs,...(()=>{try{const data=JSON.parse(ordinary.stdout);return {tests:data.stats.tests,passed:data.stats.passes,failed:data.stats.failures};}catch{return {error:ordinary.stderr.slice(-1000)}}})()}:{label:'SENTINEL-authored Vitest reducer smoke tests, not the upstream Cypress suite',status:receipt.checks.find(c=>c.id==='candidate-tests')?.status}};
 results.push(result);console.log(`  ${receipt.status} / expected ${item.expected}`);
 const partial={schemaVersion:1,scope:'Pinned public app examples; seeded changes and finite independently specified contracts; not a blind field evaluation',createdAt:new Date().toISOString(),casesHash:createHash('sha256').update(casesBytes).digest('hex'),platform:process.platform,arch:process.arch,node:process.version,versions,runtimeBefore,runtimeAfter:await fingerprint(),split,store,totalMs:Math.round(performance.now()-started),results};
 await fs.writeFile(process.argv.find(a=>a.startsWith('--out='))?.slice(6)??path.join(root,'results.json'),JSON.stringify(partial,null,2)+'\n');
}
const stable=JSON.stringify(runtimeBefore)===JSON.stringify(await fingerprint());console.log(`Runtime fingerprint stable: ${stable}`);console.log(`Evidence store: ${store}`);if(!stable||results.some(r=>!r.matched))process.exitCode=1;
