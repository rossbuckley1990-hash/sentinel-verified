import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { captureSnapshot, captureRevision, materializeSnapshot, putObject } from '../src/store.js';
import { verify } from '../src/verifier.js';
import type { Contract } from '../src/types.js';

const exec = promisify(execFile);
const allocated: string[] = [];
const dependencies = resolve('node_modules');
const contract: Contract = {
  schemaVersion: 1, objective: 'Reject string ages', approvedBy: 'controlled security regression', allowedPaths: ['src/access.js'],
  requirements: [{ id: 'reject-string', kind: 'must-change', description: 'String ages are invalid', module: 'src/access.js', export: 'isAdult', cases: [{ args: ['18'], expected: false }] }],
};

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'sentinel-security-'));
  allocated.push(root);
  const repo = join(root, 'repo');
  const store = join(root, 'store');
  await mkdir(join(repo, 'src'), { recursive: true });
  await mkdir(store);
  await writeFile(join(repo, 'package.json'), JSON.stringify({ name: 'sentinel-security-regression', private: true, type: 'module' }));
  await writeFile(join(repo, 'src/access.js'), 'export function isAdult(age) { return age >= 18; }\n');
  await writeFile(join(repo, 'src/access.test.js'), 'import { test, expect } from "vitest";\nimport { isAdult } from "./access.js";\ntest("ordinary ages", () => { expect(isAdult(18)).toBe(true); expect(isAdult(17)).toBe(false); });\n');
  await exec('git', ['init', '-b', 'main'], { cwd: repo });
  await exec('git', ['add', '--all'], { cwd: repo });
  await exec('git', ['-c', 'user.name=SENTINEL', '-c', 'user.email=sentinel@localhost', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'Controlled regression fixture'], { cwd: repo });
  return { root, repo, store };
}

