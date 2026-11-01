import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { captureSnapshot, putObject } from './store.js';
import { verify } from './verifier.js';
import type { Contract, Json, Probe, Receipt, Requirement } from './types.js';

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export interface BenchmarkCase {
  id: string; split: 'development' | 'held-out'; category: string; expected: 'accept' | 'detect';
  explanation: string; baseline: string; candidate: string; visibleArgs: Json[]; visibleExpected: Json;
  candidateTest?: 'removed' | 'substring' | 'skip'; changeCi?: boolean;
  expectedCheck: string; expectedStatus: string; ordinaryExpectedGreen: boolean;
  requirement: Omit<Requirement, 'id' | 'module' | 'export'>; probe?: Probe;
}
export interface BenchmarkResult {
  id: string; split: string; category: string; expected: string; actual: string; matched: boolean;
  ordinaryGreen: boolean; sentinelStatus: string; durationMs: number; ordinaryDurationMs: number;
  receiptHash: string; replayReceiptHash?: string; reproduced?: boolean;
  evidence: { id: string; status: string; detail: string }[];
}
export interface BenchmarkSummary {
  schemaVersion: 1; generatedAt: string; environment: Record<string, string>; casesHash: string;
  results: BenchmarkResult[]; metrics: { cases: number; matched: number; detection: string;
    ordinaryDetection: string; falsePositives: string; greenTestProblemsDetected: number;
    reproducibility: string; verificationMs: number; ordinaryTestsMs: number };
  limitations: string[];
}
export async function loadCases(): Promise<BenchmarkCase[]> {
  return JSON.parse(await readFile(join(root, 'benchmarks/cases.json'), 'utf8')) as BenchmarkCase[];
}
const escapeString = (v: Json) => JSON.stringify(v);
function visibleTest(c: BenchmarkCase, mode?: BenchmarkCase['candidateTest']): string {
  if (mode === 'removed') return '// The behaviour test was removed.\n';
  const operation = mode === 'substring' ? ".toContain('Hello')" : `.toEqual(${escapeString(c.visibleExpected)})`;
  return `import { test, expect } from 'vitest';\nimport { value } from '../src/value.js';\n` +
    `test${mode === 'skip' ? '.skip' : ''}('visible fixture', () => { expect(value(${c.visibleArgs.map(escapeString).join(',')}))${operation}; });\n`;
}
function fingerprint(receipt: Receipt): string {
  // Duration, absolute staging paths and random receipt IDs intentionally differ between runs.
  return JSON.stringify({ status: receipt.status, changes: receipt.changes.map(c => [c.path,c.classification]),
    checks: receipt.checks.map(c => [c.id,c.status,c.args,c.expected,c.observed,c.baseline,c.counterexample?.minimal]) });
}
function markdown(summary: BenchmarkSummary): string {
  const m = summary.metrics;
  return `# SENTINEL reproducible benchmark\n\nGenerated ${summary.generatedAt}. Synthetic controlled experiments; not third-party agent evaluations.\n\n` +
    `Environment: ${Object.entries(summary.environment).map(([k,v]) => `${k}=${v}`).join(', ')}.\nCases SHA-256: \`${summary.casesHash}\`.\n\n` +
    `- Expected outcomes matched: ${m.matched}/${m.cases}\n- Problem detection: ${m.detection}\n- Ordinary test detection: ${m.ordinaryDetection}\n- False positives on legitimate cases: ${m.falsePositives}\n- Problems exposed despite green ordinary tests: ${m.greenTestProblemsDetected}\n- Repeat verification agreement: ${m.reproducibility}\n- Total verification time: ${(m.verificationMs/1000).toFixed(2)}s; ordinary candidate tests: ${(m.ordinaryTestsMs/1000).toFixed(2)}s\n\n` +
    `| Case | Split | Expected | Ordinary tests | SENTINEL | Expected outcome | Repeat | Time |\n|---|---|---|---|---|---|---|---|\n` +
    summary.results.map(r => `| ${r.id} | ${r.split} | ${r.expected} | ${r.ordinaryGreen?'green':'not green'} | ${r.sentinelStatus} | ${r.matched?'matched':'MISMATCH'} | ${r.reproduced===undefined?'not run':r.reproduced?'agreed':'DIFFERED'} | ${(r.durationMs/1000).toFixed(2)}s |`).join('\n') +
    '\n\n## Limitations\n\n' + summary.limitations.map(s => `- ${s}`).join('\n') + '\n';
}
export async function runBenchmark(options: { outputDir?: string; caseIds?: string[]; replay?: boolean; onProgress?: (line:string)=>void } = {}): Promise<BenchmarkSummary> {
  const output = resolve(options.outputDir ?? 'benchmark-results/latest');
  const store = join(output, 'store');
  await mkdir(store, {recursive:true});
  const all = await loadCases();
  const cases = options.caseIds ? all.filter(c => options.caseIds!.includes(c.id)) : all;
  if (cases.length === 0) throw new Error('No benchmark cases selected');
  const casesHash = await putObject(store, await readFile(join(root, 'benchmarks/cases.json')));
  const results: BenchmarkResult[] = [];
  for (const c of cases) {
    options.onProgress?.(`${c.id}: ${c.explanation}`);
    const repo = await mkdtemp(join(tmpdir(), 'sentinel-bench-'));
    try {
      await mkdir(join(repo,'src')); await mkdir(join(repo,'test')); await mkdir(join(repo,'.github/workflows'), {recursive:true});
      await writeFile(join(repo,'package.json'), JSON.stringify({name:'sentinel-controlled-benchmark',private:true,type:'module'}));
      await writeFile(join(repo,'.gitignore'), 'node_modules/\n');
      await writeFile(join(repo,'src/value.js'), c.baseline+'\n');
      await writeFile(join(repo,'test/value.test.js'), visibleTest(c));
      await writeFile(join(repo,'test/smoke.test.js'), "import {test,expect} from 'vitest'; test('ordinary smoke', () => expect(1+1).toBe(2));\n");
      await writeFile(join(repo,'.github/workflows/ci.yml'), 'name: checks\non: push\njobs:\n  tests:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npx vitest run\n');
      await symlink(join(root,'node_modules'), join(repo,'node_modules'), 'dir');
      await exec('git',['init','-q',repo]);
      await exec('git',['-C',repo,'add','.']);
      await exec('git',['-C',repo,'-c','user.name=SENTINEL benchmark','-c','user.email=benchmark@example.invalid','-c','commit.gpgsign=false','commit','-qm','Independent baseline']);
      const baseline = await captureSnapshot(repo,store);
      await writeFile(join(repo,'src/value.js'), c.candidate+'\n');
      if(c.candidateTest==='removed') await rm(join(repo,'test/value.test.js'));
      else if(c.candidateTest) await writeFile(join(repo,'test/value.test.js'), visibleTest(c,c.candidateTest));
      if(c.changeCi) await writeFile(join(repo,'.github/workflows/ci.yml'), 'name: checks\non: push\njobs:\n  tests:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo all-good\n');
      const candidate = await captureSnapshot(repo,store);
      const contract: Contract = {schemaVersion:1,objective:c.explanation,approvedBy:'Bundled benchmark specification',
        allowedPaths:['src/value.js'],requirements:[{id:'required-behaviour',module:'src/value.js',export:'value',...c.requirement}],
        probes:c.probe?[c.probe]:[]};
      const contractHash = await putObject(store,JSON.stringify(contract));
      const opts = {store,baseline,candidate,contract,contractHash,dependencies:join(root,'node_modules'),timeoutMs:c.id==='execution-hang'?3000:15000};
      const receipt = await verify(opts);
      const receiptHash = await putObject(store,JSON.stringify(receipt));
      const ordinary = receipt.checks.find(x => x.id==='candidate-tests');
      const requirement = receipt.checks.find(x => x.id==='req:required-behaviour');
      const signals = receipt.checks.filter(x => x.id!=='baseline-tests' && ['CONTRADICTED','REVIEW REQUIRED','ENVIRONMENT FAILURE'].includes(x.status));
      const signalled = signals.length>0 || receipt.changes.some(x=>['CONTRADICTED','REVIEW REQUIRED','ENVIRONMENT FAILURE'].includes(x.classification));
      const expectedSignal = c.expectedCheck==='changed-control'
        ? receipt.changes.some(x=>x.classification===c.expectedStatus && (x.path.startsWith('test/')||x.path.startsWith('.github/')))
        : receipt.checks.some(x=>x.id===c.expectedCheck&&x.status===c.expectedStatus);
      const unexpectedFailure = receipt.checks.some(x=>x.status==='ENVIRONMENT FAILURE' && !(c.id==='execution-hang'&&x.id===c.expectedCheck));
      const actual = unexpectedFailure?'environment failure':signalled?'detect':requirement?.status==='VERIFIED'?'accept':'unverified';
      const ordinaryGreen = ordinary?.command?.exitCode===0 && !ordinary.command.timedOut && !ordinary.command.truncated && !ordinary.command.signal;
      const result: BenchmarkResult = {id:c.id,split:c.split,category:c.category,expected:c.expected,actual,
        matched:actual===c.expected&&expectedSignal&&ordinaryGreen===c.ordinaryExpectedGreen,ordinaryGreen,sentinelStatus:receipt.status,
        durationMs:receipt.durationMs,ordinaryDurationMs:ordinary?.command?.durationMs??0,receiptHash,
        evidence:signals.map(x=>({id:x.id,status:x.status,detail:x.detail}))};
      if(options.replay!==false) {
        const replay = await verify(opts);
        result.replayReceiptHash = await putObject(store,JSON.stringify(replay));
        result.reproduced = fingerprint(replay)===fingerprint(receipt);
      }
      results.push(result);
      options.onProgress?.(`  ${result.matched?'✓':'✗'} ordinary=${result.ordinaryGreen?'green':'not green'} sentinel=${receipt.status} (${(receipt.durationMs/1000).toFixed(2)}s)`);
    } finally { await rm(repo,{recursive:true,force:true}); }
  }
  const require = createRequire(import.meta.url);
  const negatives = results.filter(r=>r.expected==='detect');
  const positives = results.filter(r=>r.expected==='accept');
  const replays = results.filter(r=>r.reproduced!==undefined);
  const summary: BenchmarkSummary = {schemaVersion:1,generatedAt:new Date().toISOString(),casesHash,
    environment:{node:process.version,platform:process.platform,arch:process.arch,vitest:String(require('vitest/package.json').version)},results,
    metrics:{cases:results.length,matched:results.filter(r=>r.matched).length,
      detection:`${negatives.filter(r=>r.actual==='detect').length}/${negatives.length}`,
      ordinaryDetection:`${negatives.filter(r=>!r.ordinaryGreen).length}/${negatives.length}`,
      falsePositives:`${positives.filter(r=>r.actual==='detect').length}/${positives.length}`,
      greenTestProblemsDetected:negatives.filter(r=>r.ordinaryGreen&&r.actual==='detect').length,
      reproducibility:`${replays.filter(r=>r.reproduced).length}/${replays.length}`,
      verificationMs:results.reduce((n,r)=>n+r.durationMs,0),ordinaryTestsMs:results.reduce((n,r)=>n+r.ordinaryDurationMs,0)},
    limitations:[
      'These small synthetic cases measure regression detection and review signals, not accuracy on arbitrary real projects or named coding agents.',
      'The held-out cases were specified before the first benchmark run, but are public and share the same JSON contract format; this is not a blind independent evaluation.',
      'Detection includes human-review signals for altered tests and CI. A review signal is not an accusation of malicious intent.',
      'Verification time includes baseline, ordinary candidate, preserved-test, behavioural and mutation checks; ordinary time measures only candidate Vitest execution. Replay time is additional.',
      'Reproducibility compares semantic classifications and observed values across two executions, not timestamps, temporary paths or byte-identical receipts.',
      'No statistical confidence interval is appropriate for this small authored corpus. False-positive rates do not generalise beyond the included legitimate cases.',
      'Session interruption, checkpoint corruption and protected-input integrity are exercised separately by automated integration tests.',
      'Externally enforced isolation and merge gating are outside this local advisory benchmark.'
    ]};
  await writeFile(join(output,'results.json'),JSON.stringify(summary,null,2)+'\n');
  await writeFile(join(output,'RESULTS.md'),markdown(summary));
  return summary;
}
if (process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const summary = await runBenchmark({onProgress:console.log});
  console.log(`\n${summary.metrics.matched}/${summary.metrics.cases} expected outcomes matched; results: benchmark-results/latest/RESULTS.md`);
  if(summary.results.some(r=>!r.matched||r.reproduced===false)) process.exitCode=1;
}
