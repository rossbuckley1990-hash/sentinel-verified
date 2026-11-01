// Controlled baseline: coercion incorrectly accepts numeric strings.
export function isAdult(age: unknown): boolean { return Number(age) >= 18; }
export function greeting(name: string): string { return `Hello, ${name}!`; }
