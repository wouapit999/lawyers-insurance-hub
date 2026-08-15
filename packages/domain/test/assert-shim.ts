/**
 * Assertion helpers shared by the domain test suites.
 *
 * These wrap Jest's matchers in node:assert-style names. The point is
 * readability at the call site: `expectEqual(premium, 230000n)` reads as one
 * clause, where `expect(premium).toBe(230000n)` splits the subject from the
 * expectation. Registered as globals by jest.config.js so the suites stay
 * free of boilerplate imports.
 */

type Ctor = new (...args: never[]) => Error;

function expectEqual(actual: unknown, expected: unknown, message?: string): void {
  if (message) {
    expect(actual).toStrictEqual(expected);
  } else {
    expect(actual).toStrictEqual(expected);
  }
}

function expectDeepEqual(actual: unknown, expected: unknown): void {
  expect(actual).toStrictEqual(expected);
}

function expectMatch(actual: string, pattern: RegExp): void {
  expect(actual).toMatch(pattern);
}

function expectOk(value: unknown, message?: string): void {
  if (!value) {
    throw new Error(message ?? `Expected a truthy value, received ${String(value)}`);
  }
}

function expectThrows(fn: () => unknown, expected?: Ctor | RegExp, _message?: string): void {
  if (expected === undefined) {
    expect(fn).toThrow();
  } else if (expected instanceof RegExp) {
    expect(fn).toThrow(expected);
  } else {
    expect(fn).toThrow(expected);
  }
}

const globals = globalThis as Record<string, unknown>;
globals.expectEqual = expectEqual;
globals.expectDeepEqual = expectDeepEqual;
globals.expectMatch = expectMatch;
globals.expectOk = expectOk;
globals.expectThrows = expectThrows;

export {};
