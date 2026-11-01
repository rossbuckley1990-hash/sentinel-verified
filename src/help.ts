export const help=`SENTINEL · evidence-backed verification and continuity

  sentinel demo                         Run the React + HTTP offline experiment
  sentinel run "objective"               Start an agent in a managed workspace
  sentinel continue [--agent claude]     Resume checked and unverified work
  sentinel verify --baseline HEAD        Verify current repository changes
  sentinel inspect                       Inspect the current checkpoint
  sentinel report --open                 Open the current local HTML report
  sentinel replay RECEIPT_HASH           Re-run a stored verification snapshot
  sentinel export --out task.sentinel.json  Export portable source + evidence
  sentinel import task.sentinel.json     Restore a checkpoint into a new store
  sentinel doctor                        Detect installed agent CLI capabilities

  --repo PATH          Input Git repository (default: current directory)
  --contract FILE      Optional reviewed JSON contract (otherwise propose and approve interactively)
  --agent NAME         codex or claude (run auto-detects if omitted)
  --allow-local        Consent to running project code locally without isolation
  --runner local|docker  Verification runner; Docker never falls back to local
  --allow-container    Consent to configured container verification
  --image IMAGE        Reviewed Docker image (default: sentinel-runner:1.0.0)
  --open               Open the generated report in the default browser
  --verbose            Show detailed progress diagnostics
  --store PATH         Evidence store (default: ~/.sentinel or SENTINEL_HOME)
  --session ID         Select a checkpoint instead of the latest session
  --adopt-changes       Explicitly accept manual workspace edits as unverified
  --repairs N          Maximum additional repair attempts (default: 1; range 0..3)
  --propose-with codex  Opt in to model suggestions before human approval
  --functions          With demo: run the original browser-free function experiment
  --patch              With export: write a reviewable Git patch
  --timeout MS         Agent timeout (default: 600000)
  --check-timeout MS   Local verification subprocess bound (default: 15000)

Local checks are advisory. Use a disposable isolated machine for untrusted code.
Exit: 0 scoped checks passed; 1 contradiction/review/unknown; 2 usage/infrastructure error.
`;
