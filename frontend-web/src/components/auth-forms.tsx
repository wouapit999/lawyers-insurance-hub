'use client';

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';

import { ApiError, api, setTokens } from '@/lib/api-client';
import { isMfaChallenge, type Locale } from '@/lib/types';

/** Shared field styling — kept here so both forms stay visually identical. */
const field =
  'w-full rounded border border-line bg-white px-3 py-2 text-sm text-ink ' +
  'placeholder:text-ink-soft/60 focus:border-gold focus:outline-none';

const label = 'block text-sm font-medium text-navy';

function ErrorBanner({ error }: { error: ApiError | Error | null }) {
  if (!error) return null;

  const fieldErrors =
    error instanceof ApiError ? Object.values(error.fieldErrors).flat() : [];

  return (
    <div
      role="alert"
      className="rounded border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
    >
      {/* The API already localised this message — showing it directly means
          there is exactly one copy of each error string in the system. */}
      <p className="font-medium">{error.message}</p>
      {fieldErrors.length > 0 && (
        <ul className="mt-2 list-inside list-disc space-y-0.5">
          {fieldErrors.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      )}
      {error instanceof ApiError && error.problem?.requestId && (
        <p className="mt-2 text-xs opacity-70">
          Réf. / Ref: {error.problem.requestId}
        </p>
      )}
    </div>
  );
}

// ===========================================================================

export function LoginForm() {
  const locale = useLocale() as Locale;
  const t = useTranslations('auth');
  const tCommon = useTranslations('common');

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | Error | null>(null);
  const [mfaToken, setMfaToken] = useState<string | null>(null);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    const data = new FormData(event.currentTarget);

    try {
      const result = await api.login(
        String(data.get('email')),
        String(data.get('password')),
        locale,
      );

      // An account with two-factor enabled does not receive tokens yet — it
      // gets a short-lived challenge token to present with the code.
      if (isMfaChallenge(result)) {
        setMfaToken(result.mfaToken);
        return;
      }

      setTokens(result.accessToken, result.refreshToken);
      window.location.href = `/${locale}/dashboard`;
    } catch (caught) {
      setError(caught as ApiError);
    } finally {
      setBusy(false);
    }
  }

  if (mfaToken) {
    return <MfaForm mfaToken={mfaToken} onError={setError} error={error} />;
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <ErrorBanner error={error} />

      <div className="space-y-1">
        <label htmlFor="email" className={label}>
          {tCommon('email')}
        </label>
        <input
          id="email"
          name="email"
          type="email"
          required
          autoComplete="email"
          className={field}
          placeholder="me.ango@cabinet-ango.cm"
        />
      </div>

      <div className="space-y-1">
        <label htmlFor="password" className={label}>
          {tCommon('password')}
        </label>
        <input
          id="password"
          name="password"
          type="password"
          required
          autoComplete="current-password"
          className={field}
        />
      </div>

      <button
        type="submit"
        disabled={busy}
        className="w-full rounded bg-navy px-4 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
      >
        {busy ? tCommon('loading') : tCommon('signIn')}
      </button>

      <p className="text-center text-sm text-ink-soft">
        {t('noAccount')}{' '}
        <a href={`/${locale}/register`} className="font-medium text-navy underline">
          {t('register')}
        </a>
      </p>
    </form>
  );
}

// ===========================================================================

function MfaForm({
  mfaToken,
  error,
  onError,
}: {
  mfaToken: string;
  error: ApiError | Error | null;
  onError: (error: ApiError | Error | null) => void;
}) {
  const locale = useLocale() as Locale;
  const t = useTranslations('auth');
  const tCommon = useTranslations('common');
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    onError(null);

    const code = String(new FormData(event.currentTarget).get('code'));

    try {
      const tokens = await api.verifyMfa(mfaToken, code, locale);
      setTokens(tokens.accessToken, tokens.refreshToken);
      window.location.href = `/${locale}/dashboard`;
    } catch (caught) {
      onError(caught as ApiError);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <ErrorBanner error={error} />
      <div className="space-y-1">
        <label htmlFor="code" className={label}>
          {t('mfaTitle')}
        </label>
        <p className="text-sm text-ink-soft">{t('mfaPrompt')}</p>
        <input
          id="code"
          name="code"
          inputMode="numeric"
          pattern="[0-9]{6}"
          maxLength={6}
          required
          autoComplete="one-time-code"
          className={`${field} text-center text-lg tracking-[0.4em]`}
          placeholder="000000"
        />
      </div>
      <button
        type="submit"
        disabled={busy}
        className="w-full rounded bg-navy px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50"
      >
        {busy ? tCommon('loading') : tCommon('continue')}
      </button>
    </form>
  );
}

