import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, cp, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { startSession, continueSession, loadCheckpoint, saveCheckpoint, continuationContext } from '../src/session.js';
import { captureSnapshot, getObject, putObject } from '../src/store.js';
import { runAgent } from '../src/agents.js';
import { runCommand } from '../src/process.js';
import type { Receipt } from '../src/types.js';

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function project() {
  const directory = await mkdtemp(join(tmpdir(), 'sentinel-session-test-'));
  temporary.push(directory);
  const repo = join(directory, 'repo');
  const store = join(directory, 'store');
  await cp(resolve('fixtures/demo'), repo, { recursive: true });
  const contractPath = join(directory, 'approved.json');
  await cp(join(repo, 'contract.json'), contractPath);
  // Contracts should remain external to the managed source from the outset.
  await rm(join(repo, 'contract.json'));
  execFileSync('git', ['init', '-b', 'main'], { cwd: repo, stdio: 'pipe' });
  execFileSync('git', ['add', '.'], { cwd: repo, stdio: 'pipe' });
  execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '-m', 'baseline'], { cwd: repo, stdio: 'pipe' });
  const objective = (JSON.parse(await readFile(contractPath, 'utf8')) as { objective: string }).objective;
  return { repo, store, contractPath, objective };
}

describe('durable sessions and handoffs', () => {
  it('requires explicit local-execution consent and keeps approved contracts external', async () => {
    const p = await project();
    await expect(startSession({ ...p, agent: 'fixture-interrupt', localConsent: false })).rejects.toThrow('--allow-local');
    await cp(p.contractPath, join(p.repo, 'contract.json'));
    await expect(startSession({ ...p, contractPath: join(p.repo, 'contract.json'), agent: 'fixture-interrupt', localConsent: true })).rejects.toThrow('outside');
  });

  it('preserves a partial implementation and resumes through a different deterministic adapter', async () => {
    const p = await project();
    const original = await readFile(join(p.repo, 'src/access.ts'), 'utf8');
    const stopped = await startSession({ ...p, agent: 'fixture-interrupt', localConsent: true });
    expect(stopped.state).toBe('interrupted');
    expect(stopped.receipts).toEqual([]);
    expect(stopped.agents[0]?.outcome).toBe('interrupted');
    expect(await readFile(join(p.repo, 'src/access.ts'), 'utf8')).toBe(original);
    expect(await loadCheckpoint(p.store)).toEqual(stopped);
    const finished = await continueSession({ store: p.store, agent: 'fixture-fix' });
    expect(finished.state, finished.receipts[0] ? (await getObject(p.store, finished.receipts[0])).toString() : JSON.stringify(finished)).toBe('verified');
    expect(finished.agents.map(a => a.agent)).toEqual(['fixture-interrupt', 'fixture-fix']);
    expect(finished.baselineHash).toBe(stopped.baselineHash);
    expect(finished.contractHash).toBe(stopped.contractHash);
    expect(finished.candidateHash).not.toBe(stopped.candidateHash);
    const receipt = JSON.parse((await getObject(p.store, finished.receipts[0]!)).toString()) as Receipt;
    expect(receipt.candidateHash).toBe(finished.candidateHash);
    expect(receipt.status).toBe('VERIFIED');
    expect(await continuationContext(p.store, finished)).toContain('UNVERIFIED');
    expect(await readFile(join(p.repo, 'src/access.ts'), 'utf8')).toBe(original);
  });

  it('marks a green receipt historical if the workspace changes during verification', async () => {
    const p = await project();
    let changed = false;
    const checkpoint = await startSession({ ...p, agent: 'fixture-fix', localConsent: true, onProgress(message) {
      if (!changed && message.includes('Running candidate ordinary tests')) {
        const latest = JSON.parse(readFileSync(join(p.store, 'latest.json'), 'utf8'));
        const envelope = JSON.parse(readFileSync(join(p.store, 'sessions', latest.id, 'checkpoint.json'), 'utf8'));
        writeFileSync(join(envelope.checkpoint.workspace, 'src/access.ts'), 'export function isAdult(){return true}\nexport function greeting(name){return `Hello, ${name}!`}\n');
        changed = true;
      }
    } });
    expect(changed).toBe(true);
    expect(checkpoint.state).toBe('needs-work');
    const receipt = JSON.parse((await getObject(p.store, checkpoint.receipts.at(-1)!)).toString()) as Receipt;
    expect(receipt.status).toBe('VERIFIED');
    expect(receipt.candidateHash).not.toBe(checkpoint.candidateHash);
    expect(checkpoint.nextActions.join(' ')).toContain('Source changed during verification');
    expect(await continuationContext(p.store, checkpoint)).toContain('Historical evidence only');
  });

  it('rejects source drift until explicitly adopted', async () => {
    const p = await project();
    const checkpoint = await startSession({ ...p, agent: 'fixture-interrupt', localConsent: true });
    await writeFile(join(checkpoint.workspace, 'notes.txt'), 'unexpected edit');
    await expect(continueSession({ store: p.store, agent: 'fixture-fix' })).rejects.toThrow('changed since');
    const adopted = await continueSession({ store: p.store, agent: 'fixture-interrupt', adoptChanges: true });
    expect(adopted.openQuestions.some(q => q.includes('adopted edits'))).toBe(true);
    expect(await readFile(join(adopted.workspace, 'notes.txt'), 'utf8')).toBe('unexpected edit');
  });

  it('recovers a killed running state without trusting unverified edits', async () => {
    const p = await project();
    const checkpoint = await startSession({ ...p, agent: 'fixture-interrupt', localConsent: true });
    checkpoint.state = 'running';
    await saveCheckpoint(p.store, checkpoint);
    await writeFile(join(checkpoint.workspace, 'partial.txt'), 'work before process death');
    const recovered = await continueSession({ store: p.store, agent: 'fixture-interrupt' });
    expect(recovered.openQuestions.some(q => q.includes('stopped process'))).toBe(true);
    expect(recovered.receipts).toEqual([]);
  });

  it('rejects missing and corrupted checkpoints without reconstructing trusted state', async () => {
    const p = await project();
    const checkpoint = await startSession({ ...p, agent: 'fixture-interrupt', localConsent: true });
    const file = join(p.store, 'sessions', checkpoint.id, 'checkpoint.json');
    const envelope = JSON.parse(await readFile(file, 'utf8'));
    envelope.checkpoint.objective = 'silently altered objective';
    await writeFile(file, JSON.stringify(envelope));
    await expect(loadCheckpoint(p.store)).rejects.toThrow('integrity failure');
    await rm(file);
    await expect(loadCheckpoint(p.store)).rejects.toThrow('missing or unreadable');
  });

  it('detects protected contract object modification', async () => {
    const p = await project();
    const checkpoint = await startSession({ ...p, agent: 'fixture-interrupt', localConsent: true });
    const contractObject = join(p.store, 'objects', checkpoint.contractHash!);
    await chmod(contractObject, 0o600);
    await writeFile(contractObject, '{}');
    await expect(loadCheckpoint(p.store)).rejects.toThrow('integrity failure');
  });

  it('blocks concurrent writers and validates checkpoint workspace ownership', async () => {
    const p = await project();
    const checkpoint = await startSession({ ...p, agent: 'fixture-interrupt', localConsent: true });
    const lock = join(p.store, 'sessions', checkpoint.id, 'writer.lock');
    await writeFile(lock, JSON.stringify({ pid: process.pid, nonce: 'another-writer' }));
    await expect(continueSession({ store: p.store, agent: 'fixture-interrupt' })).rejects.toThrow('already running');
    await rm(lock);
    checkpoint.workspace = p.repo;
    await saveCheckpoint(p.store, checkpoint);
    await expect(loadCheckpoint(p.store)).rejects.toThrow('outside its managed');
  });

  it('refuses fixture adapters for an unlabelled project', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sentinel-adapter-test-'));
    temporary.push(directory);
    await writeFile(join(directory, 'package.json'), '{}');
    await expect(runAgent('fixture-fix', { workspace: directory, prompt: '' })).rejects.toThrow('labelled controlled');
  });
});

