import { describe, test, expect } from 'vitest';
import { loadCases } from '../src/benchmark.js';

describe('independent benchmark corpus', () => {
  test('contains frozen held-out negatives and positives plus all core attack families', async () => {
    const cases = await loadCases();
    expect(new Set(cases.map(c=>c.id)).size).toBe(cases.length);
    expect(cases.length).toBeGreaterThanOrEqual(12);
    expect(cases.filter(c=>c.split==='held-out').map(c=>c.expected)).toEqual(expect.arrayContaining(['accept','detect']));
    for(const id of ['removed-tests','weakened-assertion','mock-response','hardcoded-sum','coercive-validation','correct-validation-fix','unrelated-output-drift','execution-hang','benign-arithmetic-refactor']) expect(cases.some(c=>c.id===id)).toBe(true);
    for(const c of cases) {
      expect(c.requirement.cases.length).toBeGreaterThan(0);
      expect(c.explanation.length).toBeGreaterThan(20);
    }
  });
});
