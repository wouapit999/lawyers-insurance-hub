import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,

  // The web app imports @lih/domain from the monorepo for money formatting and
  // status labels. Next has to transpile it because it ships as TypeScript
  // source rather than a prebuilt bundle.
  transpilePackages: ['@lih/domain'],

  eslint: {
    // Linting runs as its own CI job; duplicating it here only slows the build.
    ignoreDuringBuilds: true,
  },

  images: {
    formats: ['image/avif', 'image/webp'],
  },

  experimental: {
    // Keeps the server bundle from inlining the whole monorepo.
    optimizePackageImports: ['@lih/domain'],
  },
};

export default withNextIntl(nextConfig);
