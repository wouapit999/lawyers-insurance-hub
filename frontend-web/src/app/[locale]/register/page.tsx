import { getTranslations, setRequestLocale } from 'next-intl/server';

import { RegisterForm } from '@/components/auth-forms';

export default async function RegisterPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('auth');

  return (
    <div className="mx-auto max-w-md px-6 py-14">
      <h1 className="font-serif text-2xl text-navy">{t('register')}</h1>
      <p className="mt-1 text-sm text-ink-soft">{t('subtitle')}</p>
      <div className="mt-8">
        <RegisterForm />
      </div>
    </div>
  );
}
