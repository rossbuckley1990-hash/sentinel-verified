import { VERSION } from './version.js';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { getObject, readSnapshot } from './store.js';
import { runCommand, executionEnvironment } from './process.js';
import { verify } from './verifier.js';
import type { Receipt, VerificationOptions } from './types.js';

export type RunnerChoice = { kind: 'local' } | { kind: 'docker'; image: string };
export const DEFAULT_RUNNER_IMAGE = `sentinel-runner:${VERSION}`;
export interface ContainerRequest { schemaVersion: 1; baselineHash: string; candidateHash: string; contractHash: string | null; timeoutMs: number }
const imagePattern = /^[a-zA-Z0-9][a-zA-Z0-9_.:/@-]{0,255}$/;
const imageIdPattern = /^sha256:[a-f0-9]{64}$/;
export interface DockerReadiness { available: boolean; image: string; imageId?: string; reason: string }

/** Never pull, start a daemon, or fall back to a local process during discovery. */
export async function inspectDocker(image = DEFAULT_RUNNER_IMAGE): Promise<DockerReadiness> {
  if (!imagePattern.test(image)) return { available: false, image, reason: 'Invalid Docker image reference.' };
  const env = executionEnvironment();
  const context = await runCommand(['docker', 'context', 'inspect', '--format', '{{(index .Endpoints "docker").Host}}'], process.cwd(), { timeoutMs: 10000, env });
  if (context.exitCode !== 0 || !context.stdout.trim().startsWith('unix://')) return { available: false, image, reason: 'A local Unix-socket Docker context is required; remote daemon execution is not supported.' };
  const result = await runCommand(['docker', 'image', 'inspect', image, '--format', '{{json .}}'], process.cwd(), { timeoutMs: 10000, env });
  if (result.exitCode !== 0) return { available: false, image, reason: `Docker or the reviewed runner image is unavailable. Build it explicitly with Dockerfile.runner. ${result.stderr.slice(0,300)}` };
  try {
    const info = JSON.parse(result.stdout) as { Id?: string; Config?: { Labels?: Record<string,string> } };
    if (!info.Id || !imageIdPattern.test(info.Id) || info.Config?.Labels?.['org.sentinel.runner.protocol'] !== '1') throw new Error('Image does not implement SENTINEL runner protocol 1.');
    return { available: true, image, imageId: info.Id, reason: 'Local runner image is available; execution uses its immutable image ID.' };
  } catch (error) { return { available: false, image, reason: String(error) }; }
}

/** The only mounted host directory contains selected, read-only evidence objects. */
export function dockerVerificationCommand(imageId: string, inputDirectory: string, name: string): string[] {
  if (!imageIdPattern.test(imageId)) throw new Error('A resolved immutable image ID is required.');
  if (!/^sentinel-verify-[a-f0-9-]+$/.test(name)) throw new Error('Invalid container identity.');
  const directory = resolve(inputDirectory);
  // Docker's --mount syntax uses commas as delimiters, so reject rather than reparse a path.
  if (directory.includes(',') || /[\x00-\x1f\x7f]/.test(directory)) throw new Error('Runner staging path contains unsupported characters.');
  return ['docker', 'run', '--rm', '--init', '--name', name, '--pull', 'never', '--network', 'none', '--read-only',
    '--user', '1000:1000', '--cpus', '2', '--memory', '1g', '--memory-swap', '1g', '--pids-limit', '128',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges=true', '--ulimit', 'nofile=1024:1024', '--ulimit', 'fsize=33554432:33554432',
    '--tmpfs', '/store:rw,nosuid,nodev,noexec,size=536870912,mode=1777', '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=134217728,mode=1777',
    '--mount', `type=bind,source=${directory},target=/input,readonly`,
    '--env', 'HOME=/tmp', '--env', 'TMPDIR=/tmp', '--env', 'CI=1', '--env', 'NO_COLOR=1', '--env', 'TZ=UTC',
    '--workdir', '/app', '--entrypoint', '/usr/local/bin/node', imageId, '/app/dist/container-entry.js'];
}

