/**
 * WG6 lane U (req 5.2-5.4): fetches one band-plan file by https URL under the SSRF rules.
 * Lives outside src/core/bandplans, which stays I/O-free. One DNS resolution, every address
 * checked, a pinned connection to the first checked address, no redirect, no proxy, no
 * pooling, a capped body and one deadline over the whole fetch. One fetch in flight per
 * fetcher instance. Errors and logs never carry body bytes or the query string.
 */
import { lookup as dnsLookup } from "node:dns/promises"
import type { IncomingMessage, ClientRequest } from "node:http"
import { request as httpsRequest } from "node:https"
import type { RequestOptions } from "node:https"
import { isIP } from "node:net"
import type { LookupFunction } from "node:net"
import {
	BANDPLANS_URL_LIMITS,
	BANDPLAN_URL_CONTENT_TYPES,
	bandPlanImportUrlSchema,
	type BandPlansErrorCode,
} from "@wavekit/api-types"
import {
	BandPlansError,
	type BandPlanUrlFetchResult,
	type BandPlanUrlFetcher,
} from "../bandplans/contract.js"
import type { Logger } from "../../utils/logger.js"
import { createComponentLogger } from "../../utils/logger.js"
import { defaultAddressPolicy, type AddressPolicy } from "./address-policy.js"

/** One resolved address as `dns.lookup(host, { all: true })` returns it. */
export interface ResolvedAddress {
	readonly address: string
	readonly family: number
}
export type BandPlanUrlResolver = (
	host: string,
) => Promise<readonly ResolvedAddress[]>
/** Seam with the shape of `https.request(options, onResponse)`. */
export type BandPlanUrlRequest = (
	options: RequestOptions,
	onResponse: (response: IncomingMessage) => void,
) => ClientRequest
export interface BandPlanUrlTimers {
	setTimeout(callback: () => void, ms: number): unknown
	clearTimeout(handle: unknown): void
}
export interface BandPlanUrlFetcherOptions {
	/** Single resolution; default `dns.lookup(host, { all: true, verbatim: true })`. */
	readonly resolve?: BandPlanUrlResolver
	/** Default `https.request`. */
	readonly request?: BandPlanUrlRequest
	/** Test hook only; production uses the default refused-block policy. */
	readonly addressPolicy?: AddressPolicy
	/** Default the global timers (fake timers in tests). */
	readonly timers?: BandPlanUrlTimers
	/** Default BANDPLANS_URL_LIMITS.totalTimeoutMs. */
	readonly timeoutMs?: number
	/** Default BANDPLANS_URL_LIMITS.responseBytes. */
	readonly maxBytes?: number
	readonly userAgent?: string
	readonly logger?: Logger
}

const defaultResolve: BandPlanUrlResolver = host =>
	dnsLookup(host, { all: true, verbatim: true })

const defaultTimers: BandPlanUrlTimers = {
	setTimeout: (callback, ms) => setTimeout(callback, ms),
	clearTimeout: handle => {
		clearTimeout(handle as ReturnType<typeof setTimeout>)
	},
}

const ACCEPT = BANDPLAN_URL_CONTENT_TYPES.join(", ")

function fail(code: BandPlansErrorCode): BandPlansError {
	return new BandPlansError(code)
}

/**
 * Rule 1: the checked URL or a refusal. Beyond the schema, the raw text is checked for an
 * empty fragment, a default port written out, credentials and control or space characters,
 * which WHATWG parsing would otherwise silently normalise away.
 */
