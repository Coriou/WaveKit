import fc from "fast-check"
import { describe, expect, it } from "vitest"
import type { ExtendedSourceStatus, TunerState } from "@wavekit/api-types"
import {
	bandFor,
	bandLabel,
	configuredNote,
	decoderBand,
	type NominalBand,
} from "../../../cli/source/data/nominal-bands.js"
import {
	decoderMembership,
	decoderSourceId,
	membership,
	retuneCandidates,
	retuneImpact,
	rowSourceId,
	windowFor,
	type TunedWindow,
} from "../../../cli/source/data/window.js"
import { glyphs, setGlyphMode } from "../../../cli/source/ui/theme.js"
import type { DecoderRow } from "../../../cli/source/data/types.js"

const win = (centreHz: number, sampleRate = 2_048_000): TunedWindow => ({
	sourceId: "s",
	centreHz,
	sampleRate,
	loHz: centreHz - sampleRate / 2,
	hiHz: centreHz + sampleRate / 2,
})

function src(
	id: string,
	centreHz: number,
	decoders: string[],
): ExtendedSourceStatus {
	return {
		id,
		connected: true,
		consumers: 1,
		bytesReceived: 0,
		dataRate: 0,
		reconnectAttempts: 0,
		available: true,
		caps: {
			kind: "iq",
			sampleRate: 2_048_000,
			format: "U8_IQ",
			exclusive: false,
			centerFreq: centreHz,
		},
		assignments: decoders.map(d => ({
			decoderId: d,
			sourceId: id,
			assignedAt: "t",
		})),
	}
}
const dec = (id: string, type = id): DecoderRow => ({
	id,
	type,
	running: true,
	health: "running",
	uptime: 1,
	stats: { bytesIn: 0, eventsOut: 0, errors: 0 },
	restartCount: 0,
})

const TYPES = [
	"readsb",
	"ais-catcher",
	"acarsdec",
	"dumpvdl2",
	"direwolf",
	"rtl433",
	"lora-meshtastic",
	"dsd-fme",
	"multimon-ng",
] as const

describe("nominal bands", () => {
	it("labels the spec table, ranges through the glyph table (R41)", () => {
		const label = (t: string): string | undefined => {
			const b = bandFor(t)
			return b ? bandLabel(b, glyphs().range) : undefined
		}
		expect(label("readsb")).toBe("1090.000")
		expect(label("ais-catcher")).toBe("161.975/162.025")
		expect(label("acarsdec")).toBe("131.550–131.825")
		expect(label("dsd-fme")).toBe("tuned")
		expect(bandFor("mystery")).toBeUndefined()
		setGlyphMode("ascii")
		try {
			expect(label("acarsdec")).toBe("131.550-131.825")
		} finally {
			setGlyphMode("utf8")
		}
	})
})

