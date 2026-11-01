import { test, expect } from 'vitest';
import { quote } from './quote.js';
test('whole-dollar tax and totals', () => {
  expect(quote({unitPriceCents:10000,quantity:2,taxBasisPoints:1000})).toEqual({subtotalCents:20000,taxCents:2000,totalCents:22000});
});
test('zero tax preserves the subtotal', () => {
  expect(quote({unitPriceCents:1999,quantity:1,taxBasisPoints:0})).toEqual({subtotalCents:1999,taxCents:0,totalCents:1999});
});
test('invalid quantity is rejected', () => {
  expect(()=>quote({unitPriceCents:1999,quantity:0,taxBasisPoints:825})).toThrow('Invalid checkout input');
});
