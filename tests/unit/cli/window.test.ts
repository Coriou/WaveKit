import fc from "fast-check"
import { describe, expect, it } from "vitest"
import type { ExtendedSourceStatus, TunerState } from "@wavekit/api-types"
import {
	bandFor,
	decoderBand,
	type NominalBand,
} from "../../../cli/source/data/nominal-bands.js"
import {
	decoderMembership,
	membership,
	retuneImpact,
	windowFor,
	type TunedWindow,
} from "../../../cli/source/data/window.js"
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

describe("nominal bands", () => {
	it("labels the spec table", () => {
		expect(bandFor("readsb")?.label).toBe("1090.000")
		expect(bandFor("acarsdec")?.label).toBe("131.550–131.825")
		expect(bandFor("dsd-fme")?.kind).toBe("tuned")
		expect(bandFor("mystery")).toBeUndefined()
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
				{
					...dec("acarsdec"),
					caps: {
						input: "external",
						output: "jsonl",
						integrationPattern: "external_sdr",
					},
				},
				sources,
				[],
				undefined,
			),
		).toBe("—")
		expect(
			decoderMembership(
				dec("weird", "mystery"),
				[src("only", 1e8, [])],
				[],
				undefined,
			),
		).toBe("?")
	})

	// Feature: cli-dashboard-overhaul, Property 14: window membership
	// Validates: spec §10.9
	it("P14: tuned → in; a channel at the centre → in; all channels outside half-span → out; no window → ?", () => {
		fc.assert(
			fc.property(
				fc.array(fc.double({ min: 24, max: 1900, noNaN: true }), {
					minLength: 1,
					maxLength: 4,
				}),
				fc.integer({ min: 250_000, max: 3_200_000 }),
				(channels, rate) => {
					const band: NominalBand = {
						kind: "channels",
						channelsMHz: channels,
						label: "x",
					}
					expect(membership({ kind: "tuned", label: "tuned" }, null)).toBe("in")
					expect(membership(band, win(channels[0]! * 1e6, rate))).toBe("in")
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
	it("P15: retuneImpact = tuned ∪ decoders whose membership flips", () => {
		const types = [
			"readsb",
			"ais-catcher",
			"acarsdec",
			"dumpvdl2",
			"direwolf",
			"rtl433",
			"lora-meshtastic",
			"dsd-fme",
			"multimon-ng",
		]
		fc.assert(
			fc.property(
				fc.integer({ min: 24_000_000, max: 1_900_000_000 }),
				fc.integer({ min: 24_000_000, max: 1_900_000_000 }),
				(a, b) => {
					const decoders = types.map(t => ({ id: t, type: t }))
					const r = retuneImpact(decoders, win(a), win(b))
					expect(r.tuned.sort()).toEqual(["dsd-fme", "multimon-ng"])
					for (const d of decoders) {
						if (bandFor(d.type)?.kind === "tuned") continue
						const before = membership(bandFor(d.type), win(a)) === "in"
						const after = membership(bandFor(d.type), win(b)) === "in"
						expect(r.enters.includes(d.id)).toBe(!before && after)
						expect(r.leaves.includes(d.id)).toBe(before && !after)
					}
				},
			),
			{ numRuns: 100 },
		)
	})
})

describe("configured targets (R15)", () => {
	it("prefers targetFrequenciesHz, labelled configured; else the table, labelled nominal", () => {
		expect(
			decoderBand({ type: "readsb", targetFrequenciesHz: [445_970_700] }),
		).toEqual({
			band: { kind: "channels", channelsMHz: [445.9707], label: "445.971" },
			origin: "configured",
		})
		expect(
			decoderBand({
				type: "acarsdec",
				targetFrequenciesHz: [131_825_000, 131_550_000, 131_725_000],
			})?.band.label,
		).toBe("131.550–131.825")
		expect(decoderBand({ type: "readsb" })).toEqual({
			band: bandFor("readsb"),
			origin: "nominal",
		})
		expect(
			decoderBand({ type: "readsb", targetFrequenciesHz: [] })?.origin,
		).toBe("nominal")
		expect(
			decoderBand({ type: "readsb", targetFrequenciesHz: [Number.NaN, -1] })
				?.origin,
		).toBe("nominal")
		expect(decoderBand({ type: "mystery" })).toBeUndefined()
	})
	it("decides membership from configured targets, even for a tuned type", () => {
		const sources = [src("a", 433_920_000, ["readsb", "dsd-fme"])]
		expect(
			decoderMembership(
				{ ...dec("readsb"), targetFrequenciesHz: [433_920_000] },
				sources,
				[],
				undefined,
			),
		).toBe("in")
		expect(
			decoderMembership(
				{ ...dec("dsd-fme"), targetFrequenciesHz: [100_000_000] },
				sources,
				[],
				undefined,
			),
		).toBe("out")
	})
	it("falls back to the decoder's declared sourceId before the single-source rule", () => {
		const sources = [src("a", 433_920_000, []), src("b", 1_090_000_000, [])]
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
	})
	it("feeds configured targets into retuneImpact", () => {
		const r = retuneImpact(
			[{ id: "x", type: "readsb", targetFrequenciesHz: [433_920_000] }],
			win(1_090_000_000),
			win(433_920_000),
		)
		expect(r).toEqual({ tuned: [], enters: ["x"], leaves: [] })
	})
})