describe("window", () => {
	it("prefers TunerState, then caps.centerFreq, then relay.lastFrequency", () => {
		const tuner = {
			sourceId: "pi-iq",
			frequency: 445_970_700,
			sampleRate: 2_048_000,
		} as TunerState
		expect(windowFor("pi-iq", [tuner], [], undefined)?.loHz).toBe(444_946_700)
		expect(
			windowFor("pi-iq", [], [src("pi-iq", 100_000_000, [])], undefined)
				?.centreHz,
		).toBe(100_000_000)
		expect(windowFor("pi-iq", [], [], undefined)).toBeNull()
	})
	it("skips a frequency or sample rate the tuner lists as unknown (R86)", () => {
		// Core's placeholder: 100 MHz / 2.4 MS/s, listed in unknownFields.
		const placeholder = {
			sourceId: "pi-iq",
			frequency: 100_000_000,
			sampleRate: 2_400_000,
			unknownFields: ["frequency", "sampleRate"],
		} as TunerState
		expect(windowFor("pi-iq", [placeholder], [], undefined)).toBeNull()
		const fromCaps = windowFor(
			"pi-iq",
			[placeholder],
			[src("pi-iq", 445_970_700, [])],
			undefined,
		)
		expect(fromCaps?.centreHz).toBe(445_970_700)
		expect(fromCaps?.sampleRate).toBe(2_048_000)
		// Only the listed field is skipped.
		const rateKnown = {
			...placeholder,
			unknownFields: ["frequency"],
		} as TunerState
		expect(
			windowFor(
				"pi-iq",
				[rateKnown],
				[src("pi-iq", 445_970_700, [])],
				undefined,
			)?.sampleRate,
		).toBe(2_400_000)
	})
	it("treats a centre at or below 0 Hz as no window (R41)", () => {
		expect(windowFor("a", [], [src("a", 0, [])], undefined)).toBeNull()
		expect(windowFor("a", [], [src("a", -5, [])], undefined)).toBeNull()
		expect(
			decoderMembership(
				dec("rtl433"),
				[src("a", 0, ["rtl433"])],
				[],
				undefined,
			),
		).toBe("?")
	})
	it("handles two sources with decoders split between them (review focus 5)", () => {
		const sources = [
			src("a", 433_920_000, ["rtl433"]),
			src("b", 1_090_000_000, ["readsb", "ais-catcher"]),
		]
		expect(decoderMembership(dec("rtl433"), sources, [], undefined)).toBe("in")
		expect(decoderMembership(dec("readsb"), sources, [], undefined)).toBe("in")
		expect(decoderMembership(dec("ais-catcher"), sources, [], undefined)).toBe(
			"out",
		)
		expect(decoderMembership(dec("dumpvdl2"), sources, [], undefined)).toBe("?")
		expect(
			decoderMembership(
				dec("weird", "mystery"),
				[src("only", 1e8, [])],
				[],
				undefined,
			),
		).toBe("?")
	})
	it("marks external decoders — by input or by integration pattern (R41)", () => {
		const sources = [src("a", 131_550_000, [])]
		const ext = (caps: DecoderRow["caps"]): DecoderRow => ({
			...dec("acarsdec"),
			...(caps ? { caps } : {}),
		})
		expect(
			decoderMembership(
				ext({
					input: "external",
					output: "jsonl",
					integrationPattern: "external_sdr",
				}),
				sources,
				[],
				undefined,
			),
		).toBe("—")
		expect(
			decoderMembership(
				ext({
					input: "external",
					output: "jsonl",
					integrationPattern: "pure_consumer",
				}),
				sources,
				[],
				undefined,
			),
		).toBe("—")
		expect(
			decoderMembership(
				ext({
					input: "iq",
					output: "jsonl",
					integrationPattern: "external_sdr",
				}),
				sources,
				[],
				undefined,
			),
		).toBe("—")
		expect(
			decoderMembership(
				ext({
					input: "iq",
					output: "jsonl",
					integrationPattern: "pure_consumer",
				}),
				sources,
				[],
				undefined,
			),
		).toBe("in")
	})

	// Feature: cli-dashboard-overhaul, Property 14: window membership
	// Validates: spec §10.9
	it("P14: tuned → in; a channel at the centre or exactly rate/2 away → in; all channels outside half-span → out; no window → ?", () => {
		fc.assert(
			fc.property(
				fc.array(fc.integer({ min: 24, max: 1900 }), {
					minLength: 1,
					maxLength: 4,
				}),
				fc.integer({ min: 125_000, max: 1_600_000 }).map(h => h * 2),
				(channels, rate) => {
					const band: NominalBand = {
						kind: "channels",
						channelsMHz: channels,
						join: "alternatives",
					}
					const c0 = channels[0]! * 1e6
					expect(membership({ kind: "tuned" }, null)).toBe("in")
					expect(membership(band, win(c0, rate))).toBe("in")
					// Inclusive boundary: |c − centre| = rate/2 is still in.
					expect(
						membership(
							{ ...band, channelsMHz: [channels[0]!] },
							win(c0 + rate / 2, rate),
						),
					).toBe("in")
					const far = Math.max(...channels) * 1e6 + rate
					expect(membership(band, win(far + 1, rate))).toBe("out")
					expect(membership(band, null)).toBe("?")
				},
			),
			{ numRuns: 100 },
		)
	})

	// Feature: cli-dashboard-overhaul, Property 15: retune impact
	// Validates: spec §10.9
	it("P15: tuned stays tuned; enters/leaves are exact flips; unknown before or after is reported apart", () => {
		const arbDecoders = fc.tuple(
			...TYPES.map(t =>
				fc
					.option(
						fc.array(
							fc.integer({ min: 24, max: 1900 }).map(m => m * 1e6),
							{ minLength: 1, maxLength: 3 },
						),
						{ nil: undefined },
					)
					.map(targets => ({
						id: t,
						type: t,
						...(targets !== undefined ? { targetFrequenciesHz: targets } : {}),
					})),
			),
		)
		fc.assert(
			fc.property(
				arbDecoders,
				fc.option(fc.integer({ min: 24_000_000, max: 1_900_000_000 }), {
					nil: null,
				}),
				fc.integer({ min: 24_000_000, max: 1_900_000_000 }),
				(decoders, a, b) => {
					const from = a === null ? null : win(a)
					const r = retuneImpact(decoders, from, win(b))
					expect([...r.tuned].sort()).toEqual(["dsd-fme", "multimon-ng"])
					for (const d of decoders) {
						if (bandFor(d.type)?.kind === "tuned") continue
						const band = decoderBand(d)?.band
						const before = membership(band, from)
						const after = membership(band, win(b))
						const unknown = before === "?" || after === "?"
						expect(r.unknown.includes(d.id)).toBe(unknown)
						expect(r.enters.includes(d.id)).toBe(
							!unknown && before === "out" && after === "in",
						)
						expect(r.leaves.includes(d.id)).toBe(
							!unknown && before === "in" && after === "out",
						)
					}
				},
			),
			{ numRuns: 100 },
		)
	})
})

