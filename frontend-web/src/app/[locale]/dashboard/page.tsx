import { setRequestLocale } from 'next-intl/server';

import { Dashboard } from '@/components/dashboard';

// The dashboard reads the signed-in user's own data from the browser's
// session, so it cannot be prerendered.
export const dynamic = 'force-dynamic';

export default async function DashboardPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  return <Dashboard />;
}
