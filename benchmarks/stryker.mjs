// A small reproducible capability comparison, not an overall ranking.
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';

const versions = { stryker: '10.1.1', vitest: '5.0.5' };
const output = resolve(process.argv[2] ?? 'benchmark-results/stryker');
const project = await mkdtemp(join(tmpdir(),'sentinel-stryker-'));
const run = (command,args,cwd,timeoutMs=120000) => new Promise((accept,reject)=>{
  const child = spawn(command,args,{cwd,env:{...process.env,NO_COLOR:'1',CI:'1'},stdio:['ignore','pipe','pipe']});
  let stdout='',stderr=''; const started=performance.now();
  const timeout=setTimeout(()=>child.kill('SIGKILL'),timeoutMs);
  child.stdout.on('data',c=>stdout+=c);child.stderr.on('data',c=>stderr+=c);
  child.on('error',e=>{clearTimeout(timeout);reject(e);});
  child.on('close',(exitCode,signal)=>{clearTimeout(timeout);accept({command:[command,...args],exitCode,signal,stdout,stderr,durationMs:Math.round(performance.now()-started)});});
});
try {
  await mkdir(join(project,'src'));await mkdir(join(project,'test'));await mkdir(output,{recursive:true});
  await writeFile(join(project,'package.json'),JSON.stringify({name:'sentinel-stryker-comparison',private:true,type:'module',devDependencies:{'@stryker-mutator/core':versions.stryker,vitest:versions.vitest}},null,2));
  await writeFile(join(project,'src/access.js'), 'export function isAdult(age) { return age >= 18; }\n');
  await writeFile(join(project,'test/access.test.js'), "import {test,expect} from 'vitest';\nimport {isAdult} from '../src/access.js';\ntest('adult',()=>expect(isAdult(18)).toBe(true));\ntest('minor',()=>expect(isAdult(17)).toBe(false));\n");
  const config={mutate:['src/access.js'],testRunner:'command',commandRunner:{command:'node node_modules/vitest/vitest.mjs run --maxWorkers=1 --no-file-parallelism'},concurrency:1,reporters:['clear-text','json'],jsonReporter:{fileName:'mutation.json'},coverageAnalysis:'off',timeoutMS:10000,timeoutFactor:2,cleanTempDir:true};
  await writeFile(join(project,'stryker.config.json'),JSON.stringify(config,null,2));
  console.log(`Installing isolated comparison tools: StrykerJS ${versions.stryker}, Vitest ${versions.vitest}`);
  const install=await run('npm',['install','--ignore-scripts','--no-audit','--no-fund'],project);
  if(install.exitCode!==0)throw new Error(`Comparison tool installation failed: ${install.stderr}`);
  console.log('Running visible tests');
  const ordinary=await run(process.execPath,['node_modules/vitest/vitest.mjs','run'],project);
  console.log('Running StrykerJS mutations of the same candidate and visible tests');
  const mutation=await run(process.execPath,['node_modules/@stryker-mutator/core/bin/stryker.js','run'],project);
  const raw=JSON.parse(await readFile(join(project,'mutation.json'),'utf8'));
  const mutants=Object.values(raw.files).flatMap(f=>f.mutants);
  const counts={};for(const m of mutants)counts[m.status]=(counts[m.status]??0)+1;
  const detected=(counts.Killed??0)+(counts.Timeout??0);const valid=detected+(counts.Survived??0)+(counts.NoCoverage??0);
  const score=valid?100*detected/valid:null;
  // This observation is a direct call of the unchanged candidate, not inferred from a score.
  const observed=await run(process.execPath,['--input-type=module','-e',"import {isAdult} from './src/access.js'; console.log(JSON.stringify({input:'18',observed:isAdult('18'),expected:false}));"],project);
  const summary={schemaVersion:1,generatedAt:new Date().toISOString(),environment:{node:process.version,platform:process.platform,arch:process.arch},versions,config,
    ordinary:{exitCode:ordinary.exitCode,durationMs:ordinary.durationMs},stryker:{exitCode:mutation.exitCode,durationMs:mutation.durationMs,mutantStatuses:counts,mutationScore:score},
    independentObservation:JSON.parse(observed.stdout),
    scope:'One deliberately coercive age-validation fixture. Stryker measures visible test strength; SENTINEL checks separately specified intent. No overall tool ranking or causal claim follows.'};
  await writeFile(join(output,'results.json'),JSON.stringify(summary,null,2)+'\n');
  await writeFile(join(output,'mutation.json'),JSON.stringify(raw,null,2)+'\n');
  await writeFile(join(output,'stryker.log'),mutation.stdout+'\n'+mutation.stderr);
  await writeFile(join(output,'package-lock.json'),await readFile(join(project,'package-lock.json')));
  console.log(JSON.stringify(summary,null,2));
  if(ordinary.exitCode!==0||mutation.exitCode!==0)process.exitCode=1;
} finally { await rm(project,{recursive:true,force:true}); }