describe('bounded continuation context', () => {
  it('carries unresolved approved intent and explicit scope decisions before the first receipt', async () => {
    const p=await project(),baseline=await captureSnapshot(p.repo,p.store);
    const original=JSON.parse(await readFile(p.contractPath,'utf8'));
    const unresolved='Which malformed ages should throw instead of returning false?';
    const decision='Only the exported age validator and greeting are in the approved scope.';
    delete original.probes;
    const proposalHash=await putObject(p.store,JSON.stringify({schemaVersion:1,objective:original.objective,proposed:original.requirements.map((requirement:unknown)=>({selected:true,requirement})),uncertainties:[unresolved],resolvedQuestions:[{question:'Does this include the UI?',reason:decision}]}));
    await writeFile(p.contractPath,JSON.stringify({...original,schemaVersion:2,unresolved:[unresolved],approval:{method:'interactive',approvedAt:new Date().toISOString(),proposalHash,baselineHash:baseline.hash,requirementIds:original.requirements.map((r:{id:string})=>r.id),resolvedQuestions:[{question:'Does this include the UI?',reason:decision}]}}));
    const checkpoint=await startSession({...p,agent:'fixture-interrupt',localConsent:true});
    expect(checkpoint.receipts).toEqual([]);expect(checkpoint.openQuestions).toContain(unresolved);
    const context=await continuationContext(p.store,checkpoint);
    expect(context).toContain(unresolved);expect(context).toContain(decision);
    expect(context.indexOf('APPROVED SCOPE AND UNRESOLVED INTENT')).toBeLessThan(context.indexOf('APPROVED REQUIREMENTS'));
    expect(context.length).toBeLessThanOrEqual(16000);
  });
  it('retains a bounded evidence package and the previous actionable guidance', async () => {
    const p = await project();
    const checkpoint = await startSession({ ...p, agent: 'fixture-interrupt', localConsent: true });
    checkpoint.objective = 'Large task '.repeat(10000);
    checkpoint.nextActions = ['Repair numeric-string validation before claiming completion.'];
    checkpoint.unverifiedStatements = ['Agent narrative '.repeat(10000)];
    const context = await continuationContext(p.store, checkpoint);
    expect(context.length).toBeLessThanOrEqual(16000);
    expect(context).toContain('Repair numeric-string validation');
    expect(context).toContain('No completed verification yet');
    expect(context).toContain('UNVERIFIED PREVIOUS AGENT STATEMENTS');
  });
});

