import { it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runCommand } from '../src/process.js';
import { loadCheckpoint } from '../src/session.js';
import { getObject } from '../src/store.js';
import type { Receipt } from '../src/types.js';
it.skipIf(process.env.SENTINEL_TEST_BROWSER!=='1')('shipped default demo exposes a real React/API defect, resumes and emits portable screenshots and a patch',async()=>{
 const store=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'sentinel-browser-demo-')));
 try{
  const command=await runCommand([process.execPath,path.resolve('dist/cli.js'),'demo','--store',store],process.cwd(),{timeoutMs:180000});
  expect(command.exitCode,command.stdout+command.stderr).toBe(0);
  const checkpoint=await loadCheckpoint(store);expect(checkpoint.state).toBe('verified');expect(checkpoint.agents.map(a=>a.outcome)).toEqual(['completed','interrupted','completed']);
  const before=JSON.parse((await getObject(store,checkpoint.receipts[0]!)).toString()) as Receipt;const after=JSON.parse((await getObject(store,checkpoint.receipts[1]!)).toString()) as Receipt;
  expect(before.checks.find(c=>c.id==='candidate-tests')?.status).toBe('VERIFIED');expect(before.checks.find(c=>c.requirementId==='rounded-browser')?.status).toBe('CONTRADICTED');expect(after.status).toBe('VERIFIED');
  expect(after.artifacts?.filter(a=>a.mediaType==='image/png')).toHaveLength(2);
  const html=await fs.readFile(path.join(store,'sessions',checkpoint.id,'report.html'),'utf8');expect(html).toContain('data:image/png;base64,');expect(html).toContain('Before &amp; after');expect(html).toContain('$64.92');
  expect(command.stdout).toContain('Reviewable patch');
 }finally{await fs.rm(store,{recursive:true,force:true});}
},190000);
