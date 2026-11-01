import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { applicationConfigSchema, applicationScenarioSchema, type ApplicationScenario } from '../src/application-schema.js';
import { verifyApplication } from '../src/application.js';
import { getObject } from '../src/store.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const api: ApplicationScenario = { id: 'quote', kind: 'must-change', description: 'Reject string quantity without changing the integer quote', type: 'http', method: 'POST', path: '/quote', body: { quantity: '3' }, expected: { status: 400, bodyType: 'json', body: { error: 'invalid quantity' } } };
const page: ApplicationScenario = { id: 'checkout', kind: 'must-change', description: 'Checkout displays the independently approved total after updating quantity', type: 'browser', path: '/', steps: [{ action: 'fill', selector: '#quantity', value: '3' }, { action: 'click', selector: '#update' }], assertions: [{ selector: '#total', property: 'text', expected: '$64.92' }] };
function server(correct: boolean) {
  return `import {createServer} from 'node:http';import {writeFileSync} from 'node:fs';writeFileSync('server.pid',String(process.pid));
createServer(async(req,res)=>{if(req.url==='/health'){res.end('ready');return;}if(req.url==='/quote'){let text='';for await(const chunk of req)text+=chunk;const q=JSON.parse(text||'{}').quantity;if(${correct}&&typeof q!=='number'){res.writeHead(400,{'content-type':'application/json'});res.end(JSON.stringify({error:'invalid quantity'}));return;}res.setHeader('content-type','application/json');res.end(JSON.stringify({total:6492}));return;}res.setHeader('content-type','text/html');res.end(${JSON.stringify(`<html><body><label for="quantity">Quantity</label><input id="quantity" value="1"><button id="update">Update</button><output id="total">$21.64</output><script>document.querySelector('#update').onclick=()=>setTimeout(()=>document.querySelector('#total').textContent='${correct ? '$64.92' : '$64.00'}',80);fetch('https://example.com/do-not-contact').catch(()=>{});</script></body></html>`)});}).listen(Number(process.env.PORT),'127.0.0.1');`;
}
async function setup(before = server(false), after = server(true)) {
  const root = await mkdtemp(join(tmpdir(), 'sentinel-app-test-')); roots.push(root);
  const baselineRoot = join(root, 'before'), candidateRoot = join(root, 'after'), store = join(root, 'store');
  for (const directory of [baselineRoot, candidateRoot, store]) await mkdir(directory);
  await writeFile(join(baselineRoot, 'server.mjs'), before); await writeFile(join(candidateRoot, 'server.mjs'), after);
  return { store, baselineRoot, candidateRoot, application: { command: ['node', 'server.mjs'], readyPath: '/health', startupTimeoutMs: 4000 }, timeoutMs: 10_000 };
}
describe('bounded application acceptance schema', () => {
  it('rejects external URL authority, traversal-through-origin and executable browser actions', () => {
    for (const path of ['https://example.com/', '//example.com/', '/\\example.com', '/hello\nworld']) expect(applicationScenarioSchema.safeParse({ ...api, path }).success).toBe(false);
    expect(applicationScenarioSchema.safeParse({ ...page, steps: [{ action: 'evaluate', script: 'process.exit(0)' }] }).success).toBe(false);
    expect(applicationScenarioSchema.safeParse({ ...page, steps: [{ action: 'press', selector: 'input', key: 'Enter' }] }).success).toBe(true);
    expect(applicationConfigSchema.safeParse({ command: ['node\nunsafe'] }).success).toBe(false);
  });
});
describe('real HTTP execution', () => {
  it('compares real responses twice and stops both managed server processes', async () => {
    const options = await setup(), result = await verifyApplication({ ...options, scenarios: [api] });
    const check = result.checks.find(check => check.requirementId === 'quote');
    expect(check?.status, JSON.stringify(result.checks)).toBe('VERIFIED');
    expect(check?.baseline).toEqual({ status: 200, body: { total: 6492 } });
    expect(check?.observed).toEqual({ status: 400, body: { error: 'invalid quantity' } });
    for (const root of [options.baselineRoot, options.candidateRoot]) { const pid = Number(await readFile(join(root, 'server.pid'), 'utf8')); expect(() => process.kill(pid, 0)).toThrow(); }
    expect(result.artifacts).toHaveLength(2);
    for (const artifact of result.artifacts) expect(JSON.parse((await getObject(options.store, artifact.hash)).toString()).observations).toHaveLength(2);
  });
  it('contradicts an unchanged implementation and flags an inconsistent preservation contract', async () => {
    const options = await setup(server(false), server(false));
    expect((await verifyApplication({ ...options, scenarios: [api] })).checks.find(check => check.requirementId === 'quote')?.status).toBe('CONTRADICTED');
    await writeFile(join(options.candidateRoot, 'server.mjs'), server(true));
    expect((await verifyApplication({ ...options, scenarios: [{ ...api, kind: 'must-preserve' }] })).checks.find(check => check.requirementId === 'quote')?.status).toBe('REVIEW REQUIRED');
  });
  it('records startup and request timeouts as environment failures, never previous success', async () => {
    const options = await setup('process.exit(4)', 'setInterval(()=>{},1000)'); options.application.startupTimeoutMs = 200;
    const result = await verifyApplication({ ...options, scenarios: [api] });
    expect(result.checks.filter(check => check.status === 'ENVIRONMENT FAILURE').length).toBeGreaterThanOrEqual(3);
    await writeFile(join(options.baselineRoot, 'server.mjs'), "import{createServer}from'node:http';createServer((q,s)=>{if(q.url==='/health')s.end('ok');}).listen(Number(process.env.PORT),'127.0.0.1');");
    await writeFile(join(options.candidateRoot, 'server.mjs'), await readFile(join(options.baselineRoot, 'server.mjs')));
    const timeout = await verifyApplication({ ...options, timeoutMs: 100, scenarios: [api] });
    expect(timeout.checks.find(check => check.requirementId === 'quote')?.status).toBe('ENVIRONMENT FAILURE');
  });
  it('does not trust a descendant listener when its foreground server command exits with inherited pipes still open', async () => {
    const source = "import{spawn}from'node:child_process';spawn(process.execPath,['-e',\"require('node:http').createServer((q,s)=>s.end('approved')).listen(Number(process.env.PORT),'127.0.0.1')\"],{stdio:'inherit'});process.exit(7);";
    const options = await setup(source, source);
    const scenario: ApplicationScenario = { ...api, method: 'GET', body: undefined, expected: { status: 200, bodyType: 'text', body: 'approved' } };
    const result = await verifyApplication({ ...options, scenarios: [scenario] });
    expect(result.checks.find(check => check.requirementId === 'quote')?.status).toBe('ENVIRONMENT FAILURE');
    expect(result.checks.filter(check => check.id.startsWith('application:'))).toHaveLength(2);
    expect(result.checks.filter(check => check.id.startsWith('application:')).every(check => check.command?.exitCode === 7)).toBe(true);
    expect(result.checks.some(check => check.id.startsWith('application-server:') && check.status === 'VERIFIED')).toBe(false);
  });
  it('does not follow a redirect to an external service', async () => {
    const source = "import{createServer}from'node:http';createServer((q,s)=>{if(q.url==='/health'){s.end('ok');return;}s.writeHead(302,{location:'https://example.com'});s.end('redirect');}).listen(Number(process.env.PORT),'127.0.0.1');";
    const options = await setup(source, source);
    const scenario: ApplicationScenario = { ...api, method: 'GET', body: undefined, expected: { status: 302, bodyType: 'text', body: 'redirect' } };
    const result = await verifyApplication({ ...options, scenarios: [scenario] });
    expect(result.checks.find(check => check.requirementId === 'quote')?.status).toBe('VERIFIED');
  });
  it('cannot accept malformed JSON via a sentinel-shaped body, and refuses unstable responses', async () => {
    const source = "import{createServer}from'node:http';let n=0;createServer((q,s)=>{if(q.url==='/health'){s.end('ok');return;}s.end(q.url==='/changing'?JSON.stringify(++n):'not-json');}).listen(Number(process.env.PORT),'127.0.0.1');";
    const options = await setup(source, source);
    const malformed: ApplicationScenario = { ...api, method: 'GET', body: undefined, expected: { status: 200, bodyType: 'json', body: { invalidJson: 'not-json' } } };
    const changing: ApplicationScenario = { ...malformed, id: 'changing', path: '/changing', expected: { status: 200, bodyType: 'json', body: 1 } };
    const result = await verifyApplication({ ...options, scenarios: [malformed, changing] });
    expect(result.checks.find(check => check.requirementId === 'quote')?.status).toBe('CONTRADICTED');
    expect(result.checks.find(check => check.requirementId === 'changing')?.status).toBe('UNVERIFIED');
  });
  it('keeps a missing explicitly selected browser as an environment failure without fallback', async () => {
    const old = process.env.SENTINEL_BROWSER_EXECUTABLE; process.env.SENTINEL_BROWSER_EXECUTABLE = '/definitely/missing/sentinel-browser';
    try { const result = await verifyApplication({ ...await setup(), scenarios: [page] }); expect(result.checks.find(check => check.requirementId === 'checkout')?.status).toBe('ENVIRONMENT FAILURE'); expect(result.artifacts.some(artifact => artifact.mediaType === 'image/png')).toBe(false); }
    finally { if (old === undefined) delete process.env.SENTINEL_BROWSER_EXECUTABLE; else process.env.SENTINEL_BROWSER_EXECUTABLE = old; }
  });
});
it.skipIf(process.env.SENTINEL_TEST_BROWSER !== '1')('captures actual before/after browser output and preserves blocked-request records', async () => {
  const options = await setup(), result = await verifyApplication({ ...options, scenarios: [page] });
  const check = result.checks.find(check => check.requirementId === 'checkout');
  expect(check?.status, JSON.stringify(result.checks)).toBe('VERIFIED');
  expect(check?.baseline).toEqual({ completedSteps: 2, assertions: [{ selector: '#total', property: 'text', value: '$64.00' }] });
  expect(check?.observed).toEqual({ completedSteps: 2, assertions: [{ selector: '#total', property: 'text', value: '$64.92' }] });
  const screenshots = result.artifacts.filter(artifact => artifact.mediaType === 'image/png'); expect(screenshots).toHaveLength(2); expect(screenshots[0]?.hash).not.toBe(screenshots[1]?.hash);
  for (const artifact of screenshots) expect((await getObject(options.store, artifact.hash)).subarray(1,4).toString()).toBe('PNG');
  const traces = result.artifacts.filter(artifact => artifact.mediaType === 'application/json');
  for (const artifact of traces) expect(JSON.parse((await getObject(options.store, artifact.hash)).toString()).observations[0].record.blockedRequests).toContain('https://example.com/do-not-contact');
});