describe('documented CLI adapter protocols using fake executables', () => {
  it('uses documented argv and stdin for both providers without claiming a live model test', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sentinel-cli-protocol-'));
    temporary.push(directory);
    const bin = join(directory, 'bin');
    await mkdir(bin);
    const stub = `#!/usr/bin/env node
const args = process.argv.slice(2);
if(args.includes('--version')) { console.log('controlled CLI protocol fixture 1'); process.exit(0); }
if(args.includes('--help')) { console.log('--sandbox --cd --json workspace-write --print --output-format stream-json --verbose --permission-mode acceptEdits --allowedTools --tools'); process.exit(0); }
let input = ''; process.stdin.on('data', chunk => input += chunk); process.stdin.on('end', () => console.log(JSON.stringify({args,input,cwd:process.cwd()})));
`;
    for (const name of ['codex', 'claude']) { await writeFile(join(bin, name), stub, { mode: 0o755 }); }
    const oldPath = process.env.PATH;
    process.env.PATH = `${bin}:${oldPath}`;
    try {
      const codex = await runAgent('codex', { workspace: directory, prompt: 'approved evidence package' });
      expect(codex.outcome).toBe('completed');
      expect(codex.command?.command).toEqual(['codex', 'exec', '--sandbox', 'workspace-write', '--cd', directory, '--json', '-']);
      expect(JSON.parse(codex.command!.stdout).input).toBe('approved evidence package');
      const claude = await runAgent('claude', { workspace: directory, prompt: 'second agent, same evidence' });
      expect(claude.outcome).toBe('completed');
      expect(claude.command?.command).toContain('--permission-mode');
      expect(claude.command?.command).not.toContain('--dangerously-skip-permissions');
      expect(JSON.parse(claude.command!.stdout).input).toBe('second agent, same evidence');
    } finally { process.env.PATH = oldPath; }
  });
});

describe('receiving-agent acknowledgement', () => {
  it('accepts only visible assistant statements, never echoed prompts or tool input', async () => {
    const { acknowledgedCheckpoint } = await import('../src/agents.js');
    const source='a'.repeat(64),contract='b'.repeat(64),ack=`SENTINEL_ACK ${source} ${contract}`;
    expect(acknowledgedCheckpoint('codex',JSON.stringify({type:'item.completed',item:{type:'agent_message',text:ack}}),source,contract)).toBe(true);
    expect(acknowledgedCheckpoint('claude',JSON.stringify({type:'assistant',message:{content:[{type:'text',text:ack}]}}),source,contract)).toBe(true);
    expect(acknowledgedCheckpoint('codex',JSON.stringify({type:'item.completed',item:{type:'command_execution',command:`echo ${ack}`}}),source,contract)).toBe(false);
    expect(acknowledgedCheckpoint('codex',JSON.stringify({input:ack}),source,contract)).toBe(false);
    expect(acknowledgedCheckpoint('claude',JSON.stringify({type:'user',message:{content:[{type:'text',text:ack}]}}),source,contract)).toBe(false);
    expect(acknowledgedCheckpoint('claude',JSON.stringify({type:'result',result:ack,is_error:true}),source,contract)).toBe(false);
    expect(acknowledgedCheckpoint('codex',JSON.stringify({type:'item.completed',item:{type:'agent_message',text:ack}}),'c'.repeat(64),contract)).toBe(false);
  });
});

