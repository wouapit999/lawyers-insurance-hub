/** Type declarations for the assertion shim registered in test/assert-shim.ts. */
declare function expectEqual(actual: unknown, expected: unknown, message?: string): void;
declare function expectDeepEqual(actual: unknown, expected: unknown): void;
declare function expectMatch(actual: string, pattern: RegExp): void;
declare function expectOk(value: unknown, message?: string): void;
declare function expectThrows(
  fn: () => unknown,
  expected?: (new (...args: never[]) => Error) | RegExp,
  message?: string,
): void;
