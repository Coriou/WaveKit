// Same-origin path for the core's live audio in development. Pure (used by the page and vite.config.ts).
//
// The core serves live audio on its own port (status.httpUrl, e.g. http://localhost:8081/stream). The page
// reads it with fetch(), so a cross-origin stream needs Access-Control-Allow-Origin, which a legacy core's
// audio server does not send (src/core/audio-stream-server.ts streamHeaders): the browser blocks it. The
// Vite dev server therefore proxies `/__wk-audio/<port>/<path>` to <port> on the core's API host, and the
// page rewrites cross-origin audio URLs to that path. It also helps when the core advertises `localhost`
// but runs on another machine: the proxy goes to the API host, not to the browser's localhost.

/** Path prefix the Vite dev server proxies to the core's audio port. */
export const AUDIO_PROXY_PREFIX = "/__wk-audio"

/**
 * `url` through the dev proxy when it is cross-origin to the page; unchanged when same-origin,
 * not http(s), or unparsable. `prefix` null means no proxy (production build): unchanged.
 */
export function proxiedAudioUrl(
	url: string,
	pageUrl: string,
	prefix: string | null,
): string {
	if (prefix === null) return url
	let target: URL
	let page: URL
	try {
		target = new URL(url, pageUrl)
		page = new URL(pageUrl)
	} catch {
		return url
	}
	if (target.protocol !== "http:" && target.protocol !== "https:") return url
	if (target.origin === page.origin) return target.toString()
	const port = target.port || (target.protocol === "https:" ? "443" : "80")
	return `${page.origin}${prefix}/${port}${target.pathname}${target.search}`
}

/** A request path under the prefix, split into the target port and the upstream path; null otherwise. */
export function parseAudioProxyPath(
	path: string,
	prefix: string = AUDIO_PROXY_PREFIX,
): { port: number; path: string } | null {
	if (!path.startsWith(`${prefix}/`)) return null
	const rest = path.slice(prefix.length + 1)
	const match = /^(\d{1,5})(\/[^#]*)?$/.exec(rest)
	if (!match) return null
	const port = Number(match[1])
	if (!Number.isInteger(port) || port < 1 || port > 65_535) return null
	return { port, path: match[2] ?? "/" }
}
