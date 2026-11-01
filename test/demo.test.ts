import { it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCommand } from '../src/process.js';
import { loadCheckpoint } from '../src/session.js';
import { getObject } from '../src/store.js';
import type { Receipt } from '../src/types.js';
it('executes green-test false success, shrinks evidence, recovers interruption, and checks the correction',async()=>{
 const store=await fs.mkdtemp(path.join(os.tmpdir(),'sentinel-e2e-'));
 try{
  const r=await runCommand([process.execPath,path.resolve('dist/cli.js'),'demo','--functions','--store',store],process.cwd(),{timeoutMs:90000});
  expect(r.stderr).toBe('');expect(r.exitCode).toBe(0);
  const cp=await loadCheckpoint(store);expect(cp.state).toBe('verified');expect(cp.agents.map(a=>a.outcome)).toEqual(['completed','interrupted','completed']);expect(cp.receipts).toHaveLength(2);
  const bad=JSON.parse((await getObject(store,cp.receipts[0]!)).toString()) as Receipt;const good=JSON.parse((await getObject(store,cp.receipts[1]!)).toString()) as Receipt;
  expect(bad.checks.find(c=>c.id==='candidate-tests')?.status).toBe('VERIFIED');expect(bad.checks.find(c=>c.id==='req:reject-strings')?.status).toBe('CONTRADICTED');expect(bad.checks.find(c=>c.id==='req:reject-strings')?.counterexample?.minimal).toEqual(['18']);expect(good.status).toBe('VERIFIED');
  expect(await fs.readFile(path.join(store,'sessions',cp.id,'report.html'),'utf8')).toContain('Content-Security-Policy');
 }finally{await fs.rm(store,{recursive:true,force:true});}
});
it('refuses project execution without explicit local consent',async()=>{const r=await runCommand([process.execPath,path.resolve('dist/cli.js'),'verify'],process.cwd());expect(r.exitCode).toBe(2);expect(r.stderr).toContain('--allow-local');});
