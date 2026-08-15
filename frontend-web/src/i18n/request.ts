import { getRequestConfig } from 'next-intl/server';

import { routing, type Locale } from './routing';

/**
 * Loads the message catalogue for the requested locale.
 *
 * The catalogues in messages/ are the single source of UI copy. API error
 * messages are NOT duplicated here — the API returns them already translated,
 * so there is exactly one place each string lives.
 */
export default getRequestConfig(async ({ requestLocale }) => {
  const requested = await requestLocale;
  const locale: Locale = routing.locales.includes(requested as Locale)
    ? (requested as Locale)
    : routing.defaultLocale;

  return {
    locale,
    messages: (await import(`../../messages/${locale}.json`)).default,
    // Cameroon is UTC+1. Pinning it means a renewal date renders the same
    // whether the page was built on a Vercel machine in Washington or read on
    // a handset in Douala.
    timeZone: 'Africa/Douala',
  };
});
