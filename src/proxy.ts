import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';
import { type NextFetchEvent, type NextRequest, NextResponse } from 'next/server';

const needsSession = createRouteMatcher(['/invoices(.*)', '/reports(.*)', '/suppliers(.*)', '/evals(.*)']);
const protect = clerkMiddleware(async (auth, request) => {
  if (!needsSession(request)) return;
  const session = await auth({ treatPendingAsSignedOut: false });
  if (!session.userId) return session.redirectToSignIn();
}, { signInUrl: '/sign-in', signUpUrl: '/sign-up' });

export function proxy(request: NextRequest, event: NextFetchEvent) {
  if (process.env.NEXT_PUBLIC_API_MODE !== 'live' || !process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY || !process.env.CLERK_SECRET_KEY) {
    return NextResponse.next();
  }
  return protect(request, event);
}

export const config = { matcher: ['/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ico|ttf|woff2?)).*)'] };
