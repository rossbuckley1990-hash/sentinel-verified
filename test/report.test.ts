import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderReport, writeReport, writePendingReport } from '../src/report.js';
import { reportOpenCommand } from '../src/report-open.js';
import type { Receipt, Checkpoint } from '../src/types.js';

const receipt: Receipt = {
  schemaVersion: 1, id: 'example', createdAt: '2026-01-01T00:00:00Z', objective: 'Reject malformed inputs',
  baselineHash: 'a'.repeat(64), candidateHash: 'b'.repeat(64), contractHash: 'c'.repeat(64),
  git: { root: '/example', head: 'd'.repeat(40), branch: 'main', dirty: true },
  runner: 'local-advisory', checks: [{ id: 'check', label: 'Reject strings', status: 'CONTRADICTED', detail: 'An approved example failed.', args: ['0018'], expected: false, observed: true,
    counterexample: { original: ['0018'], minimal: ['18'], attempts: 5, guarantee: 'Locally minimal under deletions' },
    command: { command: ['node', 'check.js'], cwd: '/example', exitCode: 0, signal: null, stdout: 'observed true', stderr: '', durationMs: 10, timedOut: false, truncated: false } }],
  changes: [{ path: 'src/access.ts', kind: 'modified', classification: 'VERIFIED', reason: 'Path approved; behaviour checked separately.' }],
  status: 'CONTRADICTED', durationMs: 200, limitations: ['Sampled evidence only.'], nextActions: ['Repair the failing example.'],
};

const checkpoint: Checkpoint = { schemaVersion: 1, id: 's-example', objective: receipt.objective, createdAt: receipt.createdAt, updatedAt: receipt.createdAt, repo: '/example', workspace: '/store/workspaces/s-example', baselineHash: receipt.baselineHash, candidateHash: receipt.candidateHash, contractHash: receipt.contractHash, state: 'needs-work', receipts: ['e'.repeat(64)], agents: [], nextActions: ['Repair the failing example.'], openQuestions: [], unverifiedStatements: ['All tests pass.'], localConsent: true };

describe('static evidence report', () => {
  it('keeps expected and observed behaviour, counterexample and source identity inspectable', () => {
    const html = renderReport(receipt, checkpoint);
    expect(html).toContain('Expected');
    expect(html).toContain('Observed');
    expect(html).toContain('Reduced counterexample');
    expect(html).toContain('Locally minimal under deletions');
    expect(html).toContain(receipt.candidateHash);
    expect(html).toContain('Machine-readable receipt');
    expect(html).toContain('Machine-readable checkpoint');
    expect(html).toContain('All tests pass.');
    expect(html).toContain('Unverified agent statements');
  });

  it('escapes hostile task, source, output and continuation text without active resources', () => {
    const attack = '</title><script>alert(1)</script><img src=x onerror="alert(2)">';
    const hostile = structuredClone(receipt);
    hostile.objective = attack;
    hostile.changes[0]!.path = attack;
    hostile.checks[0]!.command!.stdout = attack;
    const cp = structuredClone(checkpoint);
    cp.nextActions = [attack];
    const html = renderReport(hostile, cp);
    expect(html).not.toContain(attack);
    expect(html).not.toMatch(/<script\b|<img\b|<iframe\b|<[^>]*\sonerror\s*=/i);
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain("default-src 'none'");
    expect(html).toContain("base-uri 'none'; form-action 'none'");
    expect(html).not.toMatch(/<link\b|<script\b|@import|url\(/i);
  });

  it('authorises only the exact embedded stylesheet through its CSP hash', () => {
    const html = renderReport(receipt);
    const style = html.match(/<style>([\s\S]*?)<\/style>/)?.[1];
    expect(style).toBeTruthy();
    const hash = createHash('sha256').update(style!).digest('base64');
    expect(html).toContain(`style-src 'sha256-${hash}'`);
    expect(html).not.toContain("'unsafe-inline'");
    expect(html).toContain('No continuation checkpoint accompanies this receipt.');
  });

  it('marks results as historical when the checkpoint now identifies different source', () => {
    const previous = { ...receipt, status: 'VERIFIED' as const };
    const current = { ...checkpoint, candidateHash: 'f'.repeat(64), state: 'interrupted' as const };
    const html = renderReport(previous, current);
    expect(html).toContain('Historical receipt: these checks apply to candidate');
    expect(html).toContain('Its current implementation is unverified until checked again.');
    expect(html).toContain('<span class="badge unknown">UNVERIFIED</span>');
  });

  it('writes a complete standalone document without leftover temporary files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sentinel-report-'));
    try {
      const output = join(directory, 'evidence.html');
      await writeReport(output, receipt, checkpoint);
      expect(await readFile(output, 'utf8')).toBe(renderReport(receipt, checkpoint));
      expect(await readdir(directory)).toEqual(['evidence.html']);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});


describe('v0.2 report continuity', () => {
  it('never promotes an earlier green receipt over an incomplete current attempt', () => {
    const html=renderReport({...receipt,status:'VERIFIED'}, {...checkpoint,state:'interrupted'});
    expect(html).toContain('<span class="badge unknown">UNVERIFIED</span>');
    expect(html).toContain('incomplete');
  });
  it('shows the complete approved plan, unknown scope and replay command', () => {
    const html=renderReport({...receipt,contract:{schemaVersion:1,objective:receipt.objective,approvedBy:'Developer',requirements:[{id:'retain',kind:'must-preserve',description:'Retain exact greeting',module:'greet.js',export:'greet',cases:[{args:['Ada'],expected:'Hello Ada'}]}]}});
    expect(html).toContain('Retain exact greeting');expect(html).toContain('Hello Ada');
    expect(html).toContain('Reproduce this finding');expect(html).toContain('sentinel replay');
  });
  it('creates a pending page without inventing a replayable evidence receipt',async()=>{
    const directory=await mkdtemp(join(tmpdir(),'sentinel-pending-'));
    try{const file=join(directory,'report.html');await writePendingReport(file,{...checkpoint,receipts:[],state:'interrupted'});const html=await readFile(file,'utf8');expect(html).toContain('not an executed verification receipt');expect(html).not.toContain('sentinel replay');}finally{await rm(directory,{recursive:true,force:true});}
  });
  it('opens paths as one argument without shell interpolation',()=>{
    const file='/tmp/report $(touch bad).html';expect(reportOpenCommand(file,'darwin')).toEqual(['open',file]);expect(reportOpenCommand(file,'linux')).toEqual(['xdg-open',file]);expect(()=>reportOpenCommand(file,'win32')).toThrow('supported');
  });
});
