import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { candidateSource, contractForPublicCase, loadPublicCases, validatePublicProvenance } from './public-benchmark.js';
import { digest, getObject, readSnapshot } from './store.js';
import { parseContract } from './schema.js';
import { executionEnvironment, runCommand } from './process.js';
import type { Example, Json, Receipt } from './types.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const corpus = path.join(root, 'benchmarks/public');
const caseId = 'is-number-historical-nonfix';
export const HISTORICAL_COMMIT = '204c885659b8ee1946534c61db91603b9a16d661';
// Declared before execution: preserved examples first, then the issue #3 case.
// The ordering is deliberately explicit because it determines the search cost.
export const SUMMARY_SEARCH_CASES: Example[] = [
  { args: [0], expected: true }, { args: [37], expected: true },
  { args: ['5e3'], expected: true }, { args: ['   56\r\n  '], expected: true },
  { args: ['3a'], expected: false }, { args: [''], expected: false },
  { args: [null], expected: false }, { args: [' '], expected: false },
];

export interface ReceiverObservation {
  observed: Json;
  durationMs: number;
  command: string[];
  input: string;
  stdout: string;
  stdoutHash: string;
  exitCode: number;
}
type Receiver = (args: Json[]) => Promise<ReceiverObservation>;
export interface RetentionStep extends ReceiverObservation { args: Json[]; expected: Json; matches: boolean; previouslyVerified: boolean }
export interface RetentionArm {
  name: 'saved-evidence' | 'summary-omits-counterexample' | 'summary-includes-counterexample' | 'summary-reversed-search';
  repositoryExecutions: number;
  repeatedExplorationExecutions: number;
  durationMs: number;
  counterexample: { args: Json[]; expected: Json; observed: Json };
  steps: RetentionStep[];
}

const sameExample = (a: Example, b: Example) => isDeepStrictEqual(a.args, b.args) && isDeepStrictEqual(a.expected, b.expected);
const summaryPrefix = 'Counterexample JSON: ';
export function informedSummaryExample(text: string): Example {
  const line = text.split('\n').find(value => value.startsWith(summaryPrefix));
  if (!line) throw new Error('The summary does not retain a machine-readable counterexample.');
  const value: unknown = JSON.parse(line.slice(summaryPrefix.length));
  const contract = parseContract({ schemaVersion: 1, objective: 'Validate a controlled summary example', approvedBy: 'Benchmark protocol input validation', requirements: [{ id: 'summary', kind: 'must-change', description: 'Summary example', module: 'index.js', export: 'default', cases: [value] }] });
  return contract.requirements[0]!.cases[0]!;
}

/** A prescribed deterministic receiver, not an LLM or a simulation of a named agent. */
export async function runRetentionTrials(failure: Example, previouslyVerified: Example[], receiver: Receiver, trialCount = 3) {
  if (!Number.isInteger(trialCount) || trialCount < 1 || trialCount > 10) throw new Error('Trial count must be an integer from 1 to 10.');
  if (!SUMMARY_SEARCH_CASES.some(example => sameExample(example, failure))) throw new Error('Recorded counterexample is outside the predeclared search set.');
  const ordinarySummary = 'The task is incomplete. Ordinary tests passed, but an independent behavioural check failed. Continue checking the approved examples.';
  const informedSummary = `${ordinarySummary}\n${summaryPrefix}${JSON.stringify(failure)}`;
  const strategies: { name: RetentionArm['name']; examples: Example[] }[] = [
    { name: 'saved-evidence', examples: [failure] },
    { name: 'summary-omits-counterexample', examples: SUMMARY_SEARCH_CASES },
    { name: 'summary-includes-counterexample', examples: [informedSummaryExample(informedSummary)] },
    { name: 'summary-reversed-search', examples: [...SUMMARY_SEARCH_CASES].reverse() },
  ];
  const trials: { trial: number; arms: RetentionArm[] }[] = [];
  for (let trial = 1; trial <= trialCount; trial++) {
    const arms: RetentionArm[] = [];
    for (const strategy of strategies) {
      const steps: RetentionStep[] = [];
      for (const example of strategy.examples) {
        const observation = await receiver(structuredClone(example.args));
        const matches = isDeepStrictEqual(observation.observed, example.expected);
        steps.push({ ...observation, args: structuredClone(example.args), expected: structuredClone(example.expected), matches, previouslyVerified: previouslyVerified.some(prior => sameExample(prior, example)) });
        if (!matches) break;
      }
      const last = steps.at(-1);
      if (!last || last.matches) throw new Error(`${strategy.name}: no defect reproduced; this trial cannot support the declared comparison.`);
      arms.push({ name: strategy.name, repositoryExecutions: steps.length, repeatedExplorationExecutions: steps.filter(step => step.previouslyVerified).length, durationMs: steps.reduce((sum, step) => sum + step.durationMs, 0), counterexample: { args: last.args, expected: last.expected, observed: last.observed }, steps });
    }
    trials.push({ trial, arms });
  }
  return { ordinarySummary, informedSummary, searchCases: structuredClone(SUMMARY_SEARCH_CASES), trials };
}

