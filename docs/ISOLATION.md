# Optional container verification

The normal offline demo needs no Docker installation. SENTINEL still offers explicitly consented local advisory execution. An optional Docker boundary remains available **for independent deterministic function verification**. It does not move the selected coding agent into that container: the agent's own sandbox/permissions still apply. For a genuinely untrusted repository, use container verification without launching a host agent, or isolate the entire agent environment separately.

Build the reviewed runner image explicitly from this repository:

```sh
docker build --load -f Dockerfile.runner -t sentinel-runner:local .
```

The Dockerfile pins a multi-platform Node 24 base digest and installs the committed npm lockfile. Building may use the network to fetch that base and dependencies. Verification never pulls an image, starts a daemon or installs project dependencies. A local Unix-socket Docker context is required. Docker Desktop supplies that on supported Macs; a configured local Docker Engine supplies it on Linux.

Select this explicit local image with `--runner docker --image sentinel-runner:local --allow-container`. `--allow-container` is distinct from `--allow-local`. Changing runner mode or image requires fresh consent; an imported checkpoint resets consent. If the requested runner is absent, incompatible, fails, exceeds its budget or cannot produce an intact receipt, verification fails explicitly. **There is no fallback to unrestricted execution.**

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

Historical **v0.2.0** local validation on 2026-11-01 used Docker Engine 29.9.2 on an Apple Silicon Mac, the Linux arm64 Node 24.22.2 runtime, and Vitest 5.0.5. All four tests passed in 12.50 seconds against image `sha256:a1e20d838d649a48318aed7d4b73aea4aed155eb99053d4d14cb9ff0d335e16c`. The schema-2 test uses a controlled approval fixture, not live human approval: its protected proposal authorises replacing an empty function with actual boundary observations. The test confirms the baseline returns `null`, the candidate passes, and the receipt retains the exact contract and proposal identities. Executed probes observed `rootWritable: false`, `inputWritable: false`, `secret: null`, and `network: false`. That image was built locally from the reviewed source; it is not a separately authenticated release image. The first development attempt exposed Vitest's default dependency-cache writes, and the corrected verifier disables those caches. These historical results do not validate a newly built v1 image; consult the current release validation record for that execution status.

## Interrupted agents

SENTINEL records the installed agent CLI's process ID durably before sending its task prompt. Graceful completion or interruption clears that owned process lease. If the coordinator is killed abruptly, continuation checks the surviving lease and refuses while its recorded process ID is alive; it never kills a process merely because a checkpoint names that PID. PID reuse can therefore cause a conservative refusal that requires inspection. Once the prior process is confirmed absent, partial source is captured as unverified and can be continued. This protects the recorded CLI process; it does not discover arbitrary background processes spawned independently by an agent or hostile executable.

References: [Docker run controls](https://docs.docker.com/engine/containers/run/) and [Docker Engine's security boundaries](https://docs.docker.com/engine/security/).

## HTTP and browser applications

The application verifier currently supports local advisory execution only. A contract with an application server is rejected when `--runner docker` is requested, with an explicit unsupported-runner error. It does not silently continue on the host. The existing Docker function-verification path remains available.

Local application checks start the approved argument-vector command in fresh baseline/candidate source copies, supply a fresh loopback port, use a temporary home and strip inherited secret environment variables. They stop the owned process group after each phase and bound startup, request, scenario and output budgets. These controls improve reproducibility and lifecycle handling; they do not contain a malicious server or independently detached descendants.

Playwright uses an installed browser or an explicitly selected executable; SENTINEL does not silently download browsers. Fresh browser contexts isolate cookies and storage between scenarios. Service workers and WebSockets are blocked, external HTTP requests intercepted by routing are aborted, and their attempted URLs are recorded. This routing policy is not OS-level network isolation: it does not constrain the server's network or establish security against every browser protocol, a compromised browser or browser vulnerabilities.

The coding agent always remains outside this verifier boundary and uses its own documented permission controls. Selecting Docker for function checks does not put Codex or Claude inside Docker. Local consent for application verification likewise does not establish an agent sandbox. For untrusted application code, isolate the entire workflow using a reviewed disposable environment before granting local execution consent.

## Evidence controls are separate from isolation

Schema-3 approval binds the reviewed criteria, application command, permitted changes, objective coverage and baseline. Schema-2 receipts retain source identities and hashes for actual browser screenshots and execution records. Atomic checkpoints, immutable-by-content objects, malformed-import rejection and bounded repairs help detect ordinary corruption and preserve progress. They do not prevent an unrestricted hostile host process from replacing the complete store or verifier.

Individual objects have a 32 MB limit, application artifacts 4 MB each/40 MB per receipt, and portable exports retain their 300 MB limit. There is no global evidence-disk quota or automatic eviction. Patch export checks the captured changes against a disposable baseline and never applies them to the original project. Neither a patch nor a receipt authorises a merge or deployment.
