import { defineRouting } from 'next-intl/routing';
import { createNavigation } from 'next-intl/navigation';

/**
 * Locale routing.
 *
 * French is the default and is NOT hidden from the URL. Cameroon is
 * officially bilingual and the Bar operates in both languages, so neither
 * locale is the "special" one — /fr and /en are equally first-class, and a
 * link a lawyer shares carries the language they were reading in.
 */
export const routing = defineRouting({
  locales: ['fr', 'en'],
  defaultLocale: 'fr',
  localePrefix: 'always',
});

export type Locale = (typeof routing.locales)[number];

export const { Link, redirect, usePathname, useRouter, getPathname } =
  createNavigation(routing);
