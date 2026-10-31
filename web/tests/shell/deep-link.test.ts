import fc from "fast-check"
import { describe, expect, it } from "vitest"

import type { LinkState } from "../../src/shell/deep-link.ts"
import {
	DECODER_NAME_MAX,
	formatLink,
	parseLink,
} from "../../src/shell/deep-link.ts"
import type { SearchToken } from "../../src/features/activity/search.ts"
import {
	decoderToken,
	frequencyToken,
	token,
} from "../../src/features/activity/search.ts"

const activityWith = (tokens: SearchToken[]): LinkState => ({
	view: "spectrum",
	drawer: "activity",
	activity: {
		tokens,
		chip: null,
		range: { kind: "any" },
		audio: false,
		openId: null,
	},
})
const tokensOf = (hash: string) => parseLink(hash)?.activity?.tokens

describe("deep links", () => {
	it("names the view, the drawer and what is open in it", () => {
		expect(formatLink({ view: "spectrum", drawer: null })).toBe("")
		expect(formatLink({ view: "map", drawer: null })).toBe("#/map")
		expect(formatLink({ view: "map", drawer: "recordings" })).toBe(
			"#/recordings?view=map",
		)
		expect(
			formatLink({ view: "spectrum", drawer: "scanner", discoveryId: "d 1" }),
		).toBe("#/scanner/d%201")
		expect(
			formatLink({
				view: "spectrum",
				drawer: "activity",
				activity: {
					tokens: [token("talkgroup", "1201"), frequencyToken(161_150_000)],
					chip: "voice",
					range: { kind: "today" },
					audio: true,
					openId: "ev1",
				},
			}),
		).toBe(
			"#/activity/ev1?t=talkgroup%3A1201&t=frequency%3A161150000%7E6250&cat=voice&range=today&audio=1",
		)
	})

	it("opens a setting, and ignores what it does not know", () => {
		expect(parseLink("#/settings/au.squelch")).toEqual({
			view: "spectrum",
			drawer: "settings",
			settingId: "au.squelch",
		})
		expect(parseLink("")).toEqual({ view: "spectrum", drawer: null })
		expect(parseLink("#section-2")).toBeNull()
		expect(parseLink("#/nowhere")).toBeNull()
		const odd = parseLink(
			"#/activity?t=bogus:1&t=talkgroup:&cat=zzz&range=junk",
		)
		expect(odd?.activity).toEqual({
			tokens: [],
			chip: null,
			range: { kind: "any" },
			audio: false,
			openId: null,
		})
	})

	it("keeps a decoder's display name, and an id holding ~", () => {
		const adsb = decoderToken("adsb-1", "ADS-B")
		const hash = formatLink(activityWith([adsb]))
		expect(hash).toBe("#/activity?t=decoder%3Aadsb-1%7EADS-B")
		expect(tokensOf(hash)).toEqual([adsb])
		expect(tokensOf(hash)?.[0]?.label).toBe("Decoder ADS-B")
		const tilde = decoderToken("a~b", "x~y %")
		expect(tokensOf(formatLink(activityWith([tilde])))).toEqual([tilde])
		const bare = decoderToken("a~b")
		expect(tokensOf(formatLink(activityWith([bare])))).toEqual([bare])
		// links made before names travelled still open
		expect(tokensOf("#/activity?t=decoder:adsb-1")).toEqual([
			decoderToken("adsb-1"),
		])
	})

	it("drops a bad, empty or too long decoder name, never the decoder", () => {
		const atMax = "n".repeat(DECODER_NAME_MAX)
		const pastMax = "n".repeat(DECODER_NAME_MAX + 1)
		expect(
			tokensOf(formatLink(activityWith([decoderToken("d1", atMax)]))),
		).toEqual([decoderToken("d1", atMax)])
		// past the limit the link carries the id alone, and a hand-made one is read the same
		expect(formatLink(activityWith([decoderToken("d1", pastMax)]))).toBe(
			"#/activity?t=decoder%3Ad1",
		)
		const q = (raw: string) =>
			tokensOf(`#/activity?t=${encodeURIComponent(raw)}`)
		expect(q(`decoder:d1~${pastMax}`)).toEqual([decoderToken("d1")])
		expect(q(`decoder:d1~${atMax}`)).toEqual([decoderToken("d1", atMax)])
		expect(q("decoder:d1~")).toEqual([decoderToken("d1")])
		expect(q("decoder:d1~%20%20")).toEqual([decoderToken("d1")])
		expect(q("decoder:d1~%E0%A4%A")).toEqual([decoderToken("d1")])
		expect(q("decoder:d1~a~b")).toEqual([decoderToken("d1", "a~b")])
		// a bad or empty id names nothing
		expect(q("decoder:%E0%A4%A~x")).toEqual([])
		expect(q("decoder:~x")).toEqual([])
		expect(q("decoder:%20~x")).toEqual([])
	})

	// Feature: web-app deep links, Property 1: a link opens the state it was made from
	it("round-trips every state through the hash", () => {
		const tok = fc.oneof(
			fc
				.tuple(
					fc.constantFrom(
						"talkgroup",
						"capcode",
						"mmsi",
						"icao",
						"callsign",
						"ctcss",
						"dcs",
						"entity",
						"decoder",
						"text",
					),
					fc
						.string({ minLength: 1, maxLength: 12 })
						.filter(s => s.trim() !== ""),
				)
				.map(([k, v]) => token(k, v)),
			fc
				.tuple(
					fc
						.string({ minLength: 1, maxLength: 12 })
						.filter(s => s.trim() !== ""),
					fc.option(fc.string({ maxLength: DECODER_NAME_MAX })),
				)
				.map(([id, name]) => decoderToken(id, name ?? undefined)),
			fc
				.tuple(
					fc.integer({ min: 100_000, max: 6_000_000_000 }),
					fc.integer({ min: 1, max: 50_000 }),
				)
				.map(([hz, span]) => frequencyToken(hz, span)),
		)
		const range = fc.oneof(
			fc
				.constantFrom("any", "1h", "today", "24h", "7d")
				.map(kind => ({ kind })),
			fc
				.tuple(
					fc.integer({ min: 1e12, max: 2e12 }),
					fc.option(fc.integer({ min: 1, max: 1e9 })),
				)
				.map(([from, len]) => ({
					kind: "custom" as const,
					from,
					to: len === null ? null : from + len,
				})),
		)
		const state: fc.Arbitrary<LinkState> = fc.oneof(
			fc
				.constantFrom("spectrum", "map", "messages")
				.map(view => ({ view, drawer: null })),
			fc
				.tuple(
					fc.constantFrom("spectrum", "map", "messages"),
					fc.uniqueArray(tok, {
						maxLength: 4,
						selector: t => `${t.kind}:${t.value}`,
					}),
					fc.constantFrom(null, "voice", "paging", "mesh"),
					range,
					fc.boolean(),
					fc.option(
						fc
							.string({ minLength: 1, maxLength: 20 })
							.filter(s => s !== "." && s !== ".."),
					),
				)
				.map(([view, tokens, chip, r, audio, openId]) => ({
					view,
					drawer: "activity" as const,
					activity: { tokens, chip, range: r, audio, openId },
				})),
			fc
				.tuple(
					fc.constantFrom("spectrum", "map"),
					fc.option(fc.string({ minLength: 1, maxLength: 20 })),
				)
				.map(([view, discoveryId]) => ({
					view,
					drawer: "scanner" as const,
					discoveryId,
				})),
		)
		fc.assert(
			fc.property(state, s => {
				const back = parseLink(formatLink(s))
				expect(back).toEqual(
					s.drawer === "scanner" && s.discoveryId === null
						? { ...s, discoveryId: null }
						: s,
				)
			}),
			{ numRuns: 300 },
		)
	})
})