/** Validate an existing verifier receipt; this function never manufactures one. */
export async function loadHistoricalFailure(store: string, receiptHash: string) {
  await validatePublicProvenance();
  const c = (await loadPublicCases()).find(item => item.id === caseId)!;
  if (!c) throw new Error('Pinned historical case definition is missing.');
  const receipt = JSON.parse((await getObject(store, receiptHash)).toString()) as Receipt;
  if (receipt.schemaVersion !== 1 || receipt.status !== 'CONTRADICTED' || !receipt.contractHash || !Array.isArray(receipt.checks)) throw new Error('A completed, contradicted historical verification receipt is required.');
  if (receipt.checks.some(check => check.status === 'ENVIRONMENT FAILURE')) throw new Error('Incomplete verification cannot seed this experiment.');
  const ordinary = receipt.checks.find(check => check.id === 'candidate-tests');
  if (ordinary?.status !== 'VERIFIED') throw new Error('The historical ordinary suite must have passed in the saved receipt.');
  const contractObjectBytes = (await getObject(store, receipt.contractHash)).toString();
  const contract = parseContract(JSON.parse(contractObjectBytes));
  if (!isDeepStrictEqual(contract, contractForPublicCase(c))) throw new Error('Receipt contract does not match the predeclared historical case.');
  const baseline = await readSnapshot(store, receipt.baselineHash), candidate = await readSnapshot(store, receipt.candidateHash);
  const pinned = await fs.readFile(path.join(corpus, 'projects/is-number/index.js'), 'utf8');
  const expectedCandidate = candidateSource(c, pinned, '');
  if (baseline.files['index.js']?.hash !== digest(pinned) || candidate.files['index.js']?.hash !== digest(expectedCandidate)) throw new Error('Receipt source does not match the pinned historical implementation and declared comment-only candidate.');
  const check = receipt.checks.find(item => item.id === 'req:whitespace');
  if (check?.status !== 'CONTRADICTED' || !check.args || check.expected !== false || check.observed !== true || !check.command || check.command.exitCode !== 0 || check.command.timedOut || check.command.truncated || check.command.signal) throw new Error('A successfully executed whitespace counterexample is required.');
  const failure = { args: check.args, expected: check.expected };
  const approved = contract.requirements.flatMap(requirement => requirement.cases);
  if (!approved.some(example => sameExample(example, failure)) || SUMMARY_SEARCH_CASES.some(example => !approved.some(approvedCase => sameExample(example, approvedCase)))) throw new Error('Search examples and counterexample must retain the approved contract expectations.');
  const previouslyVerified = contract.requirements.filter(requirement => receipt.checks.some(item => item.id === `req:${requirement.id}` && item.status === 'VERIFIED')).flatMap(requirement => requirement.cases);
  return {
    source: await getObject(store, candidate.files['index.js']!.hash), failure, previouslyVerified,
    evidence: { receiptHash, baselineHash: receipt.baselineHash, candidateHash: receipt.candidateHash, contractHash: receipt.contractHash, sourceFileHash: candidate.files['index.js']!.hash, upstreamSourceFileHash: baseline.files['index.js']!.hash, checkId: check.id, args: check.args, expected: check.expected, observed: check.observed, baselineObserved: check.baseline, ordinaryStatus: ordinary.status, status: receipt.status },
    contract, contractObjectBytes,
  };
}

