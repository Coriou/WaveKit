// What the dev server answers for /sw.js. A production build registers a service worker there; the dev server
// has none, so without this the old worker stays registered for good (its update check gets the dev server's
// HTML fallback, which a browser refuses as a script) and opens its cached build whenever the server is down.
// This script replaces it, deletes the shell caches, unregisters itself and reloads the pages the old worker
// held, which then load from the dev server with no worker at all. It handles no fetch.

import { CACHE_PREFIX } from "../src/pwa/sw-policy.ts"

export const KILL_SWITCH_WORKER = `// WaveKit dev server: no service worker here. Removes one left by a production build.
self.addEventListener("install", () => {
	void self.skipWaiting()
})
self.addEventListener("activate", event => {
	event.waitUntil(
		(async () => {
			const keys = await caches.keys()
			await Promise.all(
				keys
					.filter(key => key.startsWith(${JSON.stringify(CACHE_PREFIX)}))
					.map(key => caches.delete(key)),
			)
			await self.registration.unregister()
			const pages = await self.clients.matchAll({ type: "window" })
			await Promise.all(
				pages.map(page => page.navigate(page.url).catch(() => null)),
			)
		})(),
	)
})
`
