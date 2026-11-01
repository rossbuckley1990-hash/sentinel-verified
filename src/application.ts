import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isDeepStrictEqual } from 'node:util';
import { chromium, type Browser, type BrowserContext } from 'playwright-core';
import { applicationConfigSchema, applicationScenarioSchema, type ApplicationConfig, type ApplicationScenario, type BrowserScenario, type EvidenceArtifact, type HttpScenario } from './application-schema.js';
import { executionEnvironment } from './process.js';
import { putObject } from './store.js';
import type { Check, CommandRecord, Json } from './types.js';

const OUTPUT_LIMIT = 1_000_000, RESPONSE_LIMIT = 1_000_000, ARTIFACT_LIMIT = 4_000_000, TOTAL_ARTIFACT_LIMIT = 40_000_000;
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
type Phase = 'baseline' | 'candidate';
interface Observation { value?: Json; failure?: string; contradiction?: boolean; record?: Json }
export interface ApplicationVerificationOptions {
  store: string; baselineRoot: string; candidateRoot: string; application: ApplicationConfig;
  scenarios: ApplicationScenario[]; timeoutMs?: number; onProgress?: (message: string) => void;
}
export interface ApplicationVerificationResult { checks: Check[]; artifacts: EvidenceArtifact[]; runtime: Record<string, string> }

/** No browser is installed here. Explicit overrides fail rather than falling back. */
export async function browserLaunchOptions(): Promise<{ executablePath?: string; channel?: string; headless: true }> {
  const explicit = process.env.SENTINEL_BROWSER_EXECUTABLE;
  if (explicit) {
    await access(explicit, constants.X_OK).catch(() => { throw new Error('SENTINEL_BROWSER_EXECUTABLE is not an executable browser. No browser was downloaded or substituted.'); });
    return { executablePath: explicit, headless: true };
  }
  try { await access(chromium.executablePath(), constants.X_OK); return { headless: true }; } catch { /* Try an already installed branded browser. */ }
  const candidates = process.platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
    : process.platform === 'linux' ? ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'] : [];
  for (const executablePath of candidates) try { await access(executablePath, constants.X_OK); return { executablePath, headless: true }; } catch { /* Inspect next installed browser. */ }
  throw new Error('Browser unavailable. Install Chrome, set SENTINEL_BROWSER_EXECUTABLE, or explicitly run npx playwright-core install chromium. SENTINEL never downloads a browser implicitly.');
}