const probeScript = "const fs=require('node:fs');const args=JSON.parse(fs.readFileSync(0,'utf8'));const fn=require('./index.js');process.stdout.write(JSON.stringify({observed:fn(...args)}));";
/** Executes only the pinned public function and archived dependencies. This is local advisory execution. */
export async function createHistoricalReceiver(source: Buffer, timeoutMs = 15000) {
  await validatePublicProvenance();
  const pinned = await fs.readFile(path.join(corpus, 'projects/is-number/index.js'));
  const historical = (await loadPublicCases()).find(item => item.id === caseId)!;
  const allowed = [digest(pinned), digest(candidateSource(historical, pinned.toString(), ''))];
  if (!allowed.includes(digest(source))) throw new Error('Refusing to execute source outside the pinned historical case.');
  const manifest = JSON.parse(await fs.readFile(path.join(corpus, 'provenance.json'), 'utf8')) as { files: Record<string, string> };
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sentinel-retention-'));
  const dependencyHashes: Record<string, string> = {};
  try {
    await fs.writeFile(path.join(directory, 'index.js'), source);
    await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({ type: 'commonjs' }));
    for (const dependency of ['kind-of', 'is-buffer']) for (const name of ['index.js', 'package.json', 'LICENSE']) {
      const relative = `dependencies/${dependency}/${name}`;
      const bytes = await fs.readFile(path.join(corpus, relative));
      if (digest(bytes) !== manifest.files[relative]) throw new Error(`Dependency identity changed: ${relative}`);
      const destination = path.join(directory, 'node_modules', dependency, name);
      await fs.mkdir(path.dirname(destination), { recursive: true }); await fs.writeFile(destination, bytes);
      dependencyHashes[relative] = digest(bytes);
    }
    const execute: Receiver = async args => {
      const input = JSON.stringify(args);
      const result = await runCommand([process.execPath, '--input-type=commonjs', '-e', probeScript], directory, { input, timeoutMs, env: executionEnvironment() });
      if (result.exitCode !== 0 || result.signal || result.timedOut || result.truncated) throw new Error(`Historical function execution failed: ${result.timedOut ? 'timeout' : result.signal ?? result.exitCode}. No successful comparison was recorded.`);
      const resultValue: unknown = JSON.parse(result.stdout);
      if (!resultValue || typeof resultValue !== 'object' || typeof (resultValue as { observed?: unknown }).observed !== 'boolean') throw new Error('Historical function returned an unexpected observation.');
      return { observed: (resultValue as { observed: boolean }).observed, durationMs: result.durationMs, command: ['<node>', ...result.command.slice(1)], input, stdout: result.stdout, stdoutHash: digest(result.stdout), exitCode: result.exitCode };
    };
    return { execute, dependencyHashes, close: () => fs.rm(directory, { recursive: true, force: true }) };
  } catch (error) { await fs.rm(directory, { recursive: true, force: true }); throw error; }
}

