import { defaultCache } from "@serwist/next/worker";
import type { PrecacheEntry, RuntimeCaching, SerwistGlobalConfig } from "serwist";
import { NetworkOnly, Serwist } from "serwist";

declare global {
  interface WorkerGlobalScope extends SerwistGlobalConfig {
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
  }
}

declare const self: ServiceWorkerGlobalScope;

// Full-page navigations (`request.destination === "document"`) under
// /dashboard and /cultivation-display must never be served from cache —
// `defaultCache`'s Next.js document rule caches these with no notion of
// session, so a logged-out (or different) user hard-navigating/reloading on
// the same device could otherwise be served another user's cached
// authenticated page. Force NetworkOnly for document requests under these
// prefixes and put this rule FIRST — Serwist uses the first matching route,
// so it must run before `defaultCache`'s broader document matcher gets a
// chance.
//
// Deliberately scoped to `destination === "document"` only — NOT to RSC
// fetches (client-side sidebar/tab navigations, which have destination ""
// and an `RSC: 1` request header, matched separately by `defaultCache`).
// An earlier version of this rule matched on pathname alone, which also
// intercepted RSC requests and forced them onto the network; on a dead
// network `PrecacheFallbackPlugin`'s only fallback entry matches
// `destination === "document"`, so RSC fetches had no fallback and
// rejected outright — every sidebar tap hung then errored, with no
// offline UI, instead of falling back to the last-cached page as it did
// before this rule existed. Scoping to documents restores that offline
// read behavior for RSC payloads while still guaranteeing every full
// navigation/reload under these prefixes is session-fresh.
//
// Cross-user leakage on a shared kiosk is additionally covered on the
// logout path: `lib/auth-context.tsx`'s `logout()` purges the
// authenticated runtime caches (`pages`, `pages-rsc`,
// `pages-rsc-prefetch`) before the next PIN user can log in, so there is
// no stale cached RSC payload left for a NetworkFirst fallback to serve
// even in the rare case the next user's own first fetch happens to be
// offline.
const authenticatedDocumentsNetworkOnly: RuntimeCaching[] = [
  {
    matcher({ url, request }) {
      return (
        request.destination === "document" &&
        (url.pathname.startsWith("/dashboard") || url.pathname.startsWith("/cultivation-display"))
      );
    },
    handler: new NetworkOnly(),
  },
];

const serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST,
  skipWaiting: true,
  clientsClaim: true,
  navigationPreload: true,
  runtimeCaching: [...authenticatedDocumentsNetworkOnly, ...defaultCache],
  fallbacks: {
    entries: [
      {
        url: "/~offline",
        matcher({ request }) {
          return request.destination === "document";
        },
      },
    ],
  },
});

serwist.addEventListeners();
