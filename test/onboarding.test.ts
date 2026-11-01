import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { discoverProject } from '../src/discovery.js';
import {
  approvePlan, consentToExecution, readPreferences, rememberAgent,
  rememberSession, repositorySession, type PromptIO,
} from '../src/onboarding.js';
import { captureSnapshot, digest, getObject } from '../src/store.js';
import { parseContract } from '../src/schema.js';
import { runCommand } from '../src/process.js';
import type { Checkpoint } from '../src/types.js';

// Scripted PromptIO is a unit-test simulation of a developer's choices. These
// tests exercise the real approval/storage functions; they are not evidence of
// a live human review, terminal interaction, or commercial coding-agent run.
type Answer = string | (() => Promise<string>);
function scripted(answers: Answer[], interactive = true) {
  const remaining = [...answers];
  const messages: string[] = [], questions: string[] = [];
  const io: PromptIO = {
    interactive,
    write: message => { messages.push(message); },
    ask: async message => {
      questions.push(message);
      const answer = remaining.shift();
      if (answer === undefined) throw new Error(`Unexpected prompt in scripted approval: ${message}`);
      return typeof answer === 'function' ? await answer() : answer;
    },
    close: () => {},
  };
  return { io, messages, questions, remaining };
}

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function project(objective = 'Repair f; f("bad") must return false') {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sentinel-onboarding-test-'));
  temporary.push(directory);
  const root = await fs.realpath(directory);
  const repo = path.join(root, 'repo'), store = path.join(root, 'store');
  await fs.mkdir(repo);
  await fs.mkdir(store, { mode: 0o700 });
  await fs.writeFile(path.join(repo, 'package.json'), JSON.stringify({ name: 'controlled-onboarding-fixture', type: 'module', devDependencies: { vitest: '5.0.5' } }));
  await fs.writeFile(path.join(repo, 'index.ts'), 'export function f(value: unknown) { return value === "good"; }\n');
  await fs.writeFile(path.join(repo, 'index.test.ts'), `import {expect,test} from 'vitest';import {f} from './index';test('good input',()=>expect(f('good')).toBe(true));\n`);
  for (const args of [
    ['init', '-b', 'main'], ['add', '.'],
    ['-c', 'commit.gpgsign=false', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '-m', 'Controlled approval fixture'],
  ]) {
    const result = await runCommand(['git', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', repo, ...args], repo);
    if (result.exitCode !== 0) throw new Error(result.stderr);
  }
  const plan = await discoverProject(repo, objective);
  const baseline = await captureSnapshot(repo, store);
  return { root, repo, store, plan, baseline };
}

async function contracts(store: string): Promise<string[]> {
  try { return await fs.readdir(path.join(store, 'contracts')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}

describe('approval onboarding with simulated developer prompts', () => {
  it('refuses automatic approval without a TTY and writes no approved contract', async () => {
    const p = await project(); const prompt = scripted([], false);
    await expect(approvePlan(p.plan, p.store, p.baseline, prompt.io)).rejects.toThrow('interactive terminal');
    expect(prompt.questions).toEqual([]); expect(await contracts(p.store)).toEqual([]);
  });

  it('rejects a plan without persisting an approved contract or mutating its proposals', async () => {
    const p = await project(); const before = structuredClone(p.plan); const prompt = scripted(['reject']);
    await expect(approvePlan(p.plan, p.store, p.baseline, prompt.io)).rejects.toThrow('rejected');
    expect(await contracts(p.store)).toEqual([]); expect(p.plan).toEqual(before);
    expect(prompt.messages.join('\n')).toContain('PROPOSED, not approved');
  });

  it('binds a schema-2 approval to the baseline and an independently inspectable proposal object', async () => {
    const p = await project(); const prompt = scripted(['approve']);
    const approved = await approvePlan(p.plan, p.store, p.baseline, prompt.io);
    const saved = parseContract(JSON.parse(await fs.readFile(approved.contractPath, 'utf8')));
    expect(saved).toEqual(approved.contract); expect(saved.schemaVersion).toBe(2);
    expect(saved.approval).toMatchObject({ method: 'interactive', baselineHash: p.baseline.hash, proposalHash: approved.proposalHash, requirementIds: saved.requirements.map(r => r.id), resolvedQuestions: [] });
    expect(saved.unresolved).toEqual([]); expect(saved.allowedPaths).toEqual(['index.ts']);
    expect(saved.discoveryLimits).toEqual(expect.arrayContaining(p.plan.limits));
    const proposalBytes = await getObject(p.store, approved.proposalHash);
    expect(digest(proposalBytes)).toBe(approved.proposalHash);
    const proposal = JSON.parse(proposalBytes.toString());
    expect(proposal.objective).toBe(p.plan.objective);
    expect(proposal.proposed.filter((item: { selected: boolean }) => item.selected).map((item: { requirement: unknown }) => item.requirement)).toEqual(saved.requirements);
    expect(Number.isNaN(Date.parse(proposal.reviewedAt))).toBe(false);
    expect(approved.contractPath.startsWith(p.repo + path.sep)).toBe(false);
    const contractHash = path.basename(approved.contractPath, '.json');
    expect(JSON.parse((await getObject(p.store, contractHash)).toString())).toEqual(saved);
    if (process.platform !== 'win32') {
      expect((await fs.stat(approved.contractPath)).mode & 0o077).toBe(0);
      expect((await fs.stat(path.join(p.store, 'objects', approved.proposalHash))).mode & 0o222).toBe(0);
    }
    expect(prompt.remaining).toEqual([]);
  });

  it('edits, excludes, restores and adds literal requirements while retaining the reviewed history', async () => {
    const p = await project(); const before = structuredClone(p.plan);
    const prompt = scripted([
      'edit', '1', '', '', 'Reject malformed input', '["broken"]', 'false',
      'remove', '2', 'restore', '2', 'remove', '2',
      'add', '1', 'preserve', 'Keep numeric input', '[5]', 'true',
      'approve',
    ]);
    const approved = await approvePlan(p.plan, p.store, p.baseline, prompt.io);
    expect(approved.contract.requirements).toHaveLength(2);
    expect(approved.contract.requirements[0]).toMatchObject({ id: p.plan.proposed[0]!.requirement.id, kind: 'must-change', description: 'Reject malformed input', cases: [{ args: ['broken'], expected: false }] });
    expect(approved.contract.requirements[1]).toMatchObject({ kind: 'must-preserve', description: 'Keep numeric input', cases: [{ args: [5], expected: true }] });
    const proposal = JSON.parse((await getObject(p.store, approved.proposalHash)).toString());
    expect(proposal.proposed[1].selected).toBe(false);
    expect(proposal.proposed[0].evidence[0].path).toBe('<developer approval interface>');
    expect(p.plan).toEqual(before); expect(prompt.remaining).toEqual([]);
  });

  it('rejects executable/non-JSON example input and leaves the original approved candidates intact', async () => {
    const p = await project();
    const prompt = scripted(['add', '1', 'change', 'Invalid dynamic example', '[process.exit()]', 'approve']);
    const approved = await approvePlan(p.plan, p.store, p.baseline, prompt.io);
    expect(approved.contract.requirements).toEqual(p.plan.proposed.filter(p => p.selected).map(p => p.requirement));
    expect(prompt.messages.join('\n')).toMatch(/SyntaxError/); expect(prompt.remaining).toEqual([]);
  });

  it('keeps unresolved intent in a deliberately limited approval and labels the task UNVERIFIED', async () => {
    const p = await project('Repair f and g; f("bad") must return false; g("unknown") must return true');
    const question = p.plan.uncertaintyDetails.find(q => q.blocksObjectiveVerification)!.message;
    const prompt = scripted(['approve', '', 'approve', 'limited']);
    const approved = await approvePlan(p.plan, p.store, p.baseline, prompt.io);
    expect(approved.contract.unresolved).toContain(question);
    expect(approved.contract.approval?.resolvedQuestions).toEqual([]);
    expect(prompt.messages.join('\n')).toContain('remain UNVERIFIED');
    expect(prompt.questions.filter(q => q.includes('Type limited'))).toHaveLength(2);
    const proposal = JSON.parse((await getObject(p.store, approved.proposalHash)).toString());
    expect(proposal.uncertainties).toContain(question); expect(prompt.remaining).toEqual([]);
  });

  it('resolves only the generic intent gap when adding an example, retaining unrelated specific objective uncertainty', async () => {
    const p = await project('Repair g; g("unknown") must return false');
    const specific = p.plan.uncertaintyDetails.find(q => q.message.startsWith('Objective:'))!.message;
    const generic = p.plan.uncertaintyDetails.find(q => q.message.startsWith('The objective does not establish'))!.message;
    const prompt = scripted(['add', '1', 'change', 'Reject malformed f input', '["bad"]', 'false', 'approve', 'limited']);
    const approved = await approvePlan(p.plan, p.store, p.baseline, prompt.io);
    expect(approved.contract.unresolved).toContain(specific);
    expect(approved.contract.unresolved).not.toContain(generic);
    expect(approved.contract.approval?.resolvedQuestions.map(q => q.question)).toEqual([generic]);
    expect(prompt.remaining).toEqual([]);
  });

  it('accepts the first explicit example for a source-only plan without retaining obsolete generic discovery gaps', async () => {
    const p = await project('Repair f');
    await fs.rm(path.join(p.repo, 'index.test.ts'));
    const plan = await discoverProject(p.repo, 'Repair f');
    const baseline = await captureSnapshot(p.repo, p.store);
    expect(plan.proposed).toEqual([]);
    expect(plan.uncertaintyDetails.filter(q => q.kind === 'intent')).toHaveLength(2);
    const prompt = scripted(['add', '1', 'change', 'Reject malformed input', '["bad"]', 'false', 'approve']);
    const approved = await approvePlan(plan, p.store, baseline, prompt.io);
    expect(approved.contract.unresolved).toEqual([]);
    expect(approved.contract.requirements).toHaveLength(1);
    expect(approved.contract.approval?.resolvedQuestions).toHaveLength(2);
    expect(prompt.questions.some(q => q.includes('Type limited'))).toBe(false);
    expect(prompt.remaining).toEqual([]);
  });

  it('records an explicit decision before resolving a specific question, retaining an empty decision as unresolved', async () => {
    const p = await project('Repair f and g; f("bad") must return false; g("unknown") must return true');
    const question = p.plan.uncertaintyDetails.find(q => q.blocksObjectiveVerification)!.message;
    const decision = 'Scope is limited to exported f; g is not part of this approved task.';
    const prompt = scripted(['resolve', '1', '', 'resolve', '1', decision, 'approve']);
    const approved = await approvePlan(p.plan, p.store, p.baseline, prompt.io);
    expect(approved.contract.unresolved).toEqual([]);
    expect(approved.contract.approval?.resolvedQuestions).toEqual([{ question, reason: decision }]);
    expect(prompt.messages.join('\n')).toContain('question remains unresolved');
    expect(prompt.remaining).toEqual([]);
  });

  it('refuses evidence that changed between discovery and baseline capture before requesting approval', async () => {
    const p = await project();
    await fs.writeFile(path.join(p.repo, 'index.ts'), 'export function f() { return true; }\n');
    const changedBaseline = await captureSnapshot(p.repo, p.store); const prompt = scripted(['approve']);
    await expect(approvePlan(p.plan, p.store, changedBaseline, prompt.io)).rejects.toThrow('evidence changed');
    expect(prompt.questions).toEqual([]); expect(await contracts(p.store)).toEqual([]);
  });

  it('refuses a repository that drifts while its plan is being reviewed', async () => {
    const p = await project();
    const prompt = scripted([async () => { await fs.writeFile(path.join(p.repo, 'index.ts'), 'export function f() { return false; }\n'); return 'approve'; }]);
    await expect(approvePlan(p.plan, p.store, p.baseline, prompt.io)).rejects.toThrow('changed while reviewing');
    expect(await contracts(p.store)).toEqual([]);
  });
});

function checkpoint(repo: string, store: string, id: string): Checkpoint {
  return { schemaVersion: 1, id, objective: 'Controlled persistence unit fixture', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), repo, workspace: path.join(store, 'workspaces', id), baselineHash: digest('baseline'), candidateHash: digest('candidate'), contractHash: null, state: 'interrupted', receipts: [], agents: [], nextActions: [], openQuestions: [], unverifiedStatements: [], localConsent: false };
}

describe('onboarding preferences and repository selection', () => {
  it('remembers a supported agent preference without recording fixture adapters as defaults', async () => {
    const p = await project();
    expect(await readPreferences(p.store)).toEqual({ schemaVersion: 1 });
    await rememberAgent(p.store, 'codex'); expect((await readPreferences(p.store)).preferredAgent).toBe('codex');
    await rememberAgent(p.store, 'fixture-fix'); expect((await readPreferences(p.store)).preferredAgent).toBe('codex');
    await rememberAgent(p.store, 'claude'); expect((await readPreferences(p.store)).preferredAgent).toBe('claude');
    await fs.writeFile(path.join(p.store, 'config.json'), JSON.stringify({ schemaVersion: 99, preferredAgent: 'codex' }));
    await expect(readPreferences(p.store)).rejects.toThrow('preferences');
  });

  it('keeps independent latest sessions for canonical repositories and never supplies a global fallback', async () => {
    const p = await project(); const other = path.join(p.root, 'other'); const unknown = path.join(p.root, 'unknown');
    await fs.mkdir(other); await fs.mkdir(unknown);
    const first = 's-onboarding1-11111111', second = 's-onboarding2-22222222';
    await rememberSession(p.store, checkpoint(p.repo, p.store, first));
    await rememberSession(p.store, checkpoint(other, p.store, second));
    await fs.writeFile(path.join(p.store, 'latest.json'), JSON.stringify({ schemaVersion: 1, id: second }));
    expect(await repositorySession(p.store, p.repo)).toBe(first);
    expect(await repositorySession(p.store, other)).toBe(second);
    expect(await repositorySession(p.store, unknown)).toBeUndefined();
    if (process.platform !== 'win32') {
      const alias = path.join(p.root, 'repo-link'); await fs.symlink(p.repo, alias, 'dir');
      expect(await repositorySession(p.store, alias)).toBe(first);
    }
  });

  it.each([{ schemaVersion: 2, id: 's-valid-11111111' }, { schemaVersion: 1, id: '' }, { schemaVersion: 1, id: '../../elsewhere' }])('rejects a corrupt repository pointer instead of allowing an unrelated session fallback: %j', async pointer => {
    const p = await project();
    const directory = path.join(p.store, 'repositories', digest(p.repo)); await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, 'latest.json'), JSON.stringify(pointer));
    await expect(repositorySession(p.store, p.repo)).rejects.toThrow();
  });
});

describe('explicit execution consent', () => {
  it('refuses headless local execution without the consent flag and never asks an unavailable terminal', async () => {
    const prompt = scripted([], false);
    await expect(consentToExecution(prompt.io, { kind: 'local' }, false, false)).rejects.toThrow('not authorised');
    expect(prompt.questions).toEqual([]); expect(prompt.messages.join('\n')).toContain('not a sandbox');
  });

  it('honours an explicit local denial', async () => {
    const prompt = scripted(['no']);
    await expect(consentToExecution(prompt.io, { kind: 'local' }, false, false)).rejects.toThrow('not authorised');
    expect(prompt.remaining).toEqual([]);
  });

  it('accepts explicit local consent in automation or a typed allow decision', async () => {
    const headless = scripted([], false);
    await expect(consentToExecution(headless.io, { kind: 'local' }, true, false)).resolves.toBeUndefined();
    expect(headless.questions).toEqual([]);
    const interactive = scripted(['allow']);
    await expect(consentToExecution(interactive.io, { kind: 'local' }, false, false)).resolves.toBeUndefined();
    expect(interactive.remaining).toEqual([]);
  });
});