export async function runHandoffBenchmark(options: { store?: string; receiptHash?: string; outputDir?: string; allowLocal: boolean }) {
  if (!options.allowLocal) throw new Error('This controlled experiment executes pinned public code locally. Review it and pass --allow-local.');
  const store = path.resolve(options.store ?? path.join(root, 'benchmark-results/public/store'));
  let receiptHash = options.receiptHash;
  if (!receiptHash) {
    const results = JSON.parse(await fs.readFile(path.join(path.dirname(store), 'results.json'), 'utf8')) as { results: { id: string; receiptHash: string }[] };
    receiptHash = results.results.find(result => result.id === caseId)?.receiptHash;
  }
  if (!receiptHash) throw new Error('Run the public historical benchmark first or supply --receipt and --store.');
  const failure = await loadHistoricalFailure(store, receiptHash);
  const implementationHash = digest(await fs.readFile(fileURLToPath(import.meta.url)));
  const runner = await createHistoricalReceiver(failure.source);
  try {
    const comparison = await runRetentionTrials(failure.failure, failure.previouslyVerified, runner.execute, 3);
    const result = {
      schemaVersion: 1, experiment: 'Controlled continuation information-retention comparison', createdAt: new Date().toISOString(),
      environment: { node: process.version, platform: process.platform, arch: process.arch, loadAverages: os.loadavg() },
      protocol: { caseId, upstreamCommit: HISTORICAL_COMMIT, trialCount: 3, implementationHash, searchOrderHash: digest(JSON.stringify(SUMMARY_SEARCH_CASES)), repositoryExecutionUnit: 'One fresh Node process invoking the historical exported function once', inputSelection: 'Fixed preserved-example-first order; receivers do not interpret natural-language summaries', ordinarySuiteReruns: 0, dependencies: runner.dependencyHashes },
      evidence: failure.evidence, approvedContract: failure.contract, approvedContractObjectBytes: failure.contractObjectBytes, ...comparison,
      totals: { repositoryExecutions: comparison.trials.flatMap(trial => trial.arms).reduce((sum, arm) => sum + arm.repositoryExecutions, 0), repeatedExplorationExecutions: comparison.trials.flatMap(trial => trial.arms).reduce((sum, arm) => sum + arm.repeatedExplorationExecutions, 0) },
      limitations: [
        'This measures retention of one known counterexample, not live model productivity, developer effort, or a causal benefit from SENTINEL.',
        'The summary baseline deliberately omits the counterexample and follows a declared search order. The expected execution-count difference is a consequence of those information and ordering choices.',
        'A summary retaining the same counterexample matches evidence replay; reversing this search order also reaches the failure immediately.',
        'All arms have the same pinned source and approved expectations. The protocol receiver does not reason from the objective or infer input priorities.',
        'One small historical project and three identical deterministic repetitions are not a statistical performance sample.',
        'The prior verification cost is excluded. Repository executions count single function invocations in fresh Node processes, not full suites, tokens, or developer minutes.',
        'The original receipt was validated in the local content store. Its hash is retained; local command paths are omitted from this publishable measurement.',
        'The function and archived dependencies run under the local OS account; temporary directories are not a security boundary.',
      ],
    };
    const outputDir = path.resolve(options.outputDir ?? path.join(root, 'benchmark-results/handoff'));
    await fs.mkdir(outputDir, { recursive: true });
    await fs.writeFile(path.join(outputDir, 'results.json'), JSON.stringify(result, null, 2) + '\n');
    return result;
  } finally { await runner.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { store: { type: 'string' }, receipt: { type: 'string' }, out: { type: 'string' }, 'allow-local': { type: 'boolean' } } });
  runHandoffBenchmark({ store: values.store, receiptHash: values.receipt, outputDir: values.out, allowLocal: values['allow-local'] === true }).then(result => console.log(JSON.stringify({ evidence: result.evidence, trials: result.trials.map(trial => ({ trial: trial.trial, arms: trial.arms.map(({ name, repositoryExecutions, repeatedExplorationExecutions }) => ({ name, repositoryExecutions, repeatedExplorationExecutions })) })), totals: result.totals }, null, 2))).catch(error => { console.error(String(error)); process.exitCode = 2; });
}
