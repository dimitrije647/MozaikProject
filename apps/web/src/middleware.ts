import { NextResponse, type NextRequest } from 'next/server';

const SESSION_COOKIE = 'lp_session';
const PROTECTED = ['/dashboard', '/projects', '/account', '/settings'];
const GUEST_ONLY = ['/login', '/register'];

/**
 * Cheap edge check: is there a session cookie at all? The cookie is only verified by the API;
 * if it is expired or forged, the first /auth/me call returns 401 and the app shell redirects to /login.
 */
export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const hasSession = req.cookies.has(SESSION_COOKIE);

  if (!hasSession && PROTECTED.some((p) => pathname === p || pathname.startsWith(p + '/'))) {
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    url.search = `?next=${encodeURIComponent(pathname)}`;
    return NextResponse.redirect(url);
  }
  if (hasSession && GUEST_ONLY.includes(pathname)) {
    const url = req.nextUrl.clone();
    url.pathname = '/dashboard';
    url.search = '';
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/dashboard/:path*', '/projects/:path*', '/account/:path*', '/settings/:path*', '/login', '/register'],
};
