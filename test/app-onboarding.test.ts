import { afterEach, describe, expect, it } from 'vitest';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { approveApplicationPlan, discoverApplication, parseArgv } from '../src/app-onboarding.js';
import { discoverProject } from '../src/discovery.js';
import { captureSnapshot, digest, getObject, materializeSnapshot, putObject } from '../src/store.js';
import { parseContract, validateApprovalProposal } from '../src/schema.js';
import { verify } from '../src/verifier.js';
import { exportSession, importSession } from '../src/portable.js';
import { loadCheckpoint, saveCheckpoint } from '../src/session.js';
import type { Checkpoint, Contract } from '../src/types.js';
import type { PromptIO } from '../src/onboarding.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
function git(root: string) {
  for (const args of [['init', '-b', 'main'], ['add', '.'], ['-c', 'user.name=Controlled fixture', '-c', 'user.email=fixture@localhost', 'commit', '-m', 'Controlled fixture']]) execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], { cwd: root, stdio: 'ignore' });
}
async function project() {
  const root = await mkdtemp(join(tmpdir(), 'sentinel-app-onboarding-')); roots.push(root);
  const repo = join(root, 'repo'), store = join(root, 'store'); await mkdir(repo); await mkdir(store);
  await writeFile(join(repo, 'package.json'), JSON.stringify({ type: 'module', dependencies: { react: '19.3.1' }, scripts: { start: 'node server.js' } }));
  await writeFile(join(repo, 'server.js'), "import{createServer}from'node:http';createServer((req,res)=>{if(req.url==='/api/quote')res.end('17');}).listen(process.env.PORT);\n");
  await writeFile(join(repo, 'App.jsx'), 'export default function App(){return <output data-testid="total">17</output>;}\n');
  git(repo); const baseline = await captureSnapshot(repo, store), plan = await discoverProject(repo, 'Correct checkout rounding; POST /api/quote with quantity 3 returns total 19');
  const discovery = await discoverApplication(plan, baseline, store); if (!discovery) throw new Error('Controlled application not recognized');
  return { root, repo, store, baseline, plan, discovery };
}
type Answer = string | (() => Promise<string>);
function scripted(answers: Answer[], interactive = true) {
  const output: string[] = [], remaining = [...answers];
  const io: PromptIO = { interactive, write: text => output.push(text), ask: async prompt => { const answer = remaining.shift(); if (answer === undefined) throw new Error(`Unexpected prompt: ${prompt}`); return typeof answer === 'function' ? answer() : answer; }, close() {} };
  return { io, output, remaining };
}
const exampleAnswers = ['', '/api/quote', 'http', 'change', 'Quantity 3 has the approved total 19', '/api/quote', 'POST', '{"quantity":3}', '200', 'json', '{"total":19}'];