export function checkBandPlanUrl(raw: string, hosts: readonly string[]): URL {
	if (
		typeof raw !== "string" ||
		!bandPlanImportUrlSchema.safeParse(raw).success
	)
		throw fail("BANDPLANS_URL_REFUSED")
	if (/[\u0000- \u007f\\#]/.test(raw)) throw fail("BANDPLANS_URL_REFUSED")
	const schemeEnd = raw.indexOf("//")
	if (schemeEnd < 0 || raw.slice(0, schemeEnd).toLowerCase() !== "https:")
		throw fail("BANDPLANS_URL_REFUSED")
	const rest = raw.slice(schemeEnd + 2)
	const authorityEnd = rest.search(/[/?]/)
	const authority = authorityEnd < 0 ? rest : rest.slice(0, authorityEnd)
	if (authority.includes(":") || authority.includes("@") || authority === "")
		throw fail("BANDPLANS_URL_REFUSED")
	let url: URL
	try {
		url = new URL(raw)
	} catch {
		throw fail("BANDPLANS_URL_REFUSED")
	}
	const host = url.hostname.toLowerCase()
	if (
		url.protocol !== "https:" ||
		url.username !== "" ||
		url.password !== "" ||
		url.port !== "" ||
		url.hash !== "" ||
		host === "" ||
		host.endsWith(".") ||
		host.startsWith("[") ||
		isIP(host) !== 0 ||
		authority.toLowerCase() !== host ||
		!hosts.some(allowed => allowed.toLowerCase() === host)
	)
		throw fail("BANDPLANS_URL_REFUSED")
	return url
}

function pinnedLookup(address: string, family: number): LookupFunction {
	return (_hostname, options, callback) => {
		if (options.all) callback(null, [{ address, family }])
		else callback(null, address, family)
	}
}

function headerValue(value: string | string[] | undefined): string | undefined {
	return Array.isArray(value) ? value.join(",") : value
}

/** The frozen BandPlanUrlFetcher with the WG6 SSRF and resource rules. */
export function createBandPlanUrlFetcher(
	options: BandPlanUrlFetcherOptions = {},
): BandPlanUrlFetcher {
	const resolve = options.resolve ?? defaultResolve
	const request = options.request ?? httpsRequest
	const allowed = options.addressPolicy ?? defaultAddressPolicy
	const timers = options.timers ?? defaultTimers
	const timeoutMs = options.timeoutMs ?? BANDPLANS_URL_LIMITS.totalTimeoutMs
	const maxBytes = options.maxBytes ?? BANDPLANS_URL_LIMITS.responseBytes
	const userAgent = options.userAgent ?? "WaveKit"
	const log = options.logger
		? createComponentLogger(options.logger, "BandPlanUrlFetcher")
		: undefined
	let inFlight = false

	const run = (url: URL): Promise<BandPlanUrlFetchResult> =>
		new Promise<BandPlanUrlFetchResult>((resolvePromise, rejectPromise) => {
			const host = url.hostname.toLowerCase()
			let done = false
			let req: ClientRequest | undefined
			let res: IncomingMessage | undefined
			const finish = (
				error: BandPlansError | undefined,
				value?: BandPlanUrlFetchResult,
			): void => {
				if (done) return
				done = true
				timers.clearTimeout(timer)
				try {
					res?.destroy()
				} catch {
					/* already gone */
				}
				try {
					req?.destroy()
				} catch {
					/* already gone */
				}
				if (error) {
					log?.warn(
						{ host, path: url.pathname, code: error.code },
						"band-plan URL fetch failed",
					)
					rejectPromise(error)
				} else if (value) resolvePromise(value)
			}
			const timer = timers.setTimeout(() => {
				finish(fail("BANDPLANS_URL_TIMEOUT"))
			}, timeoutMs)

			const onResponse = (response: IncomingMessage): void => {
				res = response
				if (done) return
				response.on("error", () => {
					finish(fail("BANDPLANS_URL_FETCH_FAILED"))
				})
				if (response.statusCode !== 200) {
					finish(fail("BANDPLANS_URL_FETCH_FAILED"))
					return
				}
				const encoding = headerValue(response.headers["content-encoding"])
				if (
					encoding !== undefined &&
					encoding.trim().toLowerCase() !== "identity"
				) {
					finish(fail("BANDPLANS_URL_REFUSED"))
					return
				}
				const rawType = headerValue(response.headers["content-type"])
				const mediaType =
					rawType === undefined
						? null
						: (rawType.split(";")[0] ?? "").trim().toLowerCase()
				if (
					mediaType === null ||
					!BANDPLAN_URL_CONTENT_TYPES.includes(mediaType)
				) {
					finish(fail("BANDPLANS_URL_REFUSED"))
					return
				}
				const lengthText = headerValue(response.headers["content-length"])
				if (lengthText !== undefined) {
					const length = Number(lengthText.trim())
					if (Number.isFinite(length) && length > maxBytes) {
						finish(fail("BANDPLANS_IMPORT_TOO_LARGE"))
						return
					}
				}
				const chunks: Buffer[] = []
				let total = 0
				response.on("data", (chunk: Buffer | string) => {
					if (done) return
					const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk
					total += buf.length
					if (total > maxBytes) {
						finish(fail("BANDPLANS_IMPORT_TOO_LARGE"))
						return
					}
					chunks.push(buf)
				})
				response.on("end", () => {
					const bytes = new Uint8Array(Buffer.concat(chunks, total))
					log?.debug(
						{ host, path: url.pathname, bytes: total },
						"band-plan URL fetched",
					)
					finish(undefined, { bytes, contentType: mediaType })
				})
				response.on("close", () => {
					finish(fail("BANDPLANS_URL_FETCH_FAILED"))
				})
			}

			Promise.resolve()
				.then(() => resolve(host))
				.then(
					addresses => {
						if (done) return
						if (!Array.isArray(addresses) || addresses.length === 0) {
							finish(fail("BANDPLANS_URL_FETCH_FAILED"))
							return
						}
						for (const entry of addresses as readonly ResolvedAddress[]) {
							if (
								typeof entry?.address !== "string" ||
								!allowed(entry.address)
							) {
								finish(fail("BANDPLANS_URL_REFUSED"))
								return
							}
						}
						const first = addresses[0] as ResolvedAddress
						const family = isIP(first.address)
						try {
							req = request(
								{
									protocol: "https:",
									host: first.address,
									port: 443,
									family,
									method: "GET",
									path: `${url.pathname}${url.search}`,
									servername: host,
									headers: {
										Host: host,
										Accept: ACCEPT,
										"Accept-Encoding": "identity",
										"User-Agent": userAgent,
									},
									lookup: pinnedLookup(first.address, family),
									agent: false,
									rejectUnauthorized: true,
								},
								onResponse,
							)
						} catch {
							finish(fail("BANDPLANS_URL_FETCH_FAILED"))
							return
						}
						req.on("error", () => {
							finish(fail("BANDPLANS_URL_FETCH_FAILED"))
						})
						if (done) {
							req.destroy()
							return
						}
						req.end()
					},
					() => {
						finish(fail("BANDPLANS_URL_FETCH_FAILED"))
					},
				)
				.catch(() => {
					finish(fail("BANDPLANS_URL_FETCH_FAILED"))
				})
		})

	return async (rawUrl, hosts) => {
		const url = checkBandPlanUrl(rawUrl, hosts)
		if (inFlight) throw fail("BANDPLANS_BUSY")
		inFlight = true
		try {
			return await run(url)
		} finally {
			inFlight = false
		}
	}
}
