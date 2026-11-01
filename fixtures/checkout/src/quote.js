/** Controlled demonstration: this implementation intentionally rounds tax incorrectly. */
export function quote({ unitPriceCents, quantity, taxBasisPoints }) {
  if (!Number.isSafeInteger(unitPriceCents) || unitPriceCents < 0 || unitPriceCents > 1000000 ||
      !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 100 ||
      !Number.isSafeInteger(taxBasisPoints) || taxBasisPoints < 0 || taxBasisPoints > 10000) {
    throw new TypeError('Invalid checkout input');
  }
  const subtotalCents = unitPriceCents * quantity;
  const taxCents = Math.floor(subtotalCents * taxBasisPoints / 10000);
  return { subtotalCents, taxCents, totalCents: subtotalCents + taxCents };
}
