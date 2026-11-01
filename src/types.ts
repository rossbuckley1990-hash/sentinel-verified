export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Status = 'VERIFIED' | 'CONTRADICTED' | 'UNVERIFIED' | 'REVIEW REQUIRED' | 'ENVIRONMENT FAILURE';
export interface Example { args: Json[]; expected: Json }
export interface Requirement {
  id: string; kind: 'must-change' | 'must-preserve'; description: string; module: string; export: string;
  cases: Example[];
  invariant?: { argument: number; domain: 'string' | 'number' | 'array'; seeds: Json[]; args: Json[]; expected: Json };
}
export interface Probe { id: string; module: string; export: string; inputs: Json[][] }
export interface ContractApproval {
  method: 'interactive'; approvedAt: string; proposalHash: string; baselineHash: string;
  requirementIds: string[]; resolvedQuestions: {question:string;reason:string}[];
}
export interface Contract {
  schemaVersion: 1 | 2; objective: string; approvedBy: string; requirements: Requirement[];
  probes?: Probe[]; allowedPaths?: string[]; approval?: ContractApproval; unresolved?: string[]; discoveryLimits?: string[];
}
export interface GitIdentity { root: string; head: string; branch: string; dirty: boolean }
export interface FileEntry { hash: string; size: number; mode: number }
export interface Snapshot { schemaVersion: 1; hash: string; files: Record<string, FileEntry>; git: GitIdentity }
export interface CommandRecord { command: string[]; input?: string; outputFiles?: Record<string,string>; cwd: string; exitCode: number | null; signal: string | null; stdout: string; stderr: string; durationMs: number; timedOut: boolean; truncated: boolean }
export interface Check {
  id: string; label: string; status: Status; detail: string; requirementId?: string;
  args?: Json[]; expected?: Json; observed?: Json; baseline?: Json;
  command?: CommandRecord; counterexample?: { original: Json[]; minimal: Json[]; attempts: number; guarantee: string };
}
export interface Change { path: string; kind: 'added' | 'modified' | 'deleted'; classification: Status; reason: string }
export interface Receipt {
  schemaVersion: 1; id: string; createdAt: string; objective: string;
  baselineHash: string; candidateHash: string; contractHash: string | null;
  git: GitIdentity; runner: 'local-advisory' | 'container-isolated'; contract?: Contract; checks: Check[]; changes: Change[];
  status: Status; durationMs: number; runtime?: Record<string, string>; limitations: string[]; nextActions: string[];
}
export type AgentName = 'codex' | 'claude' | 'fixture-broken' | 'fixture-fix' | 'fixture-interrupt';
export interface AgentRun { agent: AgentName; startedAt: string; completedAt: string; outcome: 'completed' | 'interrupted' | 'failed'; command?: CommandRecord; statement: string; handoff?: {contextHash:string;acknowledged:boolean;sourceHash:string;contractHash:string|null} }
export interface Checkpoint {
  schemaVersion: 1; id: string; objective: string; createdAt: string; updatedAt: string;
  repo: string; workspace: string; baselineHash: string; candidateHash: string; contractHash: string | null;
  state: 'ready' | 'running' | 'interrupted' | 'verified' | 'needs-work';
  receipts: string[]; agents: AgentRun[]; nextActions: string[]; openQuestions: string[];
  unverifiedStatements: string[]; localConsent: boolean; runner?: {kind:'local'} | {kind:'docker';image:string}; isolatedConsent?:boolean;
}
export interface VerificationOptions {
  store: string; baseline: Snapshot; candidate: Snapshot; contract: Contract | null;
  contractHash: string | null; dependencies?: string; timeoutMs?: number;
  onProgress?: (message: string) => void; onCheck?: (check: Check) => void;
}
