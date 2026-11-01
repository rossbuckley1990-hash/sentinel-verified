/** Optional comparison. Installs nothing; supply the pinned tools directory described in PUBLIC-EVALUATION.md. */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { loadPublicCases, preparePublicCase, preparePublicDependencies } from '../../dist/public-benchmark.js';
import { runCommand } from '../../dist/process.js';
import { digest } from '../../dist/store.js';
const tools=path.resolve(process.argv[2]??'benchmark-results/public-tools/node_modules');
const output=path.resolve(process.argv[3]??'benchmark-results/public-comparison');
await fs.mkdir(output,{recursive:true});
const require=createRequire(import.meta.url);
const version=name=>JSON.parse(require('node:fs').readFileSync(path.join(tools,name,'package.json'),'utf8')).version;
if(version('trustbut')!=='0.7.0'||version('mocha')!=='11.7.5')throw new Error('This comparison requires trustbut 0.7.0 and Mocha 11.7.5.');
const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'sentinel-competitors-'));
const config=path.join(temporary,'trustbut.json');
await fs.writeFile(config,JSON.stringify({runner:'mocha',args:['test.js'],timeoutSec:30}));
const cases=(await loadPublicCases()).filter(c=>!process.env.SENTINEL_CASE||c.id===process.env.SENTINEL_CASE);
const results=[];
try{
 const dependencies=await preparePublicDependencies(path.join(temporary,'node_modules'),tools);
 await fs.mkdir(path.join(dependencies,'.bin'),{recursive:true});
 await fs.symlink(path.join(tools,'mocha/bin/mocha.js'),path.join(dependencies,'.bin/mocha'));
 for(const c of cases){
  console.log(c.id);
  const repo=path.join(temporary,c.id);const identity=await preparePublicCase(c,repo,dependencies);
  const mochaCommand=[process.execPath,path.join(tools,'mocha/bin/mocha.js'),'test.js','--reporter','json'];
  const ordinary=await runCommand(mochaCommand,repo,{timeoutMs:30000});
  let ordinaryReport;try{ordinaryReport=JSON.parse(ordinary.stdout);}catch{}
  const receiptFile=path.join(output,c.id+'.trustbut.json');
  const trustbutCommand=[process.execPath,path.join(tools,'trustbut/dist/cli.js'),'verify','--base',identity.baselineCommit,'--head',identity.candidateCommit,'--runner','mocha','--config',config,'--json','--receipt-json',receiptFile];
  const comparison=await runCommand(trustbutCommand,repo,{timeoutMs:120000});
  let receipt;try{receipt=JSON.parse(await fs.readFile(receiptFile,'utf8'));}catch{}
  const raw={id:c.id,sourceHash:digest(await fs.readFile(path.join(repo,'index.js'))),baselineCommit:identity.baselineCommit,candidateCommit:identity.candidateCommit,ordinary,comparison};
  await fs.writeFile(path.join(output,c.id+'.raw.json'),JSON.stringify(raw,null,2)+'\n');
  const result={id:c.id,classification:c.classification,origin:c.origin,sourceHash:raw.sourceHash,ordinary:{exitCode:ordinary.exitCode,durationMs:ordinary.durationMs,tests:ordinaryReport?.stats?.tests,passes:ordinaryReport?.stats?.passes,failures:ordinaryReport?.stats?.failures},trustbut:{exitCode:comparison.exitCode,durationMs:comparison.durationMs,receipt:receipt??null}};
  results.push(result);console.log(`  Mocha ${ordinary.exitCode===0?'PASS':'FAIL'}; trustbut ${receipt?.verdict??receipt?.result??'inspect receipt'}`);
 }
}finally{await fs.rm(temporary,{recursive:true,force:true});}
const summary={schemaVersion:1,createdAt:new Date().toISOString(),environment:{node:process.version,platform:process.platform,arch:process.arch},versions:{trustbut:version('trustbut'),mocha:version('mocha')},commands:{ordinary:'node <tools>/mocha/bin/mocha.js test.js --reporter json',trustbut:'node <tools>/trustbut/dist/cli.js verify --base <baseline> --head <candidate> --runner mocha --config <external-config> --json --receipt-json <receipt>'},config:{runner:'mocha',args:['test.js'],timeoutSec:30},results};
await fs.writeFile(path.join(output,'results.json'),JSON.stringify(summary,null,2)+'\n');
