import { NextResponse } from 'next/server';

/**
 * Liveness for the web app itself, reachable at /healthz via the rewrite in
 * vercel.json. Deliberately does NOT check the API — this answers "is the
 * frontend serving", and conflating the two would report the web app as down
 * during an unrelated backend deploy.
 */
export const dynamic = 'force-dynamic';

export function GET() {
  return NextResponse.json({
    status: 'ok',
    service: 'lih-web',
    time: new Date().toISOString(),
  });
}