async function unusedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = createServer(); socket.once('error', reject);
    socket.listen(0, '127.0.0.1', () => { const address = socket.address(); const port = typeof address === 'object' && address ? address.port : 0; socket.close(error => error ? reject(error) : port ? resolve(port) : reject(new Error('Could not allocate a loopback port'))); });
  });
}
function localUrl(origin: string, path: string): string {
  const url = new URL(path, origin); if (url.origin !== origin) throw new Error('Application request escaped its approved loopback origin'); return url.href;
}
function killProcessGroup(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals) {
  try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal); else child.kill(signal); } catch { /* Already exited. */ }
}
interface ManagedServer { origin: string; record: CommandRecord; healthy(): boolean; exitedUnexpectedly(): boolean; stop(): Promise<void> }
async function startServer(root: string, application: ApplicationConfig): Promise<ManagedServer> {
  const port = await unusedPort(), origin = `http://127.0.0.1:${port}`;
  const command = application.command.map(argument => argument.replaceAll('{port}', String(port)));
  if (command[0] === 'node') command[0] = process.execPath;
  const started = performance.now(), home = await mkdtemp(join(tmpdir(), 'sentinel-app-home-'));
  const record: CommandRecord = { command, cwd: root, exitCode: null, signal: null, stdout: '', stderr: '', durationMs: 0, timedOut: false, truncated: false };
  const child = spawn(command[0]!, command.slice(1), { cwd: root, shell: false, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'], env: { ...executionEnvironment(), HOME: home, PORT: String(port), HOST: '127.0.0.1' } });
  let ended = false, stopping = false, unexpectedExit = false, spawnError: string | undefined;
  // 'close' waits for all inherited stdout/stderr pipes. A detached descendant
  // may keep those pipes open after the approved foreground command has failed.
  // Track process exit independently; a surviving listener cannot turn that
  // failed command into successful verification.
  child.on('exit', (code, signal) => { record.exitCode = code; record.signal = signal; ended = true; if (!stopping) unexpectedExit = true; });
  const closed = new Promise<void>(resolve => {
    child.on('error', error => { spawnError = error.message; record.stderr += error.message; ended = true; resolve(); });
    child.on('close', (code, signal) => { record.exitCode = code; record.signal = signal; ended = true; resolve(); });
  });
  child.stdin.on('error', () => { /* The server may exit before its unused stdin closes. */ }); child.stdin.end();
  const append = (key: 'stdout' | 'stderr', bytes: Buffer) => {
    const remaining = OUTPUT_LIMIT - Buffer.byteLength(record.stdout) - Buffer.byteLength(record.stderr);
    if (remaining > 0) record[key] += bytes.subarray(0, remaining).toString('utf8');
    if (bytes.length > remaining) { record.truncated = true; killProcessGroup(child, 'SIGKILL'); }
  };
  child.stdout.on('data', data => append('stdout', data)); child.stderr.on('data', data => append('stderr', data));
  const stop = async () => {
    if (stopping) return; stopping = true;
    // A child can exit while a descendant retains the listening socket. Always stop its original process group.
    killProcessGroup(child, 'SIGTERM');
    await Promise.race([closed, pause(300)]); killProcessGroup(child, 'SIGKILL');
    await Promise.race([closed, pause(300)]);
    record.durationMs = Math.round(performance.now() - started); await rm(home, { recursive: true, force: true });
  };
  try {
    const until = performance.now() + (application.startupTimeoutMs ?? 15_000);
    while (performance.now() < until) {
      if (ended || record.truncated) throw new Error(`Application process exited before readiness: ${spawnError ?? (record.stderr.slice(-1000) || record.exitCode)}`);
      try {
        const response = await fetch(localUrl(origin, application.readyPath ?? '/'), { redirect: 'manual', signal: AbortSignal.timeout(Math.min(500, Math.max(1, Math.ceil(until - performance.now())))) });
        await response.body?.cancel();
        if (response.ok) { await pause(50); if (!ended && !record.truncated) return { origin, record, healthy: () => !ended && !record.truncated, exitedUnexpectedly: () => unexpectedExit, stop }; }
      } catch { /* Wait for the child to bind. */ }
      await pause(30);
    }
    record.timedOut = true; throw new Error(`Application readiness exceeded ${application.startupTimeoutMs ?? 15_000} ms at ${application.readyPath ?? '/'}`);
  } catch (error) { await stop(); throw Object.assign(new Error(String(error)), { command: record }); }
}

async function readResponse(response: Response): Promise<string> {
  const reader = response.body?.getReader(); if (!reader) return '';
  const chunks: Uint8Array[] = []; let count = 0;
  try { for (;;) { const { done, value } = await reader.read(); if (done) break; count += value.length; if (count > RESPONSE_LIMIT) throw new Error('HTTP response exceeds 1 MB'); chunks.push(value); } }
  finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks).toString('utf8');
}
function expectedScenario(scenario: ApplicationScenario): Json {
  return scenario.type === 'http' ? { status: scenario.expected.status, body: scenario.expected.body }
    : { completedSteps: scenario.steps.length, assertions: scenario.assertions.map(assertion => ({ selector: assertion.selector, property: assertion.property, value: assertion.expected })) };
}
async function observeHttp(origin: string, scenario: HttpScenario, timeoutMs: number): Promise<Observation> {
  const url = localUrl(origin, scenario.path), start = performance.now();
  try {
    const response = await fetch(url, { method: scenario.method, redirect: 'manual', ...(scenario.body === undefined ? {} : { body: JSON.stringify(scenario.body), headers: { 'content-type': 'application/json' } }), signal: AbortSignal.timeout(timeoutMs) });
    const text = await readResponse(response); let body: Json = text;
    if (scenario.expected.bodyType === 'json') {
      try { body = JSON.parse(text) as Json; }
      catch { return { value: { status: response.status, body: text, invalidJson: true }, record: { request: { method: scenario.method, path: scenario.path }, responseBody: text, parseError: 'Expected JSON response was malformed' } }; }
    }
    const value: Json = { status: response.status, body };
    return { value, record: { request: { method: scenario.method, path: scenario.path, ...(scenario.body === undefined ? {} : { body: scenario.body }) }, response: value, durationMs: Math.round(performance.now() - start), redirectsFollowed: false } };
  } catch (error) { return { failure: `HTTP execution could not complete: ${String(error)}` }; }
}

async function observeBrowser(browser: Browser, origin: string, scenario: BrowserScenario, timeoutMs: number, saveScreenshot: (bytes: Buffer) => Promise<void>): Promise<Observation> {
  let context: BrowserContext | undefined; const started = performance.now(); let completedSteps = 0;
  const assertions: Json[] = [], blocked: string[] = [], errors: string[] = [];
  const remaining = () => { const ms = Math.ceil(timeoutMs - (performance.now() - started)); if (ms <= 0) throw new Error('Browser scenario time budget exhausted'); return Math.max(1, ms); };
  try {
    context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, serviceWorkers: 'block', acceptDownloads: false, locale: 'en-GB', timezoneId: 'UTC' });
    await context.route('**/*', async route => {
      const url = route.request().url();
      if (url.startsWith('data:') || url.startsWith('blob:') || new URL(url).origin === origin) await route.continue();
      else { if (blocked.length < 20) blocked.push(url.slice(0,500)); await route.abort('blockedbyclient'); }
    });
    // Requests initiated by frames/workers remain subject to context routing. WebSockets need their own handler.
    await context.routeWebSocket('**/*', socket => { if (blocked.length < 20) blocked.push(socket.url().slice(0,500)); socket.close(); });
    const page = await context.newPage(); page.on('pageerror', error => { if (errors.length < 10) errors.push(error.message.slice(0,1000)); });
    page.setDefaultTimeout(Math.min(timeoutMs, 5000));
    await page.goto(localUrl(origin, scenario.path), { waitUntil: 'domcontentloaded', timeout: remaining() });
    for (const step of scenario.steps) {
      const element = page.locator(step.selector); const timeout = Math.min(remaining(), 5000);
      try {
        if (step.action === 'click') await element.click({ timeout });
        else if (step.action === 'press') await element.press(step.key, { timeout });
        else if (step.action === 'fill') await element.fill(step.value, { timeout });
        else if (step.action === 'select') await element.selectOption(step.value, { timeout });
        else await element.setChecked(step.checked, { timeout });
        completedSteps++;
      } catch (error) {
        // An absent/non-actionable approved control is a behavioural contradiction, not a successful check.
        await saveScreenshot(await page.screenshot({ type: 'png', fullPage: false, timeout: Math.min(5000, remaining()) }));
        return { value: { completedSteps, failedStep: completedSteps }, contradiction: true, record: { path: scenario.path, completedSteps, failedStep: step as unknown as Json, interactionError: String(error).slice(0,2000), blockedRequests: blocked, pageErrors: errors } };
      }
    }
    // UI updates can follow an asynchronous request. Poll the approved assertions,
    // retaining the final observed values when they fail, rather than converting
    // a normal assertion mismatch into an infrastructure timeout.
    const assertionUntil = performance.now() + Math.min(3000, Math.max(100, remaining() - 1000));
    do {
      assertions.length = 0;
      for (const assertion of scenario.assertions) {
        const element = page.locator(assertion.selector); remaining();
        const count = await element.count(); let value: Json = null;
        if (assertion.property === 'visible') value = count === 1 && await element.isVisible();
        else if (count === 1) {
          value = assertion.property === 'text' ? await element.textContent({ timeout: Math.min(remaining(), 5000) }) : await element.inputValue({ timeout: Math.min(remaining(), 5000) });
          if (typeof value === 'string' && value.length > 10_000) throw new Error('Browser assertion output exceeds 10 KB');
        }
        assertions.push({ selector: assertion.selector, property: assertion.property, value, ...(count > 1 ? { matchedElements: count } : {}) });
      }
      if (isDeepStrictEqual({ completedSteps, assertions }, expectedScenario(scenario))) break;
      await pause(50);
    } while (performance.now() < assertionUntil);
    await saveScreenshot(await page.screenshot({ type: 'png', fullPage: false, timeout: Math.min(5000, remaining()) }));
    return { value: { completedSteps, assertions }, record: { path: scenario.path, steps: scenario.steps as unknown as Json, completedSteps, assertions, blockedRequests: blocked, pageErrors: errors, durationMs: Math.round(performance.now() - started) } };
  } catch (error) { return { failure: `Browser execution could not complete: ${String(error)}`, record: { path: scenario.path, completedSteps, assertions, blockedRequests: blocked, pageErrors: errors } }; }
  finally { await context?.close().catch(() => {}); }
}