afterEach(async () => { await Promise.all(allocated.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

describe('source and verification evidence boundaries', () => {
  it('fails on missing partial-clone objects without launching a remote helper', async () => {
    const {root,repo,store}=await fixture(),bin=join(root,'bin'),marker=join(root,'remote-helper-invoked');await mkdir(bin);
    await writeFile(join(bin,'git-remote-sentinel-probe'),'#!/bin/sh\nprintf invoked > "$SENTINEL_PROBE_MARKER"\nexit 1\n',{mode:0o755});
    const oid=(await exec('git',['rev-parse','HEAD:src/access.js'],{cwd:repo})).stdout.trim();
    await rm(join(repo,'.git','objects',oid.slice(0,2),oid.slice(2)));
    for(const [key,value] of [['remote.origin.url','sentinel-probe::controlled'],['remote.origin.promisor','true'],['remote.origin.partialclonefilter','blob:none'],['protocol.sentinel-probe.allow','always']])await exec('git',['config',key!,value!],{cwd:repo});
    const previousPath=process.env.PATH,previousMarker=process.env.SENTINEL_PROBE_MARKER;
    process.env.PATH=bin+':'+previousPath;process.env.SENTINEL_PROBE_MARKER=marker;
    try{
      await expect(exec('git',['cat-file','blob',oid],{cwd:repo,timeout:5000,env:{...process.env,GIT_NO_LAZY_FETCH:'0',GIT_ALLOW_PROTOCOL:'sentinel-probe'}})).rejects.toThrow();
      expect(await readFile(marker,'utf8')).toBe('invoked');await rm(marker);
      // Transport denial is a second barrier for Git versions without the
      // no-lazy-fetch switch; repository protocol.*.allow cannot override it.
      await expect(exec('git',['cat-file','blob',oid],{cwd:repo,timeout:5000,env:{...process.env,GIT_NO_LAZY_FETCH:'0',GIT_ALLOW_PROTOCOL:''}})).rejects.toThrow();
      await expect(readFile(marker)).rejects.toThrow();
      await expect(captureRevision(repo,'HEAD',store)).rejects.toThrow();
      await expect(readFile(marker)).rejects.toThrow();
    }finally{process.env.PATH=previousPath;if(previousMarker===undefined)delete process.env.SENTINEL_PROBE_MARKER;else process.env.SENTINEL_PROBE_MARKER=previousMarker;}
  });

  it('never executes repository clean filters while capturing modified or staged source', async () => {
    const {root,repo,store}=await fixture();const marker=join(root,'filter-invoked.txt');
    await writeFile(join(repo,'.gitattributes'),'src/access.js filter=sentinel-probe\n');
    await writeFile(join(repo,'filter.sh'),'#!/bin/sh\nprintf invoked > ../filter-invoked.txt\ncat\n',{mode:0o755});
    await exec('git',['add','.gitattributes','filter.sh'],{cwd:repo});
    await exec('git',['-c','user.name=SENTINEL','-c','user.email=sentinel@localhost','-c','commit.gpgsign=false','-c','core.hooksPath=/dev/null','commit','-m','Controlled filter fixture'],{cwd:repo});
    await exec('git',['config','filter.sentinel-probe.clean','./filter.sh'],{cwd:repo});
    expect((await captureSnapshot(repo,store)).git.dirty).toBe(false);
    await expect(readFile(marker)).rejects.toThrow();
    const original=await readFile(join(repo,'src/access.js'),'utf8');
    const changed=original.replace('>= 18','>= 19');expect(changed.length).toBe(original.length);
    await writeFile(join(repo,'src/access.js'),changed);
    // Positive control: the formerly used Git operation really executes this
    // controlled fixture even when fsmonitor and hooks are disabled.
    await exec('git',['--no-optional-locks','-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null','status','--porcelain'],{cwd:repo});
    expect(await readFile(marker,'utf8')).toBe('invoked');await rm(marker);
    expect((await captureSnapshot(repo,store)).git.dirty).toBe(true);
    await expect(readFile(marker)).rejects.toThrow();
    await exec('git',['add','src/access.js'],{cwd:repo});await rm(marker,{force:true});
    // Staged state remains dirty even when worktree bytes are restored to HEAD.
    await writeFile(join(repo,'src/access.js'),original);
    expect((await captureSnapshot(repo,store)).git.dirty).toBe(true);
    await expect(readFile(marker)).rejects.toThrow();
  });

  it('detects raw untracked, deleted and executable-mode changes without Git conversions', async () => {
    const {repo,store}=await fixture();expect((await captureSnapshot(repo,store)).git.dirty).toBe(false);
    await writeFile(join(repo,'new.txt'),'untracked');expect((await captureSnapshot(repo,store)).git.dirty).toBe(true);await rm(join(repo,'new.txt'));
    const file=join(repo,'src/access.js'),original=await readFile(file);
    await rm(file);expect((await captureSnapshot(repo,store)).git.dirty).toBe(true);await writeFile(file,original);
    if(process.platform!=='win32'){await chmod(file,0o755);expect((await captureSnapshot(repo,store)).git.dirty).toBe(true);await chmod(file,0o644);}
    expect((await captureSnapshot(repo,store)).git.dirty).toBe(false);
  });

  it('rejects a caller-mutated snapshot manifest instead of executing bytes under an old hash', async () => {
    const { root, repo, store } = await fixture();
    const baseline = await captureSnapshot(repo, store);
    const candidate = structuredClone(baseline);
    const replacement = 'export function isAdult(age) { return typeof age === "number" && age >= 18; }\n';
    candidate.files['src/access.js'] = { hash: await putObject(store, replacement), size: Buffer.byteLength(replacement), mode: 0o644 };
    await expect(materializeSnapshot(store, candidate, join(root, 'output'))).rejects.toThrow(/manifest|hash|integrity/i);
    const contractHash = await putObject(store, JSON.stringify(contract));
    await expect(verify({ store, baseline, candidate, contract, contractHash, dependencies })).rejects.toThrow(/manifest|hash|integrity/i);
  });

  it('does not verify a source file secretly repaired by an ordinary test', async () => {
    const { repo, store } = await fixture();
    const baseline = await captureSnapshot(repo, store);
    const repaired = 'export function isAdult(age) { return typeof age === "number" && Number.isInteger(age) && age >= 18; }\n';
    await writeFile(join(repo, 'src/access.test.js'), `import { test, expect } from 'vitest';\nimport { writeFileSync } from 'node:fs';\nimport { resolve } from 'node:path';\ntest('claims green while repairing the execution copy', () => { writeFileSync(resolve('src/access.js'), ${JSON.stringify(repaired)}); expect(true).toBe(true); });\n`);
    const candidate = await captureSnapshot(repo, store);
    const contractHash = await putObject(store, JSON.stringify(contract));
    const receipt = await verify({ store, baseline, candidate, contract, contractHash, dependencies });
    expect(receipt.checks.find(check => check.id === 'candidate-tests')?.status).toBe('VERIFIED');
    expect(receipt.checks.find(check => check.id === 'execution-integrity:candidate')?.status).toBe('ENVIRONMENT FAILURE');
    expect(receipt.checks.find(check => check.requirementId === 'reject-string')?.status).toBe('CONTRADICTED');
    expect(receipt.status).toBe('ENVIRONMENT FAILURE');
    // The test repaired only the expendable execution copy, not the recorded source.
    expect(await readFile(join(repo, 'src/access.js'), 'utf8')).toContain('return age >= 18');
  });

  it('preserves a literal __proto__ filename in working-tree and revision snapshots', async () => {
    const { root, repo, store } = await fixture();
    const source = 'A file name is data, not an object prototype.\n';
    await writeFile(join(repo, '__proto__'), source);
    await exec('git', ['add', '__proto__'], { cwd: repo });
    await exec('git', ['-c', 'user.name=SENTINEL', '-c', 'user.email=sentinel@localhost', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'Track prototype-like filename'], { cwd: repo });
    const working = await captureSnapshot(repo, store);
    const revision = await captureRevision(repo, 'HEAD', store);
    expect(Object.hasOwn(working.files, '__proto__')).toBe(true);
    expect(Object.hasOwn(revision.files, '__proto__')).toBe(true);
    expect(working.files['__proto__']?.hash).toBe(revision.files['__proto__']?.hash);
    await materializeSnapshot(store, revision, join(root, 'reproduced'));
    expect(await readFile(join(root, 'reproduced/__proto__'), 'utf8')).toBe(source);
  });
});


it('classifies an unloadable test suite as environment failure, not empty coverage',async()=>{
 const {repo,store}=await fixture();const baseline=await captureSnapshot(repo,store);
 await writeFile(join(repo,'src/access.test.js'), "import './missing-dependency.js';\n");
 const candidate=await captureSnapshot(repo,store);const contractHash=await putObject(store,JSON.stringify(contract));
 const receipt=await verify({store,baseline,candidate,contract,contractHash,dependencies});
 expect(receipt.checks.find(c=>c.id==='candidate-tests')?.status).toBe('ENVIRONMENT FAILURE');
 expect(receipt.status).toBe('ENVIRONMENT FAILURE');
});


it('rejects reuse of an interactive approval against a different baseline before execution',async()=>{
 const {repo,store}=await fixture();const baseline=await captureSnapshot(repo,store);
 const approved:Contract={...contract,schemaVersion:2,approval:{method:'interactive',approvedAt:new Date().toISOString(),proposalHash:await putObject(store,JSON.stringify({schemaVersion:1,objective:contract.objective,proposed:contract.requirements.map(requirement=>({selected:true,requirement})),uncertainties:[],resolvedQuestions:[]})),baselineHash:baseline.hash,requirementIds:contract.requirements.map(r=>r.id),resolvedQuestions:[]}};
 const contractHash=await putObject(store,JSON.stringify(approved));await writeFile(join(repo,'changed.txt'),'unreviewed baseline');const other=await captureSnapshot(repo,store);
 await expect(verify({store,baseline:other,candidate:other,contract:approved,contractHash,dependencies})).rejects.toThrow('Approved baseline differs');
});

it('does not turn an explicitly limited approved plan into a verified objective',async()=>{
 const {repo,store}=await fixture();const baseline=await captureSnapshot(repo,store);
 await writeFile(join(repo,'src/access.js'), 'export function isAdult(age) { return typeof age === "number" && age >= 18; }\n');
 const approved:Contract={...contract,schemaVersion:2,unresolved:['Should fractional ages be accepted?'],approval:{method:'interactive',approvedAt:new Date().toISOString(),proposalHash:await putObject(store,JSON.stringify({schemaVersion:1,objective:contract.objective,proposed:contract.requirements.map(requirement=>({selected:true,requirement})),uncertainties:['Should fractional ages be accepted?'],resolvedQuestions:[]})),baselineHash:baseline.hash,requirementIds:contract.requirements.map(r=>r.id),resolvedQuestions:[]}};
 const contractHash=await putObject(store,JSON.stringify(approved));const candidate=await captureSnapshot(repo,store);const receipt=await verify({store,baseline,candidate,contract:approved,contractHash,dependencies});
 expect(receipt.checks.find(c=>c.requirementId==='reject-string')?.status).toBe('VERIFIED');expect(receipt.checks.find(c=>c.id==='unresolved:0')?.status).toBe('UNVERIFIED');expect(receipt.status).toBe('UNVERIFIED');
});


it('rejects expected-value drift under an earlier interactive proposal identity',async()=>{
 const {repo,store}=await fixture();const baseline=await captureSnapshot(repo,store);
 const proposal={schemaVersion:1,objective:contract.objective,proposed:contract.requirements.map(requirement=>({selected:true,requirement})),uncertainties:[],resolvedQuestions:[]};
 const changed=structuredClone(contract.requirements);changed[0]!.cases[0]!.expected=true;
 const edited:Contract={...contract,schemaVersion:2,requirements:changed,unresolved:[],approval:{method:'interactive',approvedAt:new Date().toISOString(),proposalHash:await putObject(store,JSON.stringify(proposal)),baselineHash:baseline.hash,requirementIds:changed.map(r=>r.id),resolvedQuestions:[]}};
 const contractHash=await putObject(store,JSON.stringify(edited));await expect(verify({store,baseline,candidate:baseline,contract:edited,contractHash,dependencies})).rejects.toThrow('differs from the reviewed proposal');
});
