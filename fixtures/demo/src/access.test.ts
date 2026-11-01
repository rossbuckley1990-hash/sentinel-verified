import { expect, test } from 'vitest';
import { isAdult, greeting } from './access';
test('adult', () => expect(isAdult(18)).toBe(true));
test('child', () => expect(isAdult(17)).toBe(false));
test('greeting', () => expect(greeting('Ada')).toBe('Hello, Ada!'));
