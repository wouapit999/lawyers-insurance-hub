/**
 * Typed API client.
 *
 * Three things it handles that every caller would otherwise repeat:
 *
 *  * **Language.** The active locale goes out on `Accept-Language`, so error
 *    messages, product names and generated documents come back already
 *    translated. The UI never holds a second copy of the API's strings.
 *
 *  * **Token refresh.** A 401 triggers one refresh-and-retry. Concurrent 401s
 *    share a single refresh promise — five parallel requests on a dashboard
 *    must not fire five rotations, which the reuse detection would read as
 *    token theft and respond to by revoking every session.
 *
 *  * **Money.** Amounts arrive as decimal strings and are converted to bigint
 *    at this boundary, so no component ever sees a float franc.
 */

import type { ProblemDetails } from './types';

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000/v1';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly problem: ProblemDetails,
  ) {
    // The API has already localised `detail`; showing it directly is correct.
    super(problem.detail || problem.title);
    this.name = 'ApiError';
  }

  /** Field-level messages for form highlighting, when the API sent them. */
  get fieldErrors(): Record<string, string[]> {
    return this.problem.errors ?? {};
  }
}

interface RequestOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
  locale?: 'en' | 'fr';
  /** Required by the API on payment-mutating endpoints. */
  idempotencyKey?: string;
  /** Internal: prevents an infinite refresh loop. */
  _retried?: boolean;
}

let accessToken: string | null = null;
let refreshToken: string | null = null;
let refreshInFlight: Promise<boolean> | null = null;

export function setTokens(access: string | null, refresh: string | null): void {
  accessToken = access;
  refreshToken = refresh;
  if (typeof window !== 'undefined') {
    if (access && refresh) {
      // sessionStorage rather than localStorage: the token dies with the tab,
      // which limits exposure on the shared machines common in law firms.
      sessionStorage.setItem('lih.tokens', JSON.stringify({ access, refresh }));
    } else {
      sessionStorage.removeItem('lih.tokens');
    }
  }
}

export function restoreTokens(): void {
  if (typeof window === 'undefined') return;
  const raw = sessionStorage.getItem('lih.tokens');
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw) as { access: string; refresh: string };
    accessToken = parsed.access;
    refreshToken = parsed.refresh;
  } catch {
    sessionStorage.removeItem('lih.tokens');
  }
}

async function refreshSession(): Promise<boolean> {
  if (!refreshToken) return false;

  // Collapse concurrent refreshes into one.
  refreshInFlight ??= (async () => {
    try {
      const response = await fetch(`${BASE_URL}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });
      if (!response.ok) {
        setTokens(null, null);
        return false;
      }
      const tokens = (await response.json()) as { accessToken: string; refreshToken: string };
      setTokens(tokens.accessToken, tokens.refreshToken);
      return true;
    } catch {
      return false;
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

export async function apiFetch<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { body, locale = 'fr', idempotencyKey, _retried, ...init } = options;

  const headers = new Headers(init.headers);
  headers.set('Accept-Language', locale);
  if (body !== undefined) headers.set('Content-Type', 'application/json');
  if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`);
  if (idempotencyKey) headers.set('Idempotency-Key', idempotencyKey);

  const response = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (response.status === 401 && !_retried && refreshToken) {
    if (await refreshSession()) {
      return apiFetch<T>(path, { ...options, _retried: true });
    }
  }

  if (response.status === 204) return undefined as T;

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new ApiError(response.status, payload as ProblemDetails);
  }

  return payload as T;
}

/**
 * Amounts cross the wire as strings precisely so they cannot be silently
 * parsed into floats. Convert here and keep bigint everywhere above.
 */
export function toXaf(value: string | number | bigint): bigint {
  return typeof value === 'bigint' ? value : BigInt(String(value).split('.')[0]!);
}

export const api = {
  login: (email: string, password: string, locale: 'en' | 'fr') =>
    apiFetch<{ accessToken: string; refreshToken: string } | { mfaRequired: true; mfaToken: string }>(
      '/auth/login',
      { method: 'POST', body: { email, password, platform: 'web' }, locale },
    ),

  me: (locale: 'en' | 'fr') => apiFetch('/auth/me', { locale }),

  products: (locale: 'en' | 'fr') => apiFetch('/products', { locale }),

  createQuote: (
    payload: { planCode: string; factors: Record<string, unknown>; installments?: number },
    locale: 'en' | 'fr',
  ) => apiFetch('/quotes', { method: 'POST', body: payload, locale }),

  policies: (locale: 'en' | 'fr') => apiFetch('/policies', { locale }),

  subscribe: (quoteId: string, locale: 'en' | 'fr') =>
    apiFetch('/policies', { method: 'POST', body: { quoteId }, locale }),

  payInstallment: (
    installmentId: string,
    payload: { provider: string; msisdn?: string },
    idempotencyKey: string,
    locale: 'en' | 'fr',
  ) =>
    apiFetch(`/installments/${installmentId}/pay`, {
      method: 'POST',
      body: payload,
      idempotencyKey,
      locale,
    }),

  claims: (locale: 'en' | 'fr') => apiFetch('/claims', { locale }),

  claimsQueue: (locale: 'en' | 'fr') => apiFetch('/claims/queue', { locale }),

  fileClaim: (payload: Record<string, unknown>, locale: 'en' | 'fr') =>
    apiFetch('/claims', { method: 'POST', body: payload, locale }),

  barQueue: (locale: 'en' | 'fr') => apiFetch('/bar/verifications', { locale }),

  decideVerification: (
    id: string,
    payload: { decision: 'verified' | 'rejected'; reason?: string },
    locale: 'en' | 'fr',
  ) => apiFetch(`/bar/verifications/${id}/decision`, { method: 'POST', body: payload, locale }),
};
