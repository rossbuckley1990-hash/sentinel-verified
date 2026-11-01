import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { isDeepStrictEqual } from 'node:util';
import { materializeSnapshot, getObject, readSnapshot, digest } from './store.js';
import { runCommand, executionEnvironment } from './process.js';
import { parseContract } from './schema.js';
import type { VerificationOptions, Receipt, Check, Change, CommandRecord, Json, Snapshot, Status, Requirement } from './types.js';
const require=createRequire(import.meta.url);
const ownModules=path.resolve(path.dirname(require.resolve('vitest/package.json')),'..');
const vitestCli=path.join(path.dirname(require.resolve('vitest/package.json')),'vitest.mjs');
const adjacentWorker=fileURLToPath(new URL('./probe-worker.js',import.meta.url));
const worker=existsSync(adjacentWorker)?adjacentWorker:fileURLToPath(new URL('../dist/probe-worker.js',import.meta.url));
const tsx=import.meta.resolve('tsx');
type Call={module:string;export:string;args:Json[]};
type Observation={ok:true;value:Json}|{ok:false;kind:string;error:string};
const isTest=(name:string)=>/(^|\/)(__tests__\/|.*\.(test|spec)\.[cm]?[jt]sx?$)/.test(name);
const isControl=(name:string)=>isTest(name)||/(^|\/)(vitest|vite)\.config\./.test(name)||name.startsWith('.github/workflows/')||/^(package(-lock)?\.json|yarn\.lock|pnpm-lock\.yaml)$/.test(name);
export function overallStatus(checks:Check[],changes:Change[]):Status {
 const relevant=checks.filter(c=>c.id!=='baseline-tests');
 for(const status of ['ENVIRONMENT FAILURE','CONTRADICTED','REVIEW REQUIRED','UNVERIFIED'] as Status[]) if(relevant.some(c=>c.status===status)||changes.some(c=>c.classification===status))return status;
 return 'VERIFIED';
}
async function attachDependencies(dir:string,dependencies?:string){
 const source=dependencies??ownModules;
 try{if((await fs.stat(source)).isDirectory())await fs.symlink(source,path.join(dir,'node_modules'),'dir');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
}
async function probe(root:string,calls:Call[],timeout:number):Promise<{values:Observation[];command:CommandRecord;error?:string}> {
 const nonce=randomUUID().replaceAll('-','');
 const input=JSON.stringify({root,nonce,calls});
 const command=await runCommand([process.execPath,'--import',tsx,worker],root,{input,timeoutMs:timeout,env:executionEnvironment()});
 if(command.exitCode!==0||command.timedOut||command.truncated||command.signal)return {values:[],command,error:command.timedOut?'Behavioural execution timed out':`Worker failed: ${command.stderr.slice(0,500) || command.signal || command.exitCode}`};
 const marker=`SENTINEL_RESULT_${nonce}:`;const lines=command.stdout.split('\n').filter(l=>l.startsWith(marker));
 try {if(lines.length!==1)throw new Error('Missing or repeated result'); const values=JSON.parse(lines[0]!.slice(marker.length)) as Observation[];
  if(!Array.isArray(values)||values.length!==calls.length||values.some(v=>typeof v?.ok!=='boolean'))throw new Error('Malformed result');return {values,command};
 }catch(error){return {values:[],command,error:`Invalid worker output: ${String(error)}`};}
}
async function testRun(dir:string,id:string,label:string,config:string,timeout:number):Promise<Check>{
 const outputFile=path.join(path.dirname(config),`${id}.json`);
 const command=await runCommand([process.execPath,vitestCli,'run','--config',config,'--reporter=json','--outputFile',outputFile],dir,{timeoutMs:timeout,env:executionEnvironment()});
 if(command.timedOut||command.truncated||command.signal||command.exitCode===null)return {id,label,status:'ENVIRONMENT FAILURE',detail:'Test execution did not complete reliably',command};
 let result: {numTotalTests?:number;numPassedTests?:number;numPendingTests?:number;numTodoTests?:number;numFailedTests?:number;success?:boolean};
 try{const bytes=await fs.readFile(outputFile,'utf8');command.outputFiles={[outputFile]:bytes};result=JSON.parse(bytes);}catch{return {id,label,status:'ENVIRONMENT FAILURE',detail:'Vitest did not produce a valid test report',command};}
 const total=result.numTotalTests??0;
 if(total===0)return {id,label,status:'UNVERIFIED',detail:'No tests executed; an empty suite is not verification',command};
 if((result.numPendingTests??0)+(result.numTodoTests??0)>0)return {id,label,status:'REVIEW REQUIRED',detail:`${total} tests; ${(result.numPendingTests??0)+(result.numTodoTests??0)} skipped or todo`,command};
 if(command.exitCode!==0||result.success!==true)return {id,label,status:(result.numFailedTests??0)>0?'CONTRADICTED':'ENVIRONMENT FAILURE',detail:`${result.numPassedTests??0}/${total} tests passed`,command};
 return {id,label,status:'VERIFIED',detail:`${result.numPassedTests}/${total} ordinary tests passed; these do not establish the approved intent`,command};
}
async function inspectChanges(options:VerificationOptions):Promise<Change[]>{
 const {baseline,candidate,contract,store}=options;const changes:Change[]=[];
 for(const name of [...new Set([...Object.keys(baseline.files),...Object.keys(candidate.files)])].sort()){
  const before=baseline.files[name],after=candidate.files[name];if(before?.hash===after?.hash&&before?.mode===after?.mode)continue;
  const kind=!before?'added':!after?'deleted':'modified';let classification:Status='VERIFIED';let reason='Path authorised by the supplied contract; behaviour is checked separately';
  if(isControl(name)){
   classification='REVIEW REQUIRED'; reason=isTest(name)?'Test changed: inspect preserved-check results and approve test edits separately':'Verification configuration or dependency definition changed';
   if(!after)reason='Test or verification input removed';
   if(before&&after&&isTest(name)){
    const a=(await getObject(store,before.hash)).toString(),b=(await getObject(store,after.hash)).toString();
    if(/\b(?:it|test|describe)\.(?:skip|todo|only)\s*\(/.test(b))reason='Skipped, focused, or todo test detected';
    else if(/\.to(?:Be|Equal|StrictEqual)\(/.test(a)&&/\.to(?:Contain|Match)\(/.test(b))reason='Possible assertion weakening: equality replaced with substring/pattern check';
    else if((b.match(/\bexpect\s*\(/g)?.length??0)<(a.match(/\bexpect\s*\(/g)?.length??0))reason='Assertion count decreased';
   }
  }else if(!contract?.allowedPaths?.includes(name)){classification='REVIEW REQUIRED';reason='Changed path has no explicit authorisation in allowedPaths; review is required, not an accusation';}
  changes.push({path:name,kind,classification,reason});
 }
 return changes;
}
function examples(req:Requirement){return [...req.cases,...(req.invariant?.seeds.map(seed=>{const args=structuredClone(req.invariant!.args);args[req.invariant!.argument]=seed;return {args,expected:req.invariant!.expected};})??[])];}
function matches(value:Observation|undefined,expected:Json){return value?.ok===true&&isDeepStrictEqual(value.value,expected);}
function observation(value:Observation|undefined):Json{return value?.ok===true?value.value:{error:value?.error??'Missing observation'};}
async function shrink(root:string,req:Requirement,original:Json[],timeout:number){
 const rule=req.invariant;if(!rule)return undefined;
 const input=original[rule.argument];if(rule.domain==='array'?!Array.isArray(input):typeof input!==rule.domain)return undefined;
 let args=structuredClone(original);let attempts=0;let changed=true;
 while(changed&&attempts<30){
  changed=false;const value=args[rule.argument]!;let candidates:Json[]=[];
  if(typeof value==='string')candidates=Array.from({length:value.length},(_,i)=>value.slice(0,i)+value.slice(i+1));
  else if(Array.isArray(value))candidates=value.map((_,i)=>value.filter((_,j)=>i!==j));
  else if(typeof value==='number'&&value!==0)candidates=[0,Math.trunc(value/2)].filter(v=>Math.abs(v)<Math.abs(value));
  for(const candidate of candidates){if(attempts++>=30)break;const next=structuredClone(args);next[rule.argument]=candidate;const result=await probe(root,[{module:req.module,export:req.export,args:next}],timeout);
   if(result.error)continue;const v=result.values[0];if(v?.ok&&!matches(v,rule.expected)){args=next;changed=true;break;}
  }
 }
 return {original,minimal:args,attempts,guarantee:attempts>=30?'Budget-limited reduction; not guaranteed minimal':rule.domain==='number'?'Locally minimal under zero/halving reductions':'1-minimal under single-element deletion for the approved constant-output invariant'};
}
export async function verify(options:VerificationOptions):Promise<Receipt>{
 const start=performance.now();const {store,baseline,candidate,contractHash}=options;const contract=options.contract?parseContract(options.contract):null;
 await readSnapshot(store,baseline.hash);await readSnapshot(store,candidate.hash);
 if(contractHash){const stored=parseContract(JSON.parse((await getObject(store,contractHash)).toString()));if(!isDeepStrictEqual(stored,contract))throw new Error('Approved contract content does not match its hash');}
 else if(contract)throw new Error('Approved contract requires a content hash');
 const scratch=await fs.mkdtemp(path.join(await fs.realpath(store),'execution-'));
 const baseDir=path.join(scratch,'baseline'),candidateDir=path.join(scratch,'candidate'),preservedDir=path.join(scratch,'preserved');
 const checks:Check[]=[];const timeout=options.timeoutMs??15000;
 const changes=await inspectChanges({...options,contract});
 const progress=options.onProgress??(()=>{});
 try {
  for(const [snapshot,dir] of [[baseline,baseDir],[candidate,candidateDir],[candidate,preservedDir]] as const){await materializeSnapshot(store,snapshot,dir);await attachDependencies(dir,options.dependencies);}
  // Restore original tests and runner configuration in a separate copy, never the agent workspace.
  for(const name of Object.keys(candidate.files))if(isControl(name))await fs.rm(path.join(preservedDir,name),{force:true});
  for(const [name,entry] of Object.entries(baseline.files))if(isControl(name)){const file=path.join(preservedDir,name);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,await getObject(store,entry.hash));}
  const config=path.join(scratch,'sentinel.vitest.config.mjs');
  await fs.writeFile(config,`export default {test:{include:['**/*.{test,spec}.{js,ts,mjs,cjs,mts,cts,jsx,tsx}','**/__tests__/**/*.{js,ts}'],exclude:['**/node_modules/**','**/.git/**'],environment:'node',globals:false,maxWorkers:1,fileParallelism:false,testTimeout:5000}};`);
  progress('Checking clean baseline tests');checks.push(await testRun(baseDir,'baseline-tests','Baseline tests',config,timeout));
  progress('Running candidate ordinary tests');checks.push(await testRun(candidateDir,'candidate-tests','Candidate ordinary tests',config,timeout));
  progress('Re-running preserved baseline tests against candidate source');checks.push(await testRun(preservedDir,'preserved-tests','Preserved baseline tests',config,timeout));
  if(!contract||contract.requirements.length===0)checks.push({id:'intent',label:'Approved intent',status:'UNVERIFIED',detail:'No approved requirements. Passing available tests cannot establish the task objective.'});
  for(const req of contract?.requirements??[]){
   progress(`Checking ${req.kind}: ${req.description}`);const cases=examples(req);const calls=cases.map(c=>({module:req.module,export:req.export,args:c.args}));
   const base=await probe(baseDir,calls,timeout),after=await probe(candidateDir,[...calls,...calls],timeout);
   if(base.error||after.error){checks.push({id:`req:${req.id}`,requirementId:req.id,label:req.description,status:'ENVIRONMENT FAILURE',detail:base.error??after.error!,command:base.error?base.command:after.command});continue;}
   const badImport=after.values.find(v=>!v.ok&&(v.kind==='import'||v.kind==='serialization'));
   if(badImport&&!badImport.ok){checks.push({id:`req:${req.id}`,requirementId:req.id,label:req.description,status:'ENVIRONMENT FAILURE',detail:badImport.error,command:after.command});continue;}
   if(!isDeepStrictEqual(after.values.slice(0,calls.length),after.values.slice(calls.length))){checks.push({id:`req:${req.id}`,requirementId:req.id,label:req.description,status:'UNVERIFIED',detail:'Repeated calls produced different results; deterministic support requirement was not satisfied',command:after.command});continue;}
   let failing=cases.findIndex((c,i)=>!matches(after.values[i],c.expected));const example=cases[failing<0?0:failing]!;
   const status:Status=failing<0?'VERIFIED':'CONTRADICTED';
   const check:Check={id:`req:${req.id}`,requirementId:req.id,label:req.description,status,detail:failing<0?`${cases.length} approved examples passed twice. Baseline met ${cases.filter((c,i)=>matches(base.values[i],c.expected)).length}/${cases.length}.`:`Approved ${req.kind} requirement conflicts with the observed result.`,args:example.args,expected:example.expected,observed:observation(after.values[failing<0?0:failing]),baseline:observation(base.values[failing<0?0:failing]),command:after.command};
   if(failing>=0&&req.invariant&&isDeepStrictEqual(example.expected,req.invariant.expected))check.counterexample=await shrink(candidateDir,req,example.args,timeout);
   checks.push(check);
   checks.push({id:`baseline:${req.id}`,label:`Baseline observation: ${req.id}`,status:'VERIFIED',detail:'Historical observations only; not a claim that baseline meets the requirement',command:base.command});
  }
  for(const p of contract?.probes??[]){
   const calls=p.inputs.map(args=>({module:p.module,export:p.export,args}));const a=await probe(baseDir,calls,timeout),b=await probe(candidateDir,calls,timeout);
   const error=a.error??b.error;
   if(error||[...a.values,...b.values].some(v=>!v.ok)){checks.push({id:`probe:${p.id}`,label:`Observed behaviour: ${p.id}`,status:'ENVIRONMENT FAILURE',detail:error??'Probe could not return supported JSON',command:b.command});continue;}
   const index=a.values.findIndex((v,i)=>!isDeepStrictEqual(v,b.values[i]));
   checks.push({id:`probe:${p.id}`,label:`Observed behaviour: ${p.id}`,status:index<0?'VERIFIED':'REVIEW REQUIRED',detail:index<0?'No differences on the approved probe inputs':'Behaviour changed outside a requirement; human judgement is needed',...(index<0?{}:{args:p.inputs[index],baseline:observation(a.values[index]),observed:observation(b.values[index])}),command:b.command});
   checks.push({id:`probe-baseline:${p.id}`,label:`Baseline probe: ${p.id}`,status:'VERIFIED',detail:'Historical observations only',command:a.command});
  }
  // A narrow negative-control mutation measures whether each approved check can reject
  // an intentionally wrong constant export. This is not general mutation coverage.
  for(const req of (contract?.requirements??[]).slice(0,10)){
   const first=examples(req)[0];if(!first)continue;const file=path.join(candidateDir,req.module),original=await fs.readFile(file);
   const wrong:Json=first.expected===null?true:null;
   try{await fs.writeFile(file,`export function ${req.export}(){return ${JSON.stringify(wrong)}}\n`);const result=await probe(candidateDir,[{module:req.module,export:req.export,args:first.args}],timeout);
    checks.push({id:`mutation:${req.id}`,label:`Negative control: ${req.id}`,status:result.error||!result.values[0]?.ok?'ENVIRONMENT FAILURE':matches(result.values[0],first.expected)?'UNVERIFIED':'VERIFIED',detail:'Deliberately wrong constant export '+(result.error?'could not execute':'was checked against the approved example')+(result.error?`: ${result.error}`:''),command:result.command});
   }finally{await fs.writeFile(file,original);}
  }
 }catch(error){checks.push({id:'execution',label:'Verification infrastructure',status:'ENVIRONMENT FAILURE',detail:String(error)});}
 finally{await fs.rm(scratch,{recursive:true,force:true});}
 // Re-read content-addressed inputs after executing advisory code to detect ordinary tampering.
 try{await readSnapshot(store,baseline.hash);await readSnapshot(store,candidate.hash);if(contractHash)await getObject(store,contractHash);}catch(error){checks.push({id:'integrity',label:'Protected evidence integrity',status:'ENVIRONMENT FAILURE',detail:String(error)});}
 const status=overallStatus(checks,changes);const nextActions=checks.filter(c=>c.id!=='baseline-tests'&&c.status!=='VERIFIED').map(c=>`${c.status}: ${c.label} — ${c.detail}`);
 nextActions.push(...changes.filter(c=>c.classification!=='VERIFIED').map(c=>`Review ${c.path}: ${c.reason}`));
 return {schemaVersion:1,id:randomUUID(),createdAt:new Date().toISOString(),objective:contract?.objective??'Inspect candidate changes without approved intent',baselineHash:baseline.hash,candidateHash:candidate.hash,contractHash,git:candidate.git,runner:'local-advisory',checks,changes,status,durationMs:Math.round(performance.now()-start),runtime:{node:process.version,platform:process.platform,arch:process.arch,verifierVersion:'0.1.0',vitest:require('vitest/package.json').version,workerSha256:digest(await fs.readFile(worker))},limitations:['Local advisory execution under the same OS account is not a security boundary.','Only the supplied examples, invariant seeds, and differential probes were observed; passing them is not a proof of arbitrary correctness.','Vitest uses SENTINEL’s explicit Node configuration; custom project config/plugins/setup files are not loaded.','Dependencies are reused from the supplied node_modules directory and are not hermetically captured.','Negative controls replace selected exports with wrong constants; this is not a general mutation score.','Hashes detect corruption, not malicious rewriting of the entire evidence chain.'],nextActions:nextActions.length?nextActions:['All scoped checks passed. Review the diff and the stated coverage limits before merging.']};
}
