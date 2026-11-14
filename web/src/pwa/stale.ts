// A page served by the dev server keeps no service worker, and removes the one
// a production build left on the same address, and its cached shell. Left alone, that worker stays for good
// (the dev server has no worker script to replace it with) and opens its old build whenever the server is down.
// Pure apart from what is passed in, for the tests.

import { CACHE_PREFIX } from "./sw-policy.ts"

/** The slice of ServiceWorkerContainer this needs. */
export interface WorkerRegistrations {
	getRegistrations(): Promise<
		readonly { readonly scope: string; unregister(): Promise<boolean> }[]
	>
}

/** The slice of CacheStorage this needs. */
export interface ShellCaches {
	keys(): Promise<string[]>
	delete(key: string): Promise<boolean>
}

/**
 * Unregisters the workers registered for exactly `scope` (the app's base URL: a worker under another
 * scope of the same origin stays) and deletes the `wavekit-shell-*` caches. Returns how many it unregistered; never rejects.
 */
export async function dropWorkers(
	scope: string,
	workers: WorkerRegistrations,
	caches: ShellCaches | undefined,
): Promise<number> {
	let dropped = 0
	try {
		for (const registration of await workers.getRegistrations())
			if (registration.scope === scope && (await registration.unregister()))
				dropped++
	} catch {
		// storage blocked, or not a secure context: nothing to remove
	}
	try {
		if (caches)
			for (const key of await caches.keys())
				if (key.startsWith(CACHE_PREFIX)) await caches.delete(key)
	} catch {
		// as above
	}
	return dropped
}