describe("configured targets (R15, R40)", () => {
	it("configured targets replace the table for channel decoders, labelled configured", () => {
		const one = decoderBand({
			type: "readsb",
			targetFrequenciesHz: [445_970_700],
		})
		expect(one?.origin).toBe("configured")
		expect(one && bandLabel(one.band, glyphs().range)).toBe("445.971")
		const span = decoderBand({
			type: "acarsdec",
			targetFrequenciesHz: [131_825_000, 131_550_000, 131_725_000],
		})
		expect(span && bandLabel(span.band, glyphs().range)).toBe("131.550–131.825")
		expect(decoderBand({ type: "readsb" })).toEqual({
			band: bandFor("readsb"),
			origin: "nominal",
		})
		expect(
			decoderBand({ type: "readsb", targetFrequenciesHz: [] })?.origin,
		).toBe("nominal")
		expect(decoderBand({ type: "mystery" })).toBeUndefined()
	})
	it("treats targets all-or-nothing, like the guards (R41)", () => {
		expect(
			decoderBand({
				type: "readsb",
				targetFrequenciesHz: [445_970_700, Number.NaN],
			}),
		).toEqual({
			band: bandFor("readsb"),
			origin: "nominal",
		})
		expect(
			decoderBand({ type: "readsb", targetFrequenciesHz: [-1] })?.origin,
		).toBe("nominal")
	})
	it("keeps tuned types tuned; a configured target is an annotation only (R40)", () => {
		const b = decoderBand({
			type: "dsd-fme",
			targetFrequenciesHz: [446_525_000],
		})
		expect(b).toEqual({
			band: { kind: "tuned" },
			origin: "nominal",
			ignoredTargetsHz: [446_525_000],
		})
		expect(b && configuredNote(b)).toBe(
			"configured 446.525 MHz (not applied by this decoder)",
		)
		expect(
			configuredNote({ band: { kind: "tuned" }, origin: "nominal" }),
		).toBeNull()
		const sources = [src("a", 433_920_000, ["dsd-fme"])]
		expect(
			decoderMembership(
				{ ...dec("dsd-fme"), targetFrequenciesHz: [100_000_000] },
				sources,
				[],
				undefined,
			),
		).toBe("in")
		const r = retuneImpact(
			[{ id: "m", type: "multimon-ng", targetFrequenciesHz: [100_000_000] }],
			win(433_920_000),
			win(1_090_000_000),
		)
		expect(r).toEqual({ tuned: ["m"], enters: [], leaves: [], unknown: [] })
	})
	it("resolves a decoder's source the same way everywhere: assignment, declared sourceId, single source", () => {
		const sources = [
			src("a", 433_920_000, []),
			src("b", 1_090_000_000, ["rtl433"]),
		]
		expect(
			decoderMembership(
				{ ...dec("readsb"), sourceId: "b" },
				sources,
				[],
				undefined,
			),
		).toBe("in")
		expect(
			decoderMembership(
				{ ...dec("readsb"), sourceId: "a" },
				sources,
				[],
				undefined,
			),
		).toBe("out")
		expect(decoderMembership(dec("readsb"), sources, [], undefined)).toBe("?")
		expect(rowSourceId({ ...dec("readsb"), sourceId: "a" }, sources)).toBe("a")
		expect(rowSourceId({ ...dec("rtl433"), sourceId: "a" }, sources)).toBe("b")
		expect(decoderSourceId("x", [src("only", 1e8, [])], undefined)).toBe("only")
		const rows = [
			{ ...dec("readsb"), sourceId: "b" },
			{ ...dec("rtl433") },
			{
				...dec("acarsdec"),
				sourceId: "b",
				caps: {
					input: "external",
					output: "jsonl",
					integrationPattern: "external_sdr",
				},
			} as DecoderRow,
			{ ...dec("ais-catcher"), sourceId: "a" },
		]
		expect(retuneCandidates(rows, sources, "b").map(d => d.id)).toEqual([
			"readsb",
			"rtl433",
		])
	})
	it("never claims enters when the current window is unknown (R41)", () => {
		const r = retuneImpact(
			[
				{ id: "x", type: "readsb", targetFrequenciesHz: [433_920_000] },
				{ id: "y", type: "rtl433" },
			],
			null,
			win(433_920_000),
		)
		expect(r).toEqual({
			tuned: [],
			enters: [],
			leaves: [],
			unknown: ["x", "y"],
		})
		const known = retuneImpact(
			[{ id: "x", type: "readsb", targetFrequenciesHz: [433_920_000] }],
			win(1_090_000_000),
			win(433_920_000),
		)
		expect(known).toEqual({ tuned: [], enters: ["x"], leaves: [], unknown: [] })
	})
})