describe('application proposal approval (scripted UI, not live human evidence)', () => {
  it('discovers only locations and commands without treating implementation output as expected behaviour', async () => {
    const p = await project(); expect(p.discovery.category).toBe('React web application'); expect(p.discovery.command).toEqual(['node', 'server.js']);
    expect(p.discovery.routes).toContain('/api/quote'); expect(p.discovery.selectors).toContain('[data-testid="total"]');
    expect(Object.keys(p.discovery)).not.toContain('scenarios');
    expect(parseArgv('node "a b.js" --port {port}')).toEqual(['node', 'a b.js', '--port', '{port}']);
    expect(parseArgv('node server.js; touch bad')).toEqual(['node', 'server.js;', 'touch', 'bad']);
  });
  it('requires an interactive decision and binds command, scope and expected values to a protected proposal', async () => {
    const p = await project();
    await expect(approveApplicationPlan(p.plan, p.baseline, p.store, scripted([], false).io, p.discovery)).rejects.toThrow('interactive');
    const prompt = scripted([...exampleAnswers, 'approve', 'yes']);
    const result = await approveApplicationPlan(p.plan, p.baseline, p.store, prompt.io, p.discovery);
    expect(prompt.remaining).toEqual([]); expect(result.contract.schemaVersion).toBe(3); expect(result.contract.coverage?.confirmed).toBe(true);
    expect(result.contract.scenarios?.[0]).toMatchObject({ type: 'http', expected: { status: 200, bodyType: 'json', body: { total: 19 } } });
    expect(result.contract.approval?.baselineHash).toBe(p.baseline.hash);
    const proposal = JSON.parse((await getObject(p.store, result.proposalHash)).toString()); validateApprovalProposal(result.contract, proposal);
    for (const mutate of [
      (contract: Contract) => { contract.application!.command = ['node', 'other.js']; },
      (contract: Contract) => { contract.scenarios![0]!.description = 'Changed after review'; },
      (contract: Contract) => { contract.coverage!.confirmed = false; },
      (contract: Contract) => { contract.allowedPaths = ['unrelated.js']; },
      (contract: Contract) => { contract.unresolved = ['missing acceptance']; },
    ]) { const changed = structuredClone(result.contract); mutate(changed); expect(() => validateApprovalProposal(changed, proposal)).toThrow('differs'); }
    expect(resolve(result.contractPath).startsWith(resolve(p.repo) + '/')).toBe(false);
  });
  it('keeps explicitly limited or unresolved intent separate from full objective coverage', async () => {
    const p = await project(), prompt = scripted([...exampleAnswers, 'question', 'Tax-exempt checkout has no defined expected outcome', 'approve', 'limited']);
    const result = await approveApplicationPlan(p.plan, p.baseline, p.store, prompt.io, p.discovery);
    expect(result.contract.coverage?.confirmed).toBe(false);
    expect(result.contract.unresolved).toEqual(expect.arrayContaining(['Tax-exempt checkout has no defined expected outcome', 'Developer approved limited coverage of the objective; full-task completion remains unverified.']));
  });
  it('rejects approval when the source changed during review', async () => {
    const p = await project(), prompt = scripted([...exampleAnswers, 'approve', async () => { await writeFile(join(p.repo, 'App.jsx'), 'export default()=>null;'); return 'yes'; }]);
    await expect(approveApplicationPlan(p.plan, p.baseline, p.store, prompt.io, p.discovery)).rejects.toThrow('Source changed');
  });
  it('rejects unknown coverage references and duplicate function/application identifiers', async () => {
    const p = await project(), result = await approveApplicationPlan(p.plan, p.baseline, p.store, scripted([...exampleAnswers, 'approve', 'yes']).io, p.discovery);
    const unknown = structuredClone(result.contract); unknown.coverage!.aspects[0]!.requirementIds = ['not-reviewed']; expect(() => parseContract(unknown)).toThrow('unknown requirement');
    const duplicate = structuredClone(result.contract); duplicate.scenarios!.push(duplicate.scenarios![0]!); expect(() => parseContract(duplicate)).toThrow('unique');
  });
});

async function checkoutProject() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sentinel-app-receipt-'))); roots.push(root);
  const repo = join(root, 'repo'), store = join(root, 'store'); await cp(resolve('fixtures/checkout'), repo, { recursive: true }); await mkdir(store);
  const contract = parseContract(JSON.parse(await readFile(join(repo, 'acceptance.json'), 'utf8'))); await rm(join(repo, 'acceptance.json')); git(repo);
  const baseline = await captureSnapshot(repo, store), workspace = join(store, 'workspaces', 'controlled-app'); await materializeSnapshot(store, baseline, workspace); git(workspace);
  const sourcePath = join(workspace, 'src/quote.js'); await writeFile(sourcePath, (await readFile(sourcePath, 'utf8')).replace('Math.floor(', 'Math.round('));
  return { root, repo, store, workspace, contract, baseline, candidate: await captureSnapshot(workspace, store) };
}
it('keeps a successful real HTTP repair UNVERIFIED when a material approved aspect has no examples', async () => {
  const p = await checkoutProject(); p.contract.scenarios = p.contract.scenarios!.filter(scenario => scenario.type === 'http');
  p.contract.coverage = { confirmed: true, aspects: [{ id: 'api', description: 'Approved API responses', requirementIds: p.contract.scenarios.map(scenario => scenario.id) }, { id: 'tax-exempt', description: 'Tax-exempt checkout behaviour is unspecified', requirementIds: [] }] };
  const contractHash = await putObject(p.store, JSON.stringify(p.contract)); const receipt = await verify({ ...p, contractHash, timeoutMs: 30_000 });
  expect(receipt.checks.filter(check => check.requirementId).every(check => check.status === 'VERIFIED'), JSON.stringify(receipt.checks)).toBe(true);
  expect(receipt.status).toBe('UNVERIFIED'); expect(receipt.coverage).toMatchObject({ approvedAspects: 2, specifiedAspects: 1, verifiedAspects: 1 });
  expect(receipt.checks.find(check => check.id === 'candidate-tests')?.detail).toContain('3/3');
});

