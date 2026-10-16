import { describe, expect, it, vi } from "vitest"
import fc from "fast-check"
import { BANDPLAN_URL_CONTENT_TYPES } from "@wavekit/api-types"
import { BandPlansError } from "../../../../src/core/bandplans/contract.js"
import {
	createBandPlanUrlFetcher,
	isRefusedAddress,
	type ResolvedAddress,
} from "../../../../src/core/bandplan-url/index.js"
import { HOSTS, PUBLIC, fakeRequest, resolveTo } from "./helpers.js"

const LIMIT = 4096 // scaled cap for the property; the 1 MiB default is tested in fetch.test.ts

async function outcome(p: Promise<unknown>): Promise<string> {
	try {
		await p
		return "OK"
	} catch (error) {
		if (!(error instanceof BandPlansError)) throw error
		return error.code
	}
}

const refusedSamples = [
	"127.0.0.1",
	"10.0.0.1",
	"169.254.169.254",
	"192.168.0.1",
	"100.64.0.1",
	"::1",
	"fd00::1",
	"fe80::1",
	"::ffff:127.0.0.1",
	"64:ff9b::a00:1",
	"ff02::1",
	"bogus",
]
const addressArb = fc.oneof(
	fc.ipV4(),
	fc.ipV6(),
	fc.constantFrom(...refusedSamples),
	fc.constantFrom("185.199.108.133", "2606:50c0:8000::154"),
)
const hostArb = fc.oneof(
	fc.constant("raw.githubusercontent.com"),
	fc.constant("RAW.githubusercontent.com"),
	fc.constant("raw.githubusercontent.com."),
	fc.constant("x.raw.githubusercontent.com"),
	fc.constant("raw.githubusercontent.com.evil"),
	fc.constant("127.0.0.1"),
	fc.constant("[::1]"),
	fc.domain(),
)
const urlArb = fc
	.record({
		scheme: fc.constantFrom("https", "http", "HTTPS", "ftp"),
		user: fc.constantFrom("", "u@", "u:p@"),
		host: hostArb,
		port: fc.constantFrom("", ":443", ":8443"),
		path: fc.webPath(),
		query: fc.constantFrom("", "?a=1"),
		frag: fc.constantFrom("", "#", "#x"),
	})
	.map(r => ({
		...r,
		url: `${r.scheme}://${r.user}${r.host}${r.port}${r.path}${r.query}${r.frag}`,
	}))

describe("fetcher properties", () => {
	// Feature: web-gaps-6, Property 11: URL refusal
	// Validates: Requirements 5.2
	it("connects only for a valid allowlisted URL whose every address is public, only to a checked address", async () => {
		await fc.assert(
			fc.asyncProperty(
				urlArb,
				fc.array(addressArb, { maxLength: 4 }),
				async (u, addrs) => {
					const answers: ResolvedAddress[] = addrs.map(address => ({
						address,
						family: address.includes(":") ? 6 : 4,
					}))
					const { request, log } = fakeRequest({ chunks: [Buffer.from("x")] })
					const fetcher = createBandPlanUrlFetcher({
						resolve: resolveTo(answers),
						request,
					})
					const code = await outcome(fetcher(u.url, HOSTS))
					const urlOk =
						u.scheme.toLowerCase() === "https" &&
						u.user === "" &&
						u.port === "" &&
						u.frag === "" &&
						u.host.toLowerCase() === "raw.githubusercontent.com"
					const addrsOk =
						answers.length > 0 &&
						answers.every(a => !isRefusedAddress(a.address))
					if (urlOk && addrsOk) {
						expect(code).toBe("OK")
						expect(log.calls).toHaveLength(1)
						expect(log.calls[0]?.host).toBe(answers[0]?.address)
						expect(isRefusedAddress(String(log.calls[0]?.host))).toBe(false)
					} else {
						expect(log.calls).toHaveLength(0)
						expect(code).toBe(
							urlOk && answers.length === 0
								? "BANDPLANS_URL_FETCH_FAILED"
								: "BANDPLANS_URL_REFUSED",
						)
					}
				},
			),
			{ numRuns: 300 },
		)
	})

	// Feature: web-gaps-6, Property 12: Fetch bounds
	// Validates: Requirements 5.3, 5.4
	it("returns bytes only for 200, accepted media type, identity, within the cap and deadline; flag always released", async () => {
		vi.useFakeTimers()
		try {
			await fc.assert(
				fc.asyncProperty(
					fc.record({
						status: fc.constantFrom(200, 200, 200, 204, 301, 302, 404, 500),
						type: fc.option(
							fc.constantFrom(
								...BANDPLAN_URL_CONTENT_TYPES,
								"text/html",
								"Text/Plain; charset=utf-8",
							),
							{ nil: undefined },
						),
						encoding: fc.option(fc.constantFrom("identity", "gzip", "br"), {
							nil: undefined,
						}),
						announce: fc.boolean(),
						chunks: fc.array(fc.integer({ min: 0, max: 2048 }), {
							maxLength: 6,
						}),
						hang: fc.boolean(),
						requestError: fc.boolean(),
					}),
					async s => {
						const total = s.chunks.reduce((a, b) => a + b, 0)
						const headers: Record<string, string> = {}
						if (s.type !== undefined) headers["content-type"] = s.type
						if (s.encoding !== undefined)
							headers["content-encoding"] = s.encoding
						if (s.announce) headers["content-length"] = String(total)
						const { request, log } = fakeRequest({
							status: s.status,
							headers,
							chunks: s.chunks.map(n => Buffer.alloc(n, 0x61)),
							hang: s.hang,
							requestError: s.requestError,
						})
						const fetcher = createBandPlanUrlFetcher({
							resolve: resolveTo(PUBLIC),
							request,
							maxBytes: LIMIT,
						})
						const p = outcome(
							fetcher("https://raw.githubusercontent.com/a/b.csv", HOSTS),
						)
						await vi.advanceTimersByTimeAsync(10_000)
						const code = await p
						const mediaOk =
							s.type !== undefined &&
							BANDPLAN_URL_CONTENT_TYPES.includes(
								(s.type.split(";")[0] ?? "").trim().toLowerCase(),
							)
						let expected: string
						if (s.requestError) expected = "BANDPLANS_URL_FETCH_FAILED"
						else if (s.status !== 200) expected = "BANDPLANS_URL_FETCH_FAILED"
						else if (s.encoding !== undefined && s.encoding !== "identity")
							expected = "BANDPLANS_URL_REFUSED"
						else if (!mediaOk) expected = "BANDPLANS_URL_REFUSED"
						else if (total > LIMIT) expected = "BANDPLANS_IMPORT_TOO_LARGE"
						else if (s.hang) expected = "BANDPLANS_URL_TIMEOUT"
						else expected = "OK"
						expect(code).toBe(expected)
						if (code !== "OK") expect(log.destroyed).toBeGreaterThanOrEqual(1)
						// Flag released: an immediate next call is not BUSY.
						const next = outcome(
							fetcher("https://raw.githubusercontent.com/a/b.csv", HOSTS),
						)
						await vi.advanceTimersByTimeAsync(10_000)
						expect(await next).not.toBe("BANDPLANS_BUSY")
					},
				),
				{ numRuns: 200 },
			)
		} finally {
			vi.useRealTimers()
		}
	})
})
