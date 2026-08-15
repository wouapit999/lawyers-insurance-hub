import { formatXaf } from '@lih/domain';

import type { Locale } from '@/i18n/routing';

interface Plan {
  code: string;
  name: string;
  basePremiumXaf: string;
  installmentOptions: number[];
}

interface Product {
  code: string;
  name: string;
  description: string | null;
  plans: Plan[];
}

/**
 * The product catalogue, read from the API.
 *
 * Server component: the fetch happens on the server, so the catalogue is in
 * the HTML on first paint. That matters on a Cameroonian mobile connection,
 * where a client-side fetch would leave a lawyer looking at a spinner for a
 * second or more.
 *
 * The API returns names and descriptions already in the requested language —
 * this component sends Accept-Language and renders what comes back, rather
 * than keeping a second copy of the catalogue's vocabulary.
 */
export async function ProductCatalogue({ locale }: { locale: Locale }) {
  const base = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000/v1';

  let products: Product[] = [];
  let unreachable = false;

  try {
    const response = await fetch(`${base}/products`, {
      headers: { 'Accept-Language': locale },
      // The catalogue changes when underwriting publishes a new plan, which is
      // rare. Five minutes keeps the page fast without serving a stale price
      // for long.
      next: { revalidate: 300 },
    });
    if (!response.ok) throw new Error(String(response.status));
    products = (await response.json()) as Product[];
  } catch {
    unreachable = true;
  }

  if (unreachable) {
    return (
      <div className="rounded border border-line bg-white p-6">
        <p className="text-sm font-semibold text-navy">
          {locale === 'fr'
            ? 'Catalogue momentanément indisponible'
            : 'Catalogue temporarily unavailable'}
        </p>
        <p className="mt-1 text-sm text-ink-soft">
          {locale === 'fr'
            ? "Le service est en cours de démarrage. Réessayez dans un instant."
            : 'The service is starting up. Try again in a moment.'}
        </p>
      </div>
    );
  }

  if (products.length === 0) {
    return (
      <p className="text-sm text-ink-soft">
        {locale === 'fr' ? 'Aucun produit publié.' : 'No products published yet.'}
      </p>
    );
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {products.map((product) => (
        <article
          key={product.code}
          className="flex flex-col rounded border border-line bg-white p-5"
        >
          <h3 className="font-serif text-lg font-semibold text-navy">{product.name}</h3>
          {product.description && (
            <p className="mt-2 flex-1 text-sm leading-relaxed text-ink-soft">
              {product.description}
            </p>
          )}

          <ul className="mt-4 space-y-2 border-t border-line pt-4">
            {product.plans.map((plan) => (
              <li key={plan.code} className="flex items-baseline justify-between gap-3">
                <span className="text-sm text-ink">{plan.name}</span>
                <span className="whitespace-nowrap text-sm font-semibold tabular-nums text-navy">
                  {/* Formatted by the shared domain package, so the amount is
                      character-identical to the PDF certificate and the app. */}
                  {formatXaf(BigInt(plan.basePremiumXaf), locale)}
                </span>
              </li>
            ))}
          </ul>
        </article>
      ))}
    </div>
  );
}
