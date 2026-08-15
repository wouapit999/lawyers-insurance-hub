import { getTranslations, setRequestLocale } from 'next-intl/server';

import { ProductCatalogue } from '@/components/product-catalogue';
import type { Locale } from '@/i18n/routing';

export default async function HomePage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  const t = await getTranslations('dashboard');
  const tProducts = await getTranslations('products');
  const tAuth = await getTranslations('auth');

  return (
    <>
      <section className="border-b border-line bg-navy">
        <div className="mx-auto max-w-6xl px-6 py-16">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-gold">
            {locale === 'fr'
              ? 'Barreau du Cameroun'
              : 'Cameroon Bar Association'}
          </p>
          <h1 className="mt-3 max-w-2xl font-serif text-4xl leading-tight text-white sm:text-5xl">
            {locale === 'fr'
              ? 'Vos assurances, souscrites et gérées en ligne'
              : 'Your insurance, subscribed and managed online'}
          </h1>
          <p className="mt-4 max-w-xl text-base leading-relaxed text-white/70">
            {locale === 'fr'
              ? "Réservé aux avocats inscrits au Barreau du Cameroun. Paiement par Orange Money et MTN Mobile Money, en francs CFA."
              : 'For advocates registered with the Cameroon Bar Association. Pay with Orange Money and MTN Mobile Money, in CFA francs.'}
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <a
              href={`/${locale}/register`}
              className="rounded bg-gold px-5 py-2.5 text-sm font-semibold text-navy transition-opacity hover:opacity-90"
            >
              {tAuth('register')}
            </a>
            <a
              href={`/${locale}/login`}
              className="rounded border border-white/30 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-white/10"
            >
              {tAuth('title')}
            </a>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-6 py-14">
        <h2 className="font-serif text-2xl text-navy">{tProducts('title')}</h2>
        <p className="mt-2 max-w-2xl text-sm text-ink-soft">
          {locale === 'fr'
            ? "Les produits et leurs tarifs viennent directement de l'API — noms et descriptions dans votre langue."
            : 'Products and pricing come straight from the API — names and descriptions in your language.'}
        </p>

        <div className="mt-8">
          <ProductCatalogue locale={locale as Locale} />
        </div>
      </section>
    </>
  );
}
