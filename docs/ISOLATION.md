# Optional container verification

The normal offline demo needs no Docker installation. SENTINEL still offers explicitly consented local advisory execution. Version 0.2 adds an optional Docker boundary **for the independent verifier**. It does not move the selected coding agent into that container: the agent's own sandbox/permissions still apply. For a genuinely untrusted repository, use container verification without launching a host agent, or isolate the entire agent environment separately.

Build the reviewed runner image explicitly from this repository:

```sh
docker build --load -f Dockerfile.runner -t sentinel-runner:0.2.0 .
```

The Dockerfile pins a multi-platform Node 24 base digest and installs the committed npm lockfile. Building may use the network to fetch that base and dependencies. Verification never pulls an image, starts a daemon or installs project dependencies. A local Unix-socket Docker context is required. Docker Desktop supplies that on supported Macs; a configured local Docker Engine supplies it on Linux.

Select the container runner with `--runner docker --allow-container`. `--allow-container` is distinct from `--allow-local`. Changing runner mode or image requires fresh consent; an imported checkpoint resets consent. If the requested runner is absent, incompatible, fails, exceeds its budget or cannot produce an intact receipt, verification fails explicitly. **There is no fallback to unrestricted execution.**

## Controls

The host resolves the configured image to its immutable image ID and records that identity in the receipt. It then runs the trusted verifier entrypoint with:

- No network (`--network none`) and no published ports.
- A read-only root filesystem and non-root UID/GID 1000.
- All Linux capabilities dropped and `no-new-privileges` enabled.
- A 2-CPU quota, 1 GiB memory/swap ceiling and 128-process limit.
- Bounded temporary filesystems for scratch execution: 512 MiB for `/store`, 128 MiB for `/tmp`.
- A 32 MiB per-file write limit, a 30-second maximum per-check budget, and a 180-second total verification limit. Larger requested check timeouts remain capped in this runner; the effective budget is recorded in the receipt.
- One host mount, read-only, containing only the selected baseline/candidate content objects, approved contract and request metadata.

There is no host workspace, `node_modules`, home directory, credential environment or Docker socket mount. Results leave the container through bounded standard output; there is no writable host mount. Timeouts also force-remove the exact generated container name, because terminating a Docker client alone need not stop its container.

The initial image includes SENTINEL's pinned Vitest/tsx dependencies. Other project dependencies are unavailable unless a reviewed image includes them. Custom project setup/configuration remains outside the verifier's initial scope. Missing dependencies fail rather than silently switching to host execution. Receipts over the bounded output size fail explicitly.

## Trust and limits

Docker's daemon, host kernel/VM, installed CLI, reviewed image and SENTINEL coordinator remain trusted. A locally replaceable image label is a compatibility check, not authentication. Content hashes still do not authenticate a maliciously rewritten evidence store. Container isolation protects the host boundary under the stated controls; it does not prove source correctness or prevent every attack on the verifier from within its execution environment. Source and evidence passed into the container can be read by that code. No defence against unknown container/host vulnerabilities is claimed.

The entrypoint protocol and argument construction have offline tests. The opt-in integration test executes real code that attempts to write the image/root and input objects, read a host-only environment variable and reach an external network address:

```sh
SENTINEL_TEST_DOCKER=1 npx vitest run test/isolation.test.ts
```

Treat a successful test as evidence for those concrete probes, not a universal sandbox proof. The release validation record states whether the live container path was executed in its environment.

Final local validation on 2026-11-01 used Docker Engine 29.9.2 on an Apple Silicon Mac, the Linux arm64 Node 24.22.2 runtime, and Vitest 5.0.5. All four tests passed in 12.50 seconds against image `sha256:a1e20d838d649a48318aed7d4b73aea4aed155eb99053d4d14cb9ff0d335e16c`. The schema-2 test uses a controlled approval fixture, not live human approval: its protected proposal authorises replacing an empty function with actual boundary observations. The test confirms the baseline returns `null`, the candidate passes, and the receipt retains the exact contract and proposal identities. Executed probes observed `rootWritable: false`, `inputWritable: false`, `secret: null`, and `network: false`. That image was built locally from the reviewed source; it is not a separately authenticated release image. The first development attempt exposed Vitest's default dependency-cache writes, and the corrected verifier disables those caches.

## Interrupted agents

SENTINEL records the installed agent CLI's process ID durably before sending its task prompt. Graceful completion or interruption clears that owned process lease. If the coordinator is killed abruptly, continuation checks the surviving lease and refuses while its recorded process ID is alive; it never kills a process merely because a checkpoint names that PID. PID reuse can therefore cause a conservative refusal that requires inspection. Once the prior process is confirmed absent, partial source is captured as unverified and can be continued. This protects the recorded CLI process; it does not discover arbitrary background processes spawned independently by an agent or hostile executable.

References: [Docker run controls](https://docs.docker.com/engine/containers/run/) and [Docker Engine's security boundaries](https://docs.docker.com/engine/security/).
