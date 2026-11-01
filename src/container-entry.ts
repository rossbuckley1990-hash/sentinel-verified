// Trusted entrypoint baked into the explicitly built runner image. No host code is executed here.
import { readFile, symlink } from 'node:fs/promises';
import { readSnapshot, getObject } from './store.js';
import { parseContract } from './schema.js';
import { verify } from './verifier.js';
import type { ContainerRequest } from './isolation.js';
const request = JSON.parse(await readFile('/input/request.json', 'utf8')) as ContainerRequest;
if (request.schemaVersion !== 1 || !/^[a-f0-9]{64}$/.test(request.baselineHash) || !/^[a-f0-9]{64}$/.test(request.candidateHash) || !Number.isInteger(request.timeoutMs) || request.timeoutMs < 100 || request.timeoutMs > 30000) throw new Error('Invalid container verification request.');
await symlink('/input/objects', '/store/objects', 'dir');
const baseline = await readSnapshot('/store', request.baselineHash);
const candidate = await readSnapshot('/store', request.candidateHash);
const contract = request.contractHash ? parseContract(JSON.parse((await getObject('/store', request.contractHash)).toString())) : null;
const receipt = await verify({ store: '/store', baseline, candidate, contract, contractHash: request.contractHash, dependencies: '/app/node_modules', timeoutMs: request.timeoutMs, onProgress: message => process.stdout.write(`SENTINEL_PROGRESS:${message}\n`) });
const text = JSON.stringify(receipt);
if (Buffer.byteLength(text) > 950000) throw new Error('Container receipt exceeds the supported output budget.');
process.stdout.write(`SENTINEL_CONTAINER_RECEIPT:${text}\n`);
