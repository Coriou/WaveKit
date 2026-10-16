import * as fc from "fast-check"
import { describe, expect, it } from "vitest"
import { bandPlanImportUrlSchema } from "@wavekit/api-types"
import { checkBandPlanUrl } from "../../../../src/core/bandplan-url/fetch.js"

// Feature: web-gaps-7, Property 15: URL schema parity
// Validates: Requirements 10.1
//
// checkBandPlanUrl is synchronous and does no I/O (DNS and sockets live in the fetcher
// proper), so it is called directly.

const HOST = "plans.example.org"
const HOSTS = [HOST]
const RUNS = 500

function fetcherThrows(raw: string): boolean {
	try {
		checkBandPlanUrl(raw, HOSTS)
		return false
	} catch {
		return true
	}
}

/**
 * Oracle: the fetcher's own raw-text checks, re-implemented from
 * src/core/bandplan-url/fetch.ts lines 90-99 (control/space/backslash/`#` regex, scheme,
 * authority rule). true = refused.
 */
function oracleRefuses(raw: string): boolean {
	if (/[\u0000- \u007f\\#]/.test(raw)) return true // fetch.ts:90
	const schemeEnd = raw.indexOf("//") // fetch.ts:91
	if (schemeEnd < 0 || raw.slice(0, schemeEnd).toLowerCase() !== "https:")
		return true // fetch.ts:92-93
	const rest = raw.slice(schemeEnd + 2) // fetch.ts:94
	const authorityEnd = rest.search(/[/?]/) // fetch.ts:95
	const authority = authorityEnd < 0 ? rest : rest.slice(0, authorityEnd) // fetch.ts:96
	return authority.includes(":") || authority.includes("@") || authority === "" // fetch.ts:97-98
}

const caseMixed = (text: string) =>
	fc
		.array(fc.boolean(), { minLength: text.length, maxLength: text.length })
		.map(flags =>
			[...text]
				.map((c, i) => (flags[i] ? c.toUpperCase() : c.toLowerCase()))
				.join(""),
		)

const scheme = fc.oneof(
	fc.constant("https:"),
	caseMixed("https:"),
	fc.constant("http:"),
	fc.constant("ftp:"),
	fc.constant(""),
	fc.constant("https"),
	fc.constant(" https:"),
)
const slashes = fc.constantFrom("//", "//", "//", "/", "///", "\\\\", "/\\")
const userinfo = fc.constantFrom(
	"",
	"",
	"",
	"user@",
	"user:pw@",
	"@",
	":@",
	"a b@",
)
const listedHost = fc.oneof(
	fc.constant(HOST),
	caseMixed(HOST),
	fc.constant(`${HOST}.`),
	fc.constant(`[::1]`),
	fc.constant("127.0.0.1"),
	fc.constant("1.2.3.4"),
	fc.constant("evil.example.org"),
	fc.constant(""),
)
const port = fc.constantFrom(
	"",
	"",
	"",
	":",
	":443",
	":8443",
	":0",
	":80",
	":abc",
)
const pathPart = fc.oneof(
	fc.constant(""),
	fc.constant("/"),
	fc.constant("/a/b.json"),
	fc.constant("?q=1"),
	fc.constant("/a?q=1"),
	fc.constant("/a b"),
	fc.constant("/a\\b"),
	fc.constant("/a\u0000b"),
	fc.constant("/a\u007fb"),
	fc.constant("/%41"),
	fc.constant("/é"),
	fc.constant("/a\tb"),
	fc.constant("/a\nb"),
)
const fragment = fc.constantFrom("", "", "", "#", "#frag", "#/a")
const noise = fc.string({ maxLength: 4 })

const url = (hosts: fc.Arbitrary<string>) =>
	fc
		.tuple(scheme, slashes, userinfo, hosts, port, pathPart, fragment, noise)
		.chain(([sc, sl, ui, h, po, pa, fr, no]) =>
			fc
				.constantFrom(
					`${sc}${sl}${ui}${h}${po}${pa}${fr}`,
					`${sc}${sl}${ui}${h}${po}${pa}${fr}${no}`,
					`${no}${sc}${sl}${ui}${h}${po}${pa}${fr}`,
				)
				.map(s => s),
		)

describe("URL schema parity (property 15)", () => {
	it("host in the list: schema accepts exactly when checkBandPlanUrl does not throw", () => {
		fc.assert(
			fc.property(url(fc.oneof(fc.constant(HOST), caseMixed(HOST))), raw => {
				expect(bandPlanImportUrlSchema.safeParse(raw).success).toBe(
					!fetcherThrows(raw),
				)
			}),
			{ numRuns: RUNS },
		)
	})

	it("any host: whatever the fetcher's raw checks refuse, the schema refuses", () => {
		fc.assert(
			fc.property(url(listedHost), raw => {
				if (oracleRefuses(raw))
					expect(bandPlanImportUrlSchema.safeParse(raw).success).toBe(false)
			}),
			{ numRuns: RUNS },
		)
	})

	it("any host: a schema-accepted string is refused by the fetcher only for host reasons", () => {
		fc.assert(
			fc.property(url(listedHost), raw => {
				if (!bandPlanImportUrlSchema.safeParse(raw).success) return
				expect(oracleRefuses(raw)).toBe(false)
				if (fetcherThrows(raw)) {
					// Only the allowlist, IP-literal, trailing-dot or empty-host rules remain.
					const host = new URL(raw).hostname.toLowerCase()
					expect(host === HOST).toBe(false)
				}
			}),
			{ numRuns: RUNS },
		)
	})

	it.each([
		["explicit default port", `https://${HOST}:443/a`],
		["bare colon", `https://${HOST}:/a`],
		["empty fragment", `https://${HOST}/a#`],
		["userinfo", `https://u@${HOST}/a`],
		["backslash", `https://${HOST}\\a`],
		["space", `https://${HOST}/a b`],
	])("pins %s as refused by both", (_, raw) => {
		expect(bandPlanImportUrlSchema.safeParse(raw).success).toBe(false)
		expect(fetcherThrows(raw)).toBe(true)
	})
	it("pins a plain listed URL and a mixed-case scheme/host as accepted by both", () => {
		for (const raw of [
			`https://${HOST}/a.json`,
			`HTTPS://PLANS.Example.ORG/a?x=1`,
		]) {
			expect(bandPlanImportUrlSchema.safeParse(raw).success).toBe(true)
			expect(fetcherThrows(raw)).toBe(false)
		}
	})
})
