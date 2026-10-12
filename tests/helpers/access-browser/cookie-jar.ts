/**
 * Browser cookie jar for one profile. Host-only cookies ignore the port, as a
 * browser does, and SameSite is schemeful (scheme + hostname; this suite's
 * hosts are single sites, with no public-suffix list).
 */

const COOKIE_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

export interface CookieReadOptions {
	readonly now?: number
	/** Top-level GET navigation. Ordinary fetch stays false, so Lax is not sent cross-site. */
	readonly topLevelGet?: boolean
}

interface StoredCookie {
	readonly name: string
	readonly value: string
	readonly hostOnly: boolean
	readonly domain: string
	readonly path: string
	readonly secure: boolean
	readonly httpOnly: boolean
	readonly sameSite: "strict" | "lax" | "none"
	readonly expiresAt: number | null
	readonly created: number
}

function defaultPath(pathname: string): string {
	if (!pathname.startsWith("/")) return "/"
	const slash = pathname.lastIndexOf("/")
	if (slash <= 0) return "/"
	return pathname.slice(0, slash)
}

function pathMatches(cookiePath: string, requestPath: string): boolean {
	if (!requestPath.startsWith(cookiePath)) return false
	if (requestPath.length === cookiePath.length || cookiePath.endsWith("/"))
		return true
	return requestPath[cookiePath.length] === "/"
}

function domainMatches(hostname: string, domain: string): boolean {
	const host = hostname.toLowerCase()
	const suffix = domain.toLowerCase()
	if (host === suffix) return true
	if (/^[0-9.]+$/.test(host) || host.includes(":")) return false
	return host.endsWith(`.${suffix}`)
}

/** Browsers compare cookies with ws/wss folded onto http/https. */
function cookieUrl(url: URL): URL {
	if (url.protocol !== "ws:" && url.protocol !== "wss:") return url
	const mapped = new URL(url.href)
	mapped.protocol = url.protocol === "wss:" ? "https:" : "http:"
	return mapped
}

function sameSite(left: URL, right: URL): boolean {
	return (
		left.protocol === right.protocol &&
		left.hostname.toLowerCase() === right.hostname.toLowerCase()
	)
}

function secureContext(url: URL): boolean {
	if (url.protocol === "https:") return true
	const host = url.hostname.toLowerCase()
	return host === "localhost" || host === "127.0.0.1" || host === "::1"
}

function splitSetCookie(
	line: string,
): { name: string; value: string; attributes: string[] } | undefined {
	const segments = line.split(";")
	const first = segments.shift()
	if (first === undefined) return undefined
	const separator = first.indexOf("=")
	if (separator <= 0) return undefined
	const name = first.slice(0, separator).trim()
	const value = first.slice(separator + 1).trim()
	if (!COOKIE_NAME.test(name)) return undefined
	return { name, value, attributes: segments }
}

export class CookieJar {
	#cookies: StoredCookie[] = []
	#created = 0

	/** Apply Set-Cookie lines from a response to `requestUrl`. */
	apply(
		requestUrl: string,
		setCookies: readonly string[],
		now = Date.now(),
	): void {
		const url = new URL(requestUrl)
		for (const line of setCookies) this.#applyOne(url, line, now)
	}

