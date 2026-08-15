'use client';

import { useLocale } from 'next-intl';

import { routing, usePathname, useRouter, type Locale } from '@/i18n/routing';

/**
 * Language switch.
 *
 * Present in the header on every page, because bilingualism here is not a
 * setting buried in a profile — a lawyer may read a policy in French and
 * forward it to an anglophone colleague, and switching must be one click from
 * wherever they are. Preserves the current path rather than returning to the
 * home page.
 */
export function LocaleSwitch() {
  const locale = useLocale() as Locale;
  const pathname = usePathname();
  const router = useRouter();

  return (
    <div className="flex items-center gap-1 text-sm" role="group" aria-label="Language">
      {routing.locales.map((option, index) => (
        <span key={option} className="flex items-center">
          {index > 0 && <span className="px-1 text-white/40">|</span>}
          <button
            type="button"
            onClick={() => router.replace(pathname, { locale: option })}
            aria-current={option === locale ? 'true' : undefined}
            className={
              option === locale
                ? 'font-semibold text-gold'
                : 'text-white/70 transition-colors hover:text-white'
            }
          >
            {option === 'fr' ? 'Français' : 'English'}
          </button>
        </span>
      ))}
    </div>
  );
}
