import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { captureSnapshot, putObject, digest } from './store.js';
import { runCommand } from './process.js';
import { verify } from './verifier.js';
import type { Contract, Json, Receipt } from './types.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const corpus=path.join(root,'benchmarks/public');
export interface PublicCase {id:string;project:'is-number'|'normalize-path';split:'independent-public';origin:string;baseline:string;candidate:string;expectedCheck:string;expectedStatus:string;classification:'defect'|'correct'|'known-miss'|'unknown';description:string;weakenTests?:boolean;noContract?:boolean}
export interface PublicResult {id:string;project:string;origin:string;classification:string;expectedCheck:string;expectedStatus:string;actualStatus:string;matched:boolean;receiptStatus:string;receiptHash:string;baselineHash:string;candidateHash:string;contractHash:string|null;ordinaryStatus:string;ordinaryPassed:boolean;durationMs:number;ordinaryDurationMs:number;reproduced:boolean;counterexamples:{requirement:string;args:Json[];expected?:Json;observed?:Json}[];changes:{path:string;classification:string;reason:string}[]}
export async function validatePublicProvenance():Promise<void>{const manifest=JSON.parse(await fs.readFile(path.join(corpus,'provenance.json'),'utf8')) as {files:Record<string,string>;casesHash:string};for(const [name,hash] of Object.entries(manifest.files)){if(name.startsWith('/')||name.split('/').includes('..'))throw new Error('Unsafe provenance path');if(digest(await fs.readFile(path.join(corpus,name)))!==hash)throw new Error(`Public source provenance mismatch: ${name}`);}if(digest(await fs.readFile(path.join(corpus,'cases.json')))!==manifest.casesHash)throw new Error('Public case definitions differ from their predeclared provenance hash');}
export async function loadPublicCases():Promise<PublicCase[]>{await validatePublicProvenance();return JSON.parse(await fs.readFile(path.join(corpus,'cases.json'),'utf8')) as PublicCase[];}
export function adaptUpstreamSuite(source:string):string {
  // Only runner registration changes. Upstream assertion bodies and fixtures remain intact.
  const prefix=`// SENTINEL public-project evaluation: faithful Mocha→Vitest registration adapter.\nimport {describe,it} from 'vitest';\nimport {createRequire} from 'node:module';\nimport {fileURLToPath} from 'node:url';\nimport {dirname} from 'node:path';\nconst require=createRequire(import.meta.url);\nconst __dirname=dirname(fileURLToPath(import.meta.url));\n`;
  return prefix+source.replace(/require\(['"]mocha['"]\);?/g,'');
}
export function contractForPublicCase(c:PublicCase):Contract|null {
 if(c.noContract)return null;
 const base={schemaVersion:1 as const,objective:c.description,approvedBy:'Predeclared public-project evaluation specification; see provenance.json',allowedPaths:['index.js']};
 if(c.project==='is-number')return {...base,requirements:[...(c.classification==='known-miss'?[]:[{id:'whitespace',kind:'must-change' as const,description:'Issue #3: whitespace-only strings are not numbers',module:'index.js',export:'default',cases:[{args:[' '],expected:false},{args:['   '],expected:false},{args:['\r\n\t'],expected:false}]}]),{id:'valid-values',kind:'must-preserve',description:'Numeric values and numeric strings remain recognised',module:'index.js',export:'default',cases:[{args:[0],expected:true},{args:[37],expected:true},{args:['5e3'],expected:true},{args:['   56\r\n  '],expected:true},{args:['3a'],expected:false},{args:[''],expected:false},{args:[null],expected:false}]}]};
 return {...base,requirements:[{id:'path-behaviour',kind:'must-preserve',description:'Normalise separators and preserve explicitly requested trailing slash',module:'index.js',export:'default',cases:[{args:['foo\\bar\\baz'],expected:'foo/bar/baz'},{args:['foo/bar/baz/'],expected:'foo/bar/baz'},{args:['foo/bar/baz/',false],expected:'foo/bar/baz/'},{args:['/'],expected:'/'}]}],probes:[{id:'namespace',module:'index.js',export:'default',inputs:[['\\\\?\\C:\\user\\docs\\Letter.txt']]}]};
}
export function candidateSource(c:PublicCase,baseline:string,fixed:string):string {
 switch(c.candidate){
  case 'upstream-fixed':return fixed;
  case 'unchanged-comment':return baseline+'\n// Purported task completion; implementation unchanged.\n';
  case 'only-spaces':return baseline.replace('  var type = typeOf(num);',"  if (typeof num === 'string' && /^ +$/.test(num)) return false;\n  var type = typeOf(num);");
  case 'rename-local':return baseline.replaceAll('segs','segments');
  case 'always-strip':return baseline.replace("stripTrailing !== false && segs[segs.length - 1] === ''","segs[segs.length - 1] === ''");
  case 'namespace-prefix':return baseline.replace("prefix = '//';","prefix = '/';");
  default:throw new Error(`Unknown public candidate ${c.candidate}`);
 }
}
function weakenedSuite(text:string):string {
 const begin=text.indexOf("  describe('keep trailing slashes'");
 if(begin<0)throw new Error('Pinned upstream suite changed; cannot apply declared weakening');
 return text.slice(0,begin)+'});\n';
}
export async function preparePublicDependencies(directory:string,toolsModules?:string):Promise<string>{
 await fs.mkdir(directory,{recursive:true});
 // Reuse the installed runner, then resolve archived project dependencies from checked-in MIT sources.
 for(const source of [path.join(root,'node_modules'),...(toolsModules?[toolsModules]:[])])for(const name of await fs.readdir(source)){if(name.startsWith('.'))continue;try{await fs.symlink(path.join(source,name),path.join(directory,name),'dir');}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}}
 for(const name of ['kind-of','is-buffer','minimist']){
  const target=path.join(directory,name);try{await fs.lstat(target);}catch{await fs.cp(path.join(corpus,'dependencies',name),target,{recursive:true});}
 }
 return directory;
}
async function git(args:string[],cwd:string){const r=await runCommand(['git','-c','core.hooksPath=/dev/null','-c','commit.gpgsign=false',...args],cwd);if(r.exitCode!==0)throw new Error(r.stderr);return r.stdout.trim();}
export async function preparePublicCase(c:PublicCase,repo:string,dependencies:string):Promise<{baselineCommit:string;baselineSource:string;candidateCommit:string}> {
 await fs.mkdir(repo,{recursive:true});const upstream=path.join(corpus,'projects',c.project);
 for(const name of ['index.js','test.js','README.md','LICENSE','package.json'])await fs.copyFile(path.join(upstream,name),path.join(repo,name));
 const baselineSource=await fs.readFile(path.join(repo,'index.js'),'utf8');const originalTests=await fs.readFile(path.join(repo,'test.js'),'utf8');
 await fs.writeFile(path.join(repo,'upstream-adapter.test.ts'),adaptUpstreamSuite(originalTests));
 await fs.writeFile(path.join(repo,'.gitignore'),'node_modules/\n.vitest/\n');
 await fs.symlink(dependencies,path.join(repo,'node_modules'),'dir');
 await git(['init','-b','main'],repo);await git(['add','.'],repo);await git(['-c','user.name=SENTINEL evaluation','-c','user.email=evaluation@example.invalid','commit','-m',`Pinned public source with explicitly labelled runner adapter: ${c.project}`],repo);
 const baselineCommit=await git(['rev-parse','HEAD'],repo);
 const fixed=c.project==='is-number'?await fs.readFile(path.join(upstream,'fixed.js'),'utf8'):baselineSource;
 await fs.writeFile(path.join(repo,'index.js'),candidateSource(c,baselineSource,fixed));
 if(c.weakenTests){const tests=weakenedSuite(originalTests);await fs.writeFile(path.join(repo,'test.js'),tests);await fs.writeFile(path.join(repo,'upstream-adapter.test.ts'),adaptUpstreamSuite(tests));}
 await git(['switch','-c','evaluation-change'],repo);await git(['add','.'],repo);await git(['-c','user.name=SENTINEL evaluation','-c','user.email=evaluation@example.invalid','commit','-m',`${c.id}: ${c.description}`],repo);
 return {baselineCommit,baselineSource,candidateCommit:await git(['rev-parse','HEAD'],repo)};
}
async function runtimeFingerprint(){const hashes:Record<string,string>={};for(const name of ['public-benchmark','verifier','store','process','probe-worker','schema']){const file=path.join(root,'dist',name+'.js');hashes[name+'.js']=digest(await fs.readFile(file));}return hashes;}
function semantic(r:Receipt){return JSON.stringify({status:r.status,checks:r.checks.map(c=>[c.id,c.status,c.args,c.expected,c.observed,c.baseline,c.counterexample?.minimal]),changes:r.changes.map(c=>[c.path,c.classification])});}
export async function runPublicBenchmark(options:{outputDir?:string;caseIds?:string[];replay?:boolean;timeoutMs?:number;onProgress?:(message:string)=>void}={}){
 const timeoutMs=options.timeoutMs??30000;if(!Number.isInteger(timeoutMs)||timeoutMs<1000||timeoutMs>600000)throw new Error('Verification timeout must be an integer from 1000 to 600000 ms');
 const runtimeBefore=await runtimeFingerprint();
 const output=path.resolve(options.outputDir??'benchmark-results/public');await fs.mkdir(output,{recursive:true});const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'sentinel-public-'));const store=path.join(output,'store');await fs.mkdir(store,{recursive:true});
 const cases=(await loadPublicCases()).filter(c=>!options.caseIds||options.caseIds.includes(c.id));if(!cases.length)throw new Error('No public cases selected');
 const results:PublicResult[]=[];
 try{
  const dependencies=await preparePublicDependencies(path.join(temporary,'node_modules'));
  for(const c of cases){
   options.onProgress?.(`${c.id}: ${c.origin}`);const repo=path.join(temporary,c.id);const identity=await preparePublicCase(c,repo,dependencies);
   await git(['checkout',identity.baselineCommit],repo);const baseline=await captureSnapshot(repo,store);await git(['checkout','evaluation-change'],repo);const candidate=await captureSnapshot(repo,store);
   const contract=contractForPublicCase(c),contractHash=contract?await putObject(store,JSON.stringify(contract)):null;
   const opts={store,baseline,candidate,contract,contractHash,dependencies,timeoutMs};const receipt=await verify(opts);const receiptHash=await putObject(store,JSON.stringify(receipt));
   const ordinary=receipt.checks.find(x=>x.id==='candidate-tests');const expected=receipt.checks.find(x=>x.id===c.expectedCheck);const envFailure=receipt.checks.some(x=>x.status==='ENVIRONMENT FAILURE');
   const repeat=options.replay===false?null:await verify(opts);if(repeat)await putObject(store,JSON.stringify(repeat));
   const result:PublicResult={id:c.id,project:c.project,origin:c.origin,classification:c.classification,expectedCheck:c.expectedCheck,expectedStatus:c.expectedStatus,actualStatus:expected?.status??'MISSING',matched:expected?.status===c.expectedStatus&&!envFailure&&(c.classification!=='correct'||receipt.status==='VERIFIED'),receiptStatus:receipt.status,receiptHash,baselineHash:receipt.baselineHash,candidateHash:receipt.candidateHash,contractHash:receipt.contractHash,ordinaryStatus:ordinary?.status??'MISSING',ordinaryPassed:ordinary?.status==='VERIFIED',durationMs:receipt.durationMs,ordinaryDurationMs:ordinary?.command?.durationMs??0,reproduced:repeat?semantic(receipt)===semantic(repeat):true,counterexamples:receipt.checks.filter(x=>x.status==='CONTRADICTED'&&x.args).map(x=>({requirement:x.label,args:x.args!,expected:x.expected,observed:x.observed})),changes:receipt.changes};results.push(result);
   options.onProgress?.(`  ${result.matched?'✓':'✗'} ordinary=${result.ordinaryStatus}; specified check=${result.actualStatus}; overall=${receipt.status}`);
  }
 }finally{await fs.rm(temporary,{recursive:true,force:true});}
 const require=createRequire(import.meta.url);const defects=results.filter(r=>r.classification==='defect'||r.classification==='known-miss'),correct=results.filter(r=>r.classification==='correct');
 const runtimeAfter=await runtimeFingerprint();
 const summary={schemaVersion:1,configuration:{timeoutMs},runtime:{before:runtimeBefore,after:runtimeAfter,stable:JSON.stringify(runtimeBefore)===JSON.stringify(runtimeAfter)},loadAverages:os.loadavg(),createdAt:new Date().toISOString(),sentinelVersion:require('../package.json').version,environment:{node:process.version,platform:process.platform,arch:process.arch,vitest:require('vitest/package.json').version},casesHash:digest(await fs.readFile(path.join(corpus,'cases.json'))),provenanceHash:digest(await fs.readFile(path.join(corpus,'provenance.json'))),results,metrics:{cases:results.length,expectedOutcomesMatched:results.filter(r=>r.matched).length,defectsSignalled:results.filter(r=>['defect','known-miss'].includes(r.classification)&&['CONTRADICTED','REVIEW REQUIRED'].includes(r.receiptStatus)).length,defectCases: defects.length,knownSpecificationMisses:results.filter(r=>r.classification==='known-miss'&&r.receiptStatus==='VERIFIED').length,correctAccepted:correct.filter(r=>r.receiptStatus==='VERIFIED').length,correctCases:correct.length,ordinaryDefectsDetected:defects.filter(r=>r.ordinaryStatus==='CONTRADICTED').length,replayAgreement:results.filter(r=>r.reproduced).length,verificationMs:results.reduce((n,r)=>n+r.durationMs,0),ordinaryMs:results.reduce((n,r)=>n+r.ordinaryDurationMs,0)},limitations:['Two small public projects are a case study, not an externally sampled detection-rate estimate.','Only is-number issue #3 and its exact fix are historical; normalize-path changes and the partial repair are explicitly seeded evaluation candidates.','The full upstream assertion bodies run through a declared Mocha-to-Vitest registration adapter; this is not represented as the original upstream CI configuration.','A deliberate narrow-contract case demonstrates a surviving real defect despite all scoped approved checks passing.','Competitor timings and independently executed upstream Mocha results are reported separately by compare.mjs; no unavailable result is inferred.']};
 await fs.writeFile(path.join(output,'results.json'),JSON.stringify(summary,null,2)+'\n');await fs.writeFile(path.join(output,'RESULTS.md'),`# Independent public-project case study\n\n${summary.createdAt}; ${JSON.stringify(summary.environment)}\n\n| Case | Origin | Ordinary adapted tests | Specified check | Overall | Repeated |\n|---|---|---|---|---|---|\n${results.map(r=>`| ${r.id} | ${r.origin} | ${r.ordinaryStatus} | ${r.actualStatus} | ${r.receiptStatus} | ${r.reproduced?'agreed':'DIFFERED'} |`).join('\n')}\n\nMetrics: ${JSON.stringify(summary.metrics)}\n\n${summary.limitations.map(s=>'- '+s).join('\n')}\n`);return summary;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const {values}=parseArgs({options:{'timeout-ms':{type:'string'}}});
 runPublicBenchmark({timeoutMs:values['timeout-ms']?Number(values['timeout-ms']):undefined,onProgress:console.log}).then(result=>{if(!result.runtime.stable||result.metrics.expectedOutcomesMatched!==result.metrics.cases||result.metrics.replayAgreement!==result.metrics.cases)process.exitCode=1;}).catch(error=>{console.error(error);process.exitCode=2;});
}