	/**
	 * Cookie request header for a fetch of `requestUrl` initiated by a document
	 * at `documentUrl`. HttpOnly cookies are included. Undefined when none match.
	 */
	cookieHeader(
		requestUrl: string,
		documentUrl: string,
		options: CookieReadOptions = {},
	): string | undefined {
		const now = options.now ?? Date.now()
		const pairs = this.#eligible(
			cookieUrl(new URL(requestUrl)),
			cookieUrl(new URL(documentUrl)),
			now,
			options.topLevelGet === true,
		).map(cookie => `${cookie.name}=${cookie.value}`)
		return pairs.length === 0 ? undefined : pairs.join("; ")
	}

	/** `document.cookie`: matching cookies the page script can read. */
	documentCookie(documentUrl: string, now = Date.now()): string {
		const document = cookieUrl(new URL(documentUrl))
		return this.#eligible(document, document, now, false)
			.filter(cookie => !cookie.httpOnly)
			.map(cookie => `${cookie.name}=${cookie.value}`)
			.join("; ")
	}

	#applyOne(url: URL, line: string, now: number): void {
		const parsed = splitSetCookie(line)
		if (!parsed) return
		let secure = false
		let httpOnly = false
		let sameSiteMode: StoredCookie["sameSite"] = "lax"
		let maxAge: number | undefined
		let expires: number | undefined
		let path: string | undefined
		let domain: string | undefined
		for (const attribute of parsed.attributes) {
			const separator = attribute.indexOf("=")
			const key = (
				separator === -1 ? attribute : attribute.slice(0, separator)
			)
				.trim()
				.toLowerCase()
			const raw =
				separator === -1 ? "" : attribute.slice(separator + 1).trim()
			if (key === "secure") secure = true
			else if (key === "httponly") httpOnly = true
			else if (key === "samesite") {
				const value = raw.toLowerCase()
				if (value === "strict" || value === "lax" || value === "none")
					sameSiteMode = value
			} else if (key === "max-age") {
				if (/^-?\d+$/.test(raw)) maxAge = Number(raw)
			} else if (key === "expires") {
				const parsedExpires = Date.parse(raw)
				if (!Number.isNaN(parsedExpires)) expires = parsedExpires
			} else if (key === "path") {
				if (raw.startsWith("/")) path = raw
			} else if (key === "domain")
				domain = raw.replace(/^\./, "").toLowerCase()
		}
		if (sameSiteMode === "none" && !secure) return
		if (secure && !secureContext(url)) return
		if (domain !== undefined && !domainMatches(url.hostname, domain)) return
		const hostOnly = domain === undefined
		const cookieDomain = domain ?? url.hostname.toLowerCase()
		const cookiePath = path ?? defaultPath(url.pathname)
		const expiresAt =
			maxAge !== undefined
				? maxAge <= 0
					? 0
					: now + maxAge * 1000
				: (expires ?? null)
		if (expiresAt !== null && expiresAt <= now) {
			this.#remove(parsed.name, hostOnly, cookieDomain, cookiePath)
			return
		}
		this.#remove(parsed.name, hostOnly, cookieDomain, cookiePath)
		this.#cookies.push({
			name: parsed.name,
			value: parsed.value,
			hostOnly,
			domain: cookieDomain,
			path: cookiePath,
			secure,
			httpOnly,
			sameSite: sameSiteMode,
			expiresAt,
			created: this.#created++,
		})
	}

	#remove(
		name: string,
		hostOnly: boolean,
		domain: string,
		path: string,
	): void {
		this.#cookies = this.#cookies.filter(
			cookie =>
				cookie.name !== name ||
				cookie.hostOnly !== hostOnly ||
				cookie.domain !== domain ||
				cookie.path !== path,
		)
	}

	#eligible(
		request: URL,
		document: URL,
		now: number,
		topLevelGet: boolean,
	): StoredCookie[] {
		const site = sameSite(request, document)
		const matched = this.#cookies.filter(cookie => {
			if (cookie.expiresAt !== null && cookie.expiresAt <= now) return false
			if (cookie.hostOnly) {
				if (request.hostname.toLowerCase() !== cookie.domain) return false
			} else if (!domainMatches(request.hostname, cookie.domain)) return false
			if (!pathMatches(cookie.path, request.pathname)) return false
			if (cookie.secure && request.protocol !== "https:") return false
			if (cookie.sameSite === "none") return true
			if (site) return true
			return topLevelGet && cookie.sameSite === "lax"
		})
		matched.sort(
			(left, right) =>
				right.path.length - left.path.length || left.created - right.created,
		)
		return matched
	}
}