/** Execute approved external observations. This advisory process does not sandbox the application server. */
export async function verifyApplication(options: ApplicationVerificationOptions): Promise<ApplicationVerificationResult> {
  const deadline = performance.now() + 300_000;
  const application = applicationConfigSchema.parse(options.application);
  const scenarios = applicationScenarioSchema.array().min(1).max(20).parse(options.scenarios);
  const timeoutMs = Math.min(Math.max(options.timeoutMs ?? 15_000, 100), 60_000);
  const checks: Check[] = [], artifacts: EvidenceArtifact[] = [], runtime: Record<string, string> = { applicationProtocol: '1', applicationCommand: 'Exact executed argv is recorded in the baseline and candidate server lifecycle command records.', applicationEnvironment: 'PORT=fresh loopback port; HOST=127.0.0.1; HOME=temporary empty directory; inherited secret variables removed', browserNetworkPolicy: 'same-origin HTTP; WebSockets and service workers blocked; server is not network-isolated' };
  const observations = new Map<string, { baseline?: Observation[]; candidate?: Observation[] }>();
  let browser: Browser | undefined, browserFailure: string | undefined, artifactBytes = 0;
  const save = async (phase: Phase, scenarioId: string, label: string, mediaType: EvidenceArtifact['mediaType'], bytes: Buffer) => {
    if (bytes.length > ARTIFACT_LIMIT || artifactBytes + bytes.length > TOTAL_ARTIFACT_LIMIT) throw new Error('Application evidence exceeds its bounded artifact storage budget');
    const hash = await putObject(options.store, bytes); artifactBytes += bytes.length; artifacts.push({ hash, mediaType, label: label.slice(0,2000), phase, scenarioId, bytes: bytes.length });
  };
  if (scenarios.some(scenario => scenario.type === 'browser')) try {
    const launch = await browserLaunchOptions(); browser = await chromium.launch({ ...launch, timeout: 15_000, env: executionEnvironment() });
    runtime.browserVersion = browser.version(); runtime.browserExecutable = launch.executablePath ?? chromium.executablePath();
  } catch (error) { browserFailure = String(error); }
  try {
    for (const phase of ['baseline', 'candidate'] as const) {
      options.onProgress?.(`Starting ${phase} application in a temporary verification copy`);
      let server: ManagedServer | undefined;
      try {
        const startupBudget = Math.floor(deadline - performance.now());
        if (startupBudget < 100) throw new Error('Application verification exceeded its five-minute total budget');
        server = await startServer(phase === 'baseline' ? options.baselineRoot : options.candidateRoot, { ...application, startupTimeoutMs: Math.min(application.startupTimeoutMs ?? 15_000, startupBudget) });
        runtime[`${phase}ApplicationOrigin`] = server.origin;
        for (const scenario of scenarios) {
          options.onProgress?.(`Checking ${phase} ${scenario.type}: ${scenario.description}`);
          const runs: Observation[] = [];
          for (let repeat = 0; repeat < 2; repeat++) {
            const executionTimeout = Math.min(timeoutMs, Math.ceil(deadline - performance.now()));
            if (executionTimeout <= 0) { runs.push({ failure: 'Application verification exceeded its five-minute total budget' }); break; }
            if (!server.healthy()) { runs.push({ failure: 'Application process stopped or exceeded the output limit during verification' }); break; }
            const result = scenario.type === 'http' ? await observeHttp(server.origin, scenario, executionTimeout)
              : browser ? await observeBrowser(browser, server.origin, scenario, executionTimeout, async bytes => { if (repeat === 0) await save(phase, scenario.id, `${phase === 'baseline' ? 'Before' : 'After'} · ${scenario.description}`, 'image/png', bytes); })
                : { failure: browserFailure ?? 'Browser unavailable' };
            if (!server.healthy()) result.failure = 'Application process stopped or exceeded the output limit during verification';
            runs.push(result);
          }
          const pair = observations.get(scenario.id) ?? {}; pair[phase] = runs; observations.set(scenario.id, pair);
          await save(phase, scenario.id, `${phase} execution record · ${scenario.description}`, 'application/json', Buffer.from(JSON.stringify({ schemaVersion: 1, phase, scenario, observations: runs }, null, 2)));
        }
      } catch (error) {
        checks.push({ id: `application:${phase}`, label: `${phase} application execution`, status: 'ENVIRONMENT FAILURE', detail: String(error), ...((error as { command?: CommandRecord }).command ? { command: (error as { command: CommandRecord }).command } : {}) });
      } finally {
        if (server) { await server.stop(); checks.push({ id: `application-server:${phase}`, label: `${phase} server lifecycle`, status: server.record.truncated || server.exitedUnexpectedly() ? 'ENVIRONMENT FAILURE' : 'VERIFIED', detail: server.record.truncated ? 'Server exceeded its 1 MB output limit' : server.exitedUnexpectedly() ? 'Approved foreground server command exited unexpectedly; a surviving descendant is not a reliable server execution.' : 'Approved server command started on a fresh loopback port and was stopped after observation. This is execution evidence, not an acceptance result.', command: server.record }); }
      }
    }
  } finally { await browser?.close().catch(() => {}); }
  for (const scenario of scenarios) {
    const pair = observations.get(scenario.id), baseline = pair?.baseline, candidate = pair?.candidate, expected = expectedScenario(scenario);
    const failure = [...(baseline ?? []), ...(candidate ?? [])].find(run => run.failure)?.failure;
    const repeated = baseline?.length === 2 && candidate?.length === 2;
    const deterministic = repeated && isDeepStrictEqual(candidate![0]!.value, candidate![1]!.value) && isDeepStrictEqual(baseline![0]!.value, baseline![1]!.value);
    const correct = candidate?.every(run => isDeepStrictEqual(run.value, expected)) === true;
    const preserveMismatch = scenario.kind === 'must-preserve' && baseline?.some(run => !isDeepStrictEqual(run.value, expected));
    const status = failure || !repeated ? 'ENVIRONMENT FAILURE' : !deterministic ? 'UNVERIFIED' : !correct ? 'CONTRADICTED' : preserveMismatch ? 'REVIEW REQUIRED' : 'VERIFIED';
    checks.push({ id: `req:${scenario.id}`, requirementId: scenario.id, label: scenario.description, status,
      detail: failure ?? (!repeated ? 'Application observation did not complete for both source versions' : !deterministic ? 'Repeated application observations differed; the deterministic requirement was not satisfied' : !correct ? 'The observed application response contradicts the approved acceptance scenario' : preserveMismatch ? 'Candidate meets the expected result but baseline does not; review this must-preserve requirement' : 'The approved application scenario passed twice. This establishes only the specified observations.'),
      args: [{ type: scenario.type, path: scenario.path, ...(scenario.type === 'http' ? { method: scenario.method, body: scenario.body ?? null } : { steps: scenario.steps as unknown as Json }) }], expected, ...(candidate?.[0]?.value === undefined ? {} : { observed: candidate[0].value }), ...(baseline?.[0]?.value === undefined ? {} : { baseline: baseline[0].value }),
    });
  }
  return { checks, artifacts, runtime };
}