it.skipIf(process.env.SENTINEL_TEST_BROWSER !== '1')('verifies the real React/HTTP application and preserves PNG evidence through portable import', async () => {
  const p = await checkoutProject(), contractHash = await putObject(p.store, JSON.stringify(p.contract));
  const receipt = await verify({ ...p, contractHash, timeoutMs: 30_000 });
  expect(receipt.status, JSON.stringify(receipt.checks)).toBe('VERIFIED'); expect(receipt.schemaVersion).toBe(2); expect(receipt.checks.filter(check => check.requirementId)).toHaveLength(4);
  expect(receipt.checks.find(check => check.id === 'candidate-tests')?.detail).toContain('3/3');
  const images = receipt.artifacts!.filter(artifact => artifact.mediaType === 'image/png'); expect(images).toHaveLength(2);
  const receiptHash = await putObject(p.store, JSON.stringify(receipt)), now = new Date().toISOString();
  const checkpoint: Checkpoint = { schemaVersion: 1, id: 'controlled-app', objective: p.contract.objective, createdAt: now, updatedAt: now, repo: p.repo, workspace: p.workspace, baselineHash: p.baseline.hash, candidateHash: p.candidate.hash, contractHash, state: 'verified', receipts: [receiptHash], agents: [], nextActions: receipt.nextActions, openQuestions: receipt.limitations, unverifiedStatements: [], localConsent: true };
  await saveCheckpoint(p.store, checkpoint); const bundlePath = join(p.root, 'application.sentinel.json'); await exportSession(p.store, checkpoint.id, bundlePath);
  const importedStore = join(p.root, 'imported'), imported = await importSession(importedStore, bundlePath); expect(imported.state).toBe('interrupted'); expect(imported.localConsent).toBe(false); await loadCheckpoint(importedStore, imported.id);
  for (const image of images) expect(await getObject(importedStore, image.hash)).toEqual(await getObject(p.store, image.hash));
  const bundle = JSON.parse(await readFile(bundlePath, 'utf8')); delete bundle.objects[images[0]!.hash]; const corrupted = join(p.root, 'missing-image.sentinel.json'); await writeFile(corrupted, JSON.stringify(bundle));
  await expect(importSession(join(p.root, 'bad-import'), corrupted)).rejects.toThrow('missing required object');
  // A self-consistent hash chain is not authenticity. Even so, import must reject
  // malformed media metadata before it publishes a usable session pointer.
  const malformed = JSON.parse(await readFile(bundlePath, 'utf8')), fakePng = Buffer.from('not a PNG image'), fakeHash = digest(fakePng);
  const alteredReceipt = structuredClone(receipt); alteredReceipt.artifacts![alteredReceipt.artifacts!.findIndex(artifact => artifact.hash === images[0]!.hash)] = { ...images[0]!, hash: fakeHash, bytes: fakePng.length };
  const alteredReceiptBytes = Buffer.from(JSON.stringify(alteredReceipt)), alteredReceiptHash = digest(alteredReceiptBytes);
  delete malformed.objects[images[0]!.hash]; delete malformed.objects[receiptHash]; delete malformed.objects[malformed.checkpointHash];
  malformed.objects[fakeHash] = fakePng.toString('base64'); malformed.objects[alteredReceiptHash] = alteredReceiptBytes.toString('base64'); malformed.checkpoint.receipts = [alteredReceiptHash];
  const alteredCheckpointBytes = Buffer.from(JSON.stringify(malformed.checkpoint)); malformed.checkpointHash = digest(alteredCheckpointBytes); malformed.objects[malformed.checkpointHash] = alteredCheckpointBytes.toString('base64');
  const malformedFile = join(p.root, 'malformed-png.sentinel.json'); await writeFile(malformedFile, JSON.stringify(malformed));
  await expect(importSession(join(p.root, 'malformed-import'), malformedFile)).rejects.toThrow(/PNG|artifact/i);
});
