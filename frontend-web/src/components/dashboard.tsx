'use client';

import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';

import { formatXaf } from '@lih/domain';

import { api, restoreTokens, setTokens } from '@/lib/api-client';
import type { Locale, Policy, Profile } from '@/lib/types';

/**
 * The signed-in lawyer's dashboard.
 *
 * Status before detail, per the blueprint's UX rule: what is covered, what is
 * due, what needs attention — before any list.
 *
 * A client component because it reads the session token from sessionStorage,
 * which does not exist on the server. The trade-off is a brief loading state;
 * the alternative would be putting the token in a cookie, which reintroduces
 * CSRF surface the bearer-token design deliberately avoids.
 */
export function Dashboard() {
  const locale = useLocale() as Locale;
  const t = useTranslations('dashboard');
  const tCommon = useTranslations('common');
  const tPolicy = useTranslations('policy.status');
  const tVerify = useTranslations('verification');

  const [profile, setProfile] = useState<Profile | null>(null);
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'signed_out' | 'error'>(
    'loading',
  );

  useEffect(() => {
    restoreTokens();

    (async () => {
      try {
        const me = (await api.me(locale)) as Profile;
        setProfile(me);
        try {
          setPolicies((await api.policies(locale)) as Policy[]);
        } catch {
          // A lawyer with no policies yet is the normal case, not an error.
          setPolicies([]);
        }
        setState('ready');
      } catch {
        setState('signed_out');
      }
    })();
  }, [locale]);

  if (state === 'loading') {
    return (
      <div className="mx-auto max-w-6xl px-6 py-14">
        <p className="text-sm text-ink-soft">{tCommon('loading')}</p>
      </div>
    );
  }

  if (state === 'signed_out') {
    return (
      <div className="mx-auto max-w-md px-6 py-14">
        <div className="rounded border border-line bg-white p-6">
          <h1 className="font-serif text-lg font-semibold text-navy">
            {locale === 'fr' ? 'Session expirée' : 'Session expired'}
          </h1>
          <p className="mt-2 text-sm text-ink-soft">
            {locale === 'fr'
              ? 'Veuillez vous reconnecter pour accéder à votre espace.'
              : 'Please sign in again to reach your account.'}
          </p>
          <a
            href={`/${locale}/login`}
            className="mt-4 inline-block rounded bg-navy px-4 py-2 text-sm font-semibold text-white"
          >
            {tCommon('signIn')}
          </a>
        </div>
      </div>
    );
  }

  const active = policies.filter((p) => p.status === 'active');
  const verified = profile?.verificationStatus === 'verified';

  return (
    <div className="mx-auto max-w-6xl px-6 py-10">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-serif text-2xl text-navy">{t('title')}</h1>
          <p className="mt-1 text-sm text-ink-soft">{profile?.email}</p>
        </div>
        <button
          type="button"
          onClick={() => {
            setTokens(null, null);
            window.location.href = `/${locale}`;
          }}
          className="rounded border border-line px-3 py-1.5 text-sm text-ink-soft hover:bg-white"
        >
          {tCommon('signOut')}
        </button>
      </div>

      {/* Verification is the one thing that gates subscribing, so it is stated
          plainly at the top rather than discovered at checkout. */}
      {!verified && (
        <div className="mt-6 rounded border border-amber-200 bg-amber-50 px-4 py-3">
          <p className="text-sm font-medium text-amber-900">
            {profile?.verificationStatus === 'rejected'
              ? tVerify('rejected')
              : tVerify('pending')}
          </p>
          {profile?.verificationStatus !== 'rejected' && (
            <p className="mt-1 text-sm text-amber-800">{tVerify('pendingDetail')}</p>
          )}
        </div>
      )}

      <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <section className="rounded border border-line bg-white p-5">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-soft">
            {t('coverSummary')}
          </h2>
          <p className="mt-2 font-serif text-2xl text-navy">
            {t('activePolicies', { count: active.length })}
          </p>
        </section>

        <section className="rounded border border-line bg-white p-5">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-soft">
            {tCommon('currency')}
          </h2>
          <p className="mt-2 font-serif text-2xl tabular-nums text-navy">
            {formatXaf(
              active.reduce((sum, p) => sum + BigInt(p.premiumXaf), 0n),
              locale,
            )}
          </p>
          <p className="mt-1 text-xs text-ink-soft">
            {locale === 'fr' ? 'Primes annuelles en cours' : 'Annual premiums in force'}
          </p>
        </section>

        <section className="rounded border border-line bg-white p-5">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-soft">
            {t('quickActions')}
          </h2>
          <div className="mt-3 flex flex-col gap-2">
            <a href={`/${locale}`} className="text-sm font-medium text-navy underline">
              {t('getQuote')}
            </a>
            <a
              href={`/${locale}/dashboard`}
              className="text-sm font-medium text-navy underline"
            >
              {t('fileClaim')}
            </a>
          </div>
        </section>
      </div>

      <section className="mt-10">
        <h2 className="font-serif text-lg text-navy">
          {locale === 'fr' ? 'Mes polices' : 'My policies'}
        </h2>

        {policies.length === 0 ? (
          <p className="mt-3 max-w-xl text-sm text-ink-soft">{t('emptyPolicies')}</p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[560px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-ink-soft">
                  <th className="py-2 pr-4">{locale === 'fr' ? 'N°' : 'Number'}</th>
                  <th className="py-2 pr-4">{locale === 'fr' ? 'Statut' : 'Status'}</th>
                  <th className="py-2 pr-4 text-right">
                    {locale === 'fr' ? 'Prime' : 'Premium'}
                  </th>
                </tr>
              </thead>
              <tbody>
                {policies.map((policy) => (
                  <tr key={policy.id} className="border-b border-line/60">
                    <td className="py-2 pr-4 font-medium text-navy">
                      {policy.policyNumber}
                    </td>
                    <td className="py-2 pr-4">{tPolicy(policy.status)}</td>
                    <td className="py-2 pr-4 text-right tabular-nums">
                      {formatXaf(BigInt(policy.premiumXaf), locale)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
