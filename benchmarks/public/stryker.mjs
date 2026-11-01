/** Mutation-strength experiment on the archived historical is-number implementation. */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadPublicCases, preparePublicCase, preparePublicDependencies } from '../../dist/public-benchmark.js';
import { runCommand } from '../../dist/process.js';
import { digest } from '../../dist/store.js';
const tools=path.resolve(process.argv[2]??'benchmark-results/public-tools/node_modules');
const output=path.resolve(process.argv[3]??'benchmark-results/public-stryker');
await fs.mkdir(output,{recursive:true});
const version=JSON.parse(await fs.readFile(path.join(tools,'@stryker-mutator/core/package.json'),'utf8')).version;
if(version!=='10.1.1')throw new Error('The recorded experiment requires StrykerJS 10.1.1.');
const shellQuote=value=>"'"+value.replaceAll("'","'\\''")+"'";
const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'sentinel-public-stryker-'));
try{
 const dependencies=await preparePublicDependencies(path.join(temporary,'node_modules'),tools);
 const c=(await loadPublicCases()).find(c=>c.id==='is-number-historical-nonfix');
 const repo=path.join(temporary,'project');await preparePublicCase(c,repo,dependencies);
 // Isolate the mutation tool from the unrelated Vitest adapter. Original test.js is unchanged.
 const config={mutate:['index.js'],testRunner:'command',commandRunner:{command:`node ${shellQuote(path.join(tools,'mocha/bin/mocha.js'))} test.js --reporter dot`},concurrency:1,reporters:['clear-text','json'],jsonReporter:{fileName:'mutation.json'},coverageAnalysis:'off',timeoutMS:10000,timeoutFactor:2,cleanTempDir:true};
 await fs.writeFile(path.join(repo,'stryker.config.json'),JSON.stringify(config,null,2));
 const ordinary=await runCommand([process.execPath,path.join(tools,'mocha/bin/mocha.js'),'test.js','--reporter','json'],repo,{timeoutMs:30000});
 const mutation=await runCommand([process.execPath,path.join(tools,'@stryker-mutator/core/bin/stryker.js'),'run'],repo,{timeoutMs:600000});
 await fs.writeFile(path.join(output,'stryker.log'),mutation.stdout+'\n'+mutation.stderr);
 let report;try{report=JSON.parse(await fs.readFile(path.join(repo,'mutation.json'),'utf8'));}catch{await fs.writeFile(path.join(output,'failure.json'),JSON.stringify({status:'ENVIRONMENT FAILURE',exitCode:mutation.exitCode,timedOut:mutation.timedOut,durationMs:mutation.durationMs,loadAverages:os.loadavg(),note:'No completed mutation report; no score inferred.'},null,2)+'\n');throw new Error('Mutation experiment produced no completed report; see failure.json and stryker.log');}
 const counts={};for(const file of Object.values(report.files))for(const m of file.mutants)counts[m.status]=(counts[m.status]??0)+1;
 const detected=(counts.Killed??0)+(counts.Timeout??0),valid=detected+(counts.Survived??0)+(counts.NoCoverage??0);
 const observation=await runCommand([process.execPath,'-e',`console.log(JSON.stringify({input:' ',observed:require('./index.js')(' '),expected:false}))`],repo,{timeoutMs:30000});
 const summary={schemaVersion:1,createdAt:new Date().toISOString(),versions:{stryker:version,mocha:JSON.parse(await fs.readFile(path.join(tools,'mocha/package.json'),'utf8')).version},environment:{node:process.version,platform:process.platform,arch:process.arch,loadAverages:os.loadavg()},overallTimeoutMs:600000,project:c.project,case:c.id,sourceHash:digest(await fs.readFile(path.join(repo,'index.js'))),config:{...config,commandRunner:{command:'node <tools>/mocha/bin/mocha.js test.js --reporter dot'}},ordinary:{exitCode:ordinary.exitCode,durationMs:ordinary.durationMs,stats:JSON.parse(ordinary.stdout).stats},mutation:{exitCode:mutation.exitCode,durationMs:mutation.durationMs,statuses:counts,score:valid?100*detected/valid:null},independentObservation:JSON.parse(observation.stdout),limitation:'Mutation testing evaluates the selected test oracle. It does not derive the issue requirement; a surviving mutant is not by itself evidence of the historical whitespace defect.'};
 await fs.writeFile(path.join(output,'results.json'),JSON.stringify(summary,null,2)+'\n');
 await fs.writeFile(path.join(output,'mutation.json'),JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify(summary,null,2));
 if(ordinary.exitCode!==0||mutation.exitCode!==0)process.exitCode=1;
}finally{await fs.rm(temporary,{recursive:true,force:true});}