// ===========================================================================

export function RegisterForm() {
  const locale = useLocale() as Locale;
  const t = useTranslations('auth');
  const tCommon = useTranslations('common');

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | Error | null>(null);
  const [done, setDone] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    const data = new FormData(event.currentTarget);

    try {
      await api.register(
        {
          email: String(data.get('email')),
          phone: String(data.get('phone')),
          password: String(data.get('password')),
          fullName: String(data.get('fullName')),
          barNumber: String(data.get('barNumber')),
          admittedOn: String(data.get('admittedOn')),
          preferredLang: locale,
        },
        locale,
      );
      setDone(true);
    } catch (caught) {
      setError(caught as ApiError);
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="rounded border border-line bg-white p-6">
        <h2 className="font-serif text-lg font-semibold text-navy">
          {locale === 'fr' ? 'Inscription reçue' : 'Registration received'}
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-ink-soft">
          {locale === 'fr'
            ? "Votre inscription est en cours de vérification auprès du Barreau du Cameroun. Vous pouvez déjà consulter les produits et demander des devis ; la souscription sera possible dès validation."
            : 'Your registration is being verified with the Cameroon Bar Association. You can already browse products and request quotations; subscribing unlocks once the Bar confirms your membership.'}
        </p>
        <a
          href={`/${locale}/login`}
          className="mt-4 inline-block rounded bg-navy px-4 py-2 text-sm font-semibold text-white"
        >
          {tCommon('signIn')}
        </a>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <ErrorBanner error={error} />

      <div className="space-y-1">
        <label htmlFor="fullName" className={label}>
          {locale === 'fr' ? 'Nom complet' : 'Full name'}
        </label>
        <input id="fullName" name="fullName" required maxLength={200} className={field} />
      </div>

      <div className="space-y-1">
        <label htmlFor="barNumber" className={label}>
          {locale === 'fr' ? 'Numéro du Barreau' : 'Bar registration number'}
        </label>
        <input
          id="barNumber"
          name="barNumber"
          required
          className={field}
          placeholder="CM/BAR/2016/0412"
        />
      </div>

      <div className="space-y-1">
        <label htmlFor="admittedOn" className={label}>
          {locale === 'fr' ? 'Date de prestation de serment' : 'Date admitted to the Bar'}
        </label>
        <input id="admittedOn" name="admittedOn" type="date" required className={field} />
      </div>

      <div className="space-y-1">
        <label htmlFor="email" className={label}>
          {tCommon('email')}
        </label>
        <input id="email" name="email" type="email" required className={field} />
      </div>

      <div className="space-y-1">
        <label htmlFor="phone" className={label}>
          {locale === 'fr' ? 'Téléphone' : 'Phone'}
        </label>
        <input
          id="phone"
          name="phone"
          required
          // Matches the API's CM_PHONE_REGEX, so an invalid number is caught
          // in the browser rather than after a round trip.
          pattern="\+237[62][0-9]{8}"
          className={field}
          placeholder="+237670123456"
        />
        <p className="text-xs text-ink-soft">
          {locale === 'fr'
            ? 'Format : +237 suivi de 9 chiffres'
            : 'Format: +237 followed by 9 digits'}
        </p>
      </div>

      <div className="space-y-1">
        <label htmlFor="password" className={label}>
          {tCommon('password')}
        </label>
        <input
          id="password"
          name="password"
          type="password"
          required
          minLength={12}
          autoComplete="new-password"
          className={field}
        />
        <p className="text-xs text-ink-soft">
          {locale === 'fr' ? 'Au moins 12 caractères' : 'At least 12 characters'}
        </p>
      </div>

      <button
        type="submit"
        disabled={busy}
        className="w-full rounded bg-navy px-4 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
      >
        {busy ? tCommon('loading') : t('register')}
      </button>
    </form>
  );
}
