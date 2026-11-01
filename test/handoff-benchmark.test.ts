import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  createHistoricalReceiver, informedSummaryExample, runHandoffBenchmark,
  runRetentionTrials, SUMMARY_SEARCH_CASES, type ReceiverObservation,
} from '../src/handoff-benchmark.js';
import { contractForPublicCase, loadPublicCases } from '../src/public-benchmark.js';
import { digest } from '../src/store.js';

describe('controlled information-retention protocol', () => {
  it('declares search inputs using independently approved historical contract examples', async () => {
    const historical = (await loadPublicCases()).find(c => c.id === 'is-number-historical-nonfix')!;
    const approved = contractForPublicCase(historical)!.requirements.flatMap(requirement => requirement.cases);
    for (const example of SUMMARY_SEARCH_CASES) expect(approved).toContainEqual(example);
  });

  it('counts actual receiver invocations and exposes controls that remove the apparent benefit', async () => {
    // Unit-only executor simulation; published measurements use the real pinned function.
    const calls: unknown[][] = [];
    const receiver = async (args: unknown[]): Promise<ReceiverObservation> => {
      calls.push(args);
      const approved = SUMMARY_SEARCH_CASES.find(example => JSON.stringify(example.args) === JSON.stringify(args))!;
      const observed = args[0] === ' ' ? true : approved.expected;
      const stdout = JSON.stringify({ observed });
      return { observed, durationMs: 0, command: ['controlled-unit-executor'], input: JSON.stringify(args), stdout, stdoutHash: digest(stdout), exitCode: 0 };
    };
    const results = await runRetentionTrials({ args: [' '], expected: false }, SUMMARY_SEARCH_CASES.slice(0, 7), receiver, 3);
    expect(calls).toHaveLength(33);
    for (const trial of results.trials) {
      expect(trial.arms.map(arm => arm.repositoryExecutions)).toEqual([1, 8, 1, 1]);
      expect(trial.arms.map(arm => arm.repeatedExplorationExecutions)).toEqual([0, 7, 0, 0]);
      expect(trial.arms.every(arm => arm.counterexample.observed === true)).toBe(true);
    }
    expect(informedSummaryExample(results.informedSummary)).toEqual({ args: [' '], expected: false });
    expect(() => informedSummaryExample(results.ordinarySummary)).toThrow('does not retain');
  });

  it('refuses to manufacture successful measurements when a failure cannot be reproduced or execution fails', async () => {
    await expect(runRetentionTrials({ args: [' '], expected: false }, [], async args => ({ observed: false, durationMs: 0, command: [], input: JSON.stringify(args), stdout: '{"observed":false}', stdoutHash: digest('{"observed":false}'), exitCode: 0 }))).rejects.toThrow('no defect reproduced');
    await expect(runRetentionTrials({ args: [' '], expected: false }, [], async () => { throw new Error('controlled execution failure'); })).rejects.toThrow('controlled execution failure');
    await expect(runHandoffBenchmark({ allowLocal: false })).rejects.toThrow('--allow-local');
  });

  it('executes the pinned historical public function with archived dependencies, without accepting arbitrary source', async () => {
    await expect(createHistoricalReceiver(Buffer.from('throw new Error("unapproved source")'))).rejects.toThrow('outside the pinned');
    const source = await fs.readFile(path.resolve('benchmarks/public/projects/is-number/index.js'));
    const receiver = await createHistoricalReceiver(source);
    try {
      expect((await receiver.execute([' '])).observed).toBe(true);
      expect((await receiver.execute(['3a'])).observed).toBe(false);
      expect(receiver.dependencyHashes['dependencies/kind-of/index.js']).toMatch(/^[a-f0-9]{64}$/);
    } finally { await receiver.close(); }
  });
});