describe('unexpected coordinator termination', () => {
  it('does not deliver a task prompt when durable process ownership cannot be recorded', async () => {
    const p=await project(),marker=join(p.repo,'prompt-delivered.txt');
    const result=await runCommand([process.execPath,'-e',"process.stdin.on('data',()=>require('node:fs').writeFileSync(process.argv[1],'received'))",marker],p.repo,{input:'task must remain withheld',onSpawn:()=>{throw new Error('controlled lease write failure');}});
    expect(result.stderr).toContain('Process ownership could not be recorded');
    expect(result.signal).toBe('SIGKILL');
    await expect(readFile(marker)).rejects.toThrow();
  });
  it('recovers a real SIGKILL with partial source remaining explicitly unverified', async () => {
    const p = await project();
    const bin = join(p.repo,'protocol-bin');await mkdir(bin);
    const stub=`#!/usr/bin/env node
import fs from 'node:fs';const args=process.argv.slice(2);
if(args.includes('--version')){console.log('controlled interruption protocol');process.exit(0)}
if(args.includes('--help')){console.log('--sandbox --cd --json workspace-write');process.exit(0)}
fs.writeFileSync('partial-progress.txt','implementation saved before coordinator death');
fs.writeFileSync('.protocol-agent-pid',String(process.pid));
setInterval(()=>{},1000);
`;
    await writeFile(join(bin,'codex'),stub,{mode:0o755});
    await writeFile(join(bin,'claude'),'#!/usr/bin/env node\nprocess.exit(1);\n',{mode:0o755});
    const child=spawn(process.execPath,[resolve('dist/cli.js'),'run',p.objective,'--repo',p.repo,'--contract',p.contractPath,'--store',p.store,'--agent','codex','--allow-local'],{env:{...process.env,PATH:bin+':'+process.env.PATH},stdio:['ignore','pipe','pipe']});
    let diagnostics='';child.stdout.on('data',b=>diagnostics+=b);child.stderr.on('data',b=>diagnostics+=b);
    const exited=new Promise<void>(resolve=>child.on('exit',()=>resolve()));
    let agentPid:number|undefined;
    try {
      const deadline=Date.now()+60000;let checkpoint;
      while(Date.now()<deadline){
        try{checkpoint=await loadCheckpoint(p.store);agentPid=Number(await readFile(join(checkpoint.workspace,'.protocol-agent-pid'),'utf8'));if(agentPid)break;}catch{}
        await new Promise(resolve=>setTimeout(resolve,50));
      }
      expect(agentPid !== undefined,diagnostics).toBe(true);
      child.kill('SIGKILL');await exited;
      await expect(continueSession({store:p.store,agent:'fixture-interrupt'})).rejects.toThrow('still alive');
      if(agentPid){try{process.kill(-agentPid,'SIGTERM')}catch{}}
      // Wait until the exact owned fixture is gone; never terminate a PID read
      // from an arbitrary checkpoint as part of product recovery.
      for(let attempt=0;attempt<100;attempt++){
        try{process.kill(agentPid!,0);}catch{agentPid=undefined;break;}
        await new Promise(resolve=>setTimeout(resolve,25));
      }
      const saved=await loadCheckpoint(p.store);expect(saved.state).toBe('running');expect(saved.receipts).toEqual([]);
      const resumed=await continueSession({store:p.store,agent:'fixture-interrupt'});
      expect(resumed.state).toBe('interrupted');expect(resumed.receipts).toEqual([]);
      expect(resumed.openQuestions.join(' ')).toContain('unverified');
      expect(await readFile(join(resumed.workspace,'partial-progress.txt'),'utf8')).toContain('implementation saved');
    } finally {
      child.kill('SIGKILL');
      if(agentPid){try{process.kill(-agentPid,'SIGKILL')}catch{}}
    }
  },120000);
});

describe('honest failed verification after a prior success',()=>{
 it('records a new environment failure instead of exposing the old green receipt as the latest result',async()=>{
  const p=await project();const good=await startSession({...p,agent:'fixture-fix',localConsent:true});expect(good.state).toBe('verified');
  const bin=join(p.repo,'unavailable-docker');await mkdir(bin);
  await writeFile(join(bin,'docker'),'#!/usr/bin/env node\nconsole.log("ssh://unsupported-remote");\n',{mode:0o755});
  const old=process.env.PATH;process.env.PATH=bin+':'+old;
  try{
   const failed=await continueSession({store:p.store,agent:'fixture-fix',runner:{kind:'docker',image:'sentinel-runner:0.2.0'},isolatedConsent:true});
   expect(failed.state).toBe('needs-work');expect(failed.receipts).toHaveLength(2);
   const receipt=JSON.parse((await getObject(p.store,failed.receipts.at(-1)!)).toString()) as Receipt;
   expect(receipt.status).toBe('ENVIRONMENT FAILURE');expect(receipt.runtime?.verificationCompleted).toBe('false');
   expect(receipt.checks[0]?.detail).toContain('No local fallback');
   await expect(continueSession({store:p.store,agent:'fixture-fix',runner:{kind:'local'}})).rejects.toThrow('--allow-local');
  }finally{process.env.PATH=old;}
 });
});
