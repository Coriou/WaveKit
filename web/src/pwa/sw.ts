// The app's service worker, built to /sw.js by build/pwa-plugin.ts (production builds only). It keeps this
// build's shell (HTML, scripts, styles, fonts, icons) so the app opens instantly and still opens when the
// receiver is unreachable; the core's REST API, WebSocket and audio always go to the network (sw-policy.ts).
// A new build waits until the page asks it to take over (the "WaveKit was updated" toast), so a running page
// never loads a mix of two builds.
//
// No imports besides sw-policy.ts: the worker is a classic script, it must not share a chunk with the app.

import { cacheName, routeRequest, staleCaches } from "./sw-policy.ts"

// Replaced in the built file by the plugin: the build's files (relative to the scope) and its version.
const PRECACHE: readonly string[] = JSON.parse("__WK_PRECACHE__") as string[]
const VERSION = "__WK_VERSION__"

// The worker globals the dom lib does not declare, kept to what this file touches.
interface ExtendableEvent extends Event {
	waitUntil(p: Promise<unknown>): void
}
interface FetchEvent extends ExtendableEvent {
	readonly request: Request
	respondWith(r: Promise<Response>): void
}
interface WorkerScope {
	readonly registration: { readonly scope: string }
	readonly clients: { claim(): Promise<void> }
	skipWaiting(): Promise<void>
	addEventListener(
		type: "install" | "activate",
		fn: (e: ExtendableEvent) => void,
	): void
	addEventListener(type: "fetch", fn: (e: FetchEvent) => void): void
	addEventListener(type: "message", fn: (e: MessageEvent) => void): void
}
const worker = self as unknown as WorkerScope

const scope = worker.registration.scope
const urls = PRECACHE.map(p => new URL(p, scope).href)
const precached = new Set(urls)
const shellUrl = new URL("index.html", scope).href
const CACHE = cacheName(VERSION)

worker.addEventListener("install", e => {
	e.waitUntil(caches.open(CACHE).then(c => c.addAll(urls)))
})

worker.addEventListener("activate", e => {
	e.waitUntil(
		caches
			.keys()
			.then(keys =>
				Promise.all(staleCaches(keys, VERSION).map(k => caches.delete(k))),
			)
			.then(() => worker.clients.claim()),
	)
})

worker.addEventListener("message", e => {
	const data: unknown = e.data
	if (
		typeof data === "object" &&
		data !== null &&
		(data as { type?: unknown }).type === "skip-waiting"
	)
		void worker.skipWaiting()
})

async function fromCache(key: string, request: Request): Promise<Response> {
	const hit = await caches.match(key, { cacheName: CACHE })
	return hit ?? fetch(request)
}

async function navigate(request: Request): Promise<Response> {
	try {
		return await fetch(request)
	} catch (error) {
		const shell = await caches.match(shellUrl, { cacheName: CACHE })
		if (shell) return shell
		throw error
	}
}

worker.addEventListener("fetch", e => {
	const req = e.request
	const route = routeRequest(
		{
			url: req.url,
			method: req.method,
			mode: req.mode,
			range: req.headers.get("range"),
		},
		scope,
		precached,
	)
	if (route.kind === "navigate") e.respondWith(navigate(req))
	else if (route.kind === "shell") e.respondWith(fromCache(route.key, req))
})
