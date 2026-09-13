import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

/**
 * Clerk authentication middleware.
 *
 * Authenticated (private-library) pages are protected here: signed-out
 * visitors are redirected to the Clerk sign-in experience (/sign-in).
 * Public routes - the logged-out landing page (/ renders it for visitors
 * without a session), /sign-in, /sign-up, legacy /login + /register
 * compat redirects, and the public video/creator pages (which render
 * their own signed-out states) - stay reachable. API routes enforce user
 * ownership server-side via getCurrentUser (Clerk-first) and are left to
 * their own 401/404 handling so public playback, thumbnails, and
 * downloads keep working.
 */
const isProtectedRoute = createRouteMatcher([
  "/library(.*)",
  "/watchlist(.*)",
  "/search(.*)",
  "/account(.*)",
]);

export default clerkMiddleware(async (auth, req) => {
  if (isProtectedRoute(req)) {
    await auth.protect();
  }
});

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
