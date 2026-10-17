// What the service worker does with a request: pure, so it tests in node. The worker only ever answers for the
// app shell (the build's own files, and navigations to the app); the core's API, its WebSocket and its live
// audio pass straight through to the network and are never cached.

/** Paths the core owns, under the origin root and under the app's scope when it lives below it. */
const CORE_PREFIXES = ["api", "ws", "health"] as const

export type SwRoute =
	/** Not ours: the browser fetches it as if there were no service worker. */
	| { readonly kind: "pass" }
	/** A page load: the network first, the cached shell when the network fails (offline, receiver down). */
	| { readonly kind: "navigate" }
	/** A file of this build: the cache first (its name carries its hash), the network as a fallback. */
	| { readonly kind: "shell"; readonly key: string }

export interface SwRequest {
	readonly url: string
	readonly method: string
	readonly mode: string
	/** The Range header (media seeks are never answered from the cache). */
	readonly range: string | null
}

const isCorePath = (path: string): boolean =>
	CORE_PREFIXES.some(
		p => path === p || path.startsWith(`${p}/`) || path.startsWith(`${p}?`),
	)

/**
 * Routes one request. `scope` is the registration's scope URL (ends with "/"); `precache` holds the build's
 * files as absolute URLs (no search, no hash).
 */
export function routeRequest(
	req: SwRequest,
	scope: string,
	precache: ReadonlySet<string>,
): SwRoute {
	if (req.method !== "GET" || req.range !== null) return { kind: "pass" }
	let url: URL
	let base: URL
	try {
		url = new URL(req.url)
		base = new URL(scope)
	} catch {
		return { kind: "pass" }
	}
	if (url.origin !== base.origin) return { kind: "pass" }
	const fromRoot = url.pathname.replace(/^\//, "")
	if (isCorePath(fromRoot)) return { kind: "pass" }
	if (!url.pathname.startsWith(base.pathname)) return { kind: "pass" }
	if (isCorePath(url.pathname.slice(base.pathname.length)))
		return { kind: "pass" }
	if (req.mode === "navigate") return { kind: "navigate" }
	const key = `${url.origin}${url.pathname}`
	return precache.has(key) ? { kind: "shell", key } : { kind: "pass" }
}

/** The cache name for a build; older `wavekit-shell-*` caches are dropped when a new worker takes over. */
export const CACHE_PREFIX = "wavekit-shell-"
export const cacheName = (version: string): string =>
	`${CACHE_PREFIX}${version}`

/** The caches a worker of `version` deletes on activation: other builds' shells, nothing else. */
export function staleCaches(
	keys: readonly string[],
	version: string,
): string[] {
	return keys.filter(
		k => k.startsWith(CACHE_PREFIX) && k !== cacheName(version),
	)
}

/** Whether a build file goes into the precache: everything the shell loads, not source maps or the worker itself. */
export function isPrecached(fileName: string): boolean {
	return !fileName.endsWith(".map") && fileName !== "sw.js"
}
