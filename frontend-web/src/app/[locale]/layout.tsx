import type { Metadata } from 'next';
import { NextIntlClientProvider } from 'next-intl';
import { getMessages, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';

import { LocaleSwitch } from '@/components/locale-switch';
import { routing, type Locale } from '@/i18n/routing';

import '../globals.css';

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export const metadata: Metadata = {
  title: {
    default: 'Lawyers Insurance Hub',
    template: '%s · Lawyers Insurance Hub',
  },
  description:
    "Assurance dédiée aux avocats inscrits au Barreau du Cameroun. " +
    'Insurance for advocates registered with the Cameroon Bar Association.',
  robots: { index: false, follow: false }, // pre-launch
};

export default async function LocaleLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;

  if (!routing.locales.includes(locale as Locale)) notFound();

  // Required for static rendering of a localised route.
  setRequestLocale(locale);
  const messages = await getMessages();

  return (
    <html lang={locale} suppressHydrationWarning>
      <body className="min-h-screen bg-paper text-ink antialiased">
        <NextIntlClientProvider messages={messages}>
          <div className="flex min-h-screen flex-col">
            <header className="border-b border-line bg-navy">
              <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
                <a href={`/${locale}`} className="flex items-baseline gap-2">
                  <span className="font-serif text-xl font-semibold text-white">
                    Lawyers Insurance Hub
                  </span>
                </a>
                <LocaleSwitch />
              </div>
            </header>

            <main className="flex-1">{children}</main>

            <footer className="border-t border-line bg-white">
              <div className="mx-auto max-w-6xl px-6 py-6 text-sm text-ink-soft">
                <p>
                  © {new Date().getFullYear()} Bouquet Innovation — Roland Wouapit
                </p>
                <p className="mt-1 text-xs">
                  {locale === 'fr'
                    ? 'Réservé aux avocats inscrits au Barreau du Cameroun.'
                    : 'For advocates registered with the Cameroon Bar Association.'}
                </p>
              </div>
            </footer>
          </div>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