/** The caller is responsible for the explicit local/container execution consent. */
export async function executeVerification(options: VerificationOptions, runner: RunnerChoice = { kind: 'local' }): Promise<Receipt> {
  if (runner.kind === 'local') return verify(options);
  if (runner.kind !== 'docker') throw new Error('Unknown verification runner. No local fallback was attempted.');
  if(options.contract?.application)throw new Error('Application/browser verification currently requires the explicitly approved local runner. Docker application verification is unsupported; no local fallback was attempted.');
  const readiness = await inspectDocker(runner.image);
  if (!readiness.available || !readiness.imageId) throw new Error(`Requested Docker isolation is unavailable. No local fallback was attempted. ${readiness.reason}`);
  const baseline = await readSnapshot(options.store, options.baseline.hash);
  const candidate = await readSnapshot(options.store, options.candidate.hash);
  if (!isDeepStrictEqual(baseline, options.baseline) || !isDeepStrictEqual(candidate, options.candidate)) throw new Error('Snapshot manifest does not match its content hash.');
  if (options.contractHash) {
    const contract = JSON.parse((await getObject(options.store, options.contractHash)).toString());
    if (!isDeepStrictEqual(contract, options.contract)) throw new Error('Contract does not match its content hash.');
  } else if (options.contract) throw new Error('Approved contract requires a content hash.');
  const staging = await mkdtemp(join(tmpdir(), 'sentinel-container-'));
  const name = `sentinel-verify-${randomUUID()}`;
  try {
    await chmod(staging, 0o755);
    const objects = join(staging, 'objects');
    await mkdir(objects, { mode: 0o755 });
    const hashes = new Set([baseline.hash, candidate.hash, ...Object.values(baseline.files).map(f => f.hash), ...Object.values(candidate.files).map(f => f.hash), ...(options.contractHash ? [options.contractHash] : []), ...(options.contract?.approval ? [options.contract.approval.proposalHash] : [])]);
    for (const hash of hashes) await writeFile(join(objects, hash), await getObject(options.store, hash), { flag: 'wx', mode: 0o444 });
    const request: ContainerRequest = { schemaVersion: 1, baselineHash: baseline.hash, candidateHash: candidate.hash, contractHash: options.contractHash, timeoutMs: Math.min(options.timeoutMs ?? 15000, 30000) };
    await writeFile(join(staging, 'request.json'), JSON.stringify(request), { mode: 0o444, flag: 'wx' });
    options.onProgress?.(`Verification is isolated in Docker (${readiness.imageId.slice(0,19)}); network disabled, host evidence read-only.`);
    const command = dockerVerificationCommand(readiness.imageId, staging, name);
    const result = await runCommand(command, process.cwd(), { timeoutMs: 180000, env: executionEnvironment(), onOutput: text => {
      for (const line of text.split('\n')) if (line.startsWith('SENTINEL_PROGRESS:')) options.onProgress?.(line.slice('SENTINEL_PROGRESS:'.length).slice(0,500));
    } });
    if (result.exitCode !== 0 || result.timedOut || result.signal || result.truncated) throw new Error(`Container verification did not complete reliably (${result.timedOut ? '180-second timeout' : result.truncated ? '1 MB output limit' : result.signal ?? result.exitCode}). No local fallback was attempted. ${result.stderr.slice(-1000)}`);
    const prefix = 'SENTINEL_CONTAINER_RECEIPT:';
    const lines = result.stdout.split('\n').filter(line => line.startsWith(prefix));
    if (lines.length !== 1) throw new Error('Container produced no unique receipt. No local fallback was attempted.');
    const receipt = JSON.parse(lines[0]!.slice(prefix.length)) as Receipt;
    if (![1,2].includes(receipt.schemaVersion) || receipt.baselineHash !== baseline.hash || receipt.candidateHash !== candidate.hash || receipt.contractHash !== options.contractHash || !Array.isArray(receipt.checks) || !Array.isArray(receipt.limitations)) throw new Error('Container receipt does not match the requested source and contract.');
    // Docker contains source execution; neither the image nor the evidence is cryptographically authenticated.
    receipt.runner = 'container-isolated';
    receipt.runtime = { ...receipt.runtime, containerImageId: readiness.imageId, containerNetwork: 'none', containerMemory: '1g', containerCpus: '2', containerCheckTimeoutMs: String(request.timeoutMs), containerTotalTimeoutMs: '180000' };
    receipt.limitations = [
      'Verification executed inside the configured Docker image with network disabled, a read-only root filesystem and only selected read-only input objects mounted. The agent itself still uses its own permission controls.',
      'Docker, its daemon, the host kernel/VM and this reviewed runner image remain trusted. This is not a proof against container escapes or falsification inside an adversarially replaced image.',
      'Only dependencies baked into the image are available. Host node_modules and developer credentials were not mounted.',
      ...receipt.limitations.filter(line => !line.startsWith('Local advisory execution under the same OS account')),
    ];
    receipt.checks.push({ id: 'container-execution', label: 'Container execution boundary', status: 'VERIFIED', detail: 'The configured container command completed; this records the execution controls, not semantic correctness or authenticated provenance.', command: result });
    for(const check of receipt.checks) if(!check.id.startsWith('baseline:')&&!check.id.startsWith('probe-baseline:')&&!check.id.startsWith('mutation:')) options.onCheck?.(check);
    // Restore input-integrity validation on the host after the container has exited.
    for (const hash of hashes) await getObject(options.store, hash);
    return receipt;
  } finally {
    // Killing the docker client alone can leave the container running. Remove this exact generated name.
    await runCommand(['docker', 'rm', '--force', name], process.cwd(), { timeoutMs: 10000, env: executionEnvironment() });
    await rm(staging, { recursive: true, force: true });
  }
}
