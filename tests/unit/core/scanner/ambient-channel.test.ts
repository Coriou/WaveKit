import { EventEmitter } from "node:events"
import fc from "fast-check"
import pino from "pino"
import { describe, expect, it } from "vitest"
import {
	AmbientEvidence,
	type AmbientEvidenceEvent,
} from "../../../../src/core/scanner/probes/ambient.js"
import {
	AMBIENT_CHANNEL_MAX_HALF_HZ,
	RTL433_FREQ_TOLERANCE_HZ,
	channelPassbandOf,
	pickChannelObservation,
	rtl433FreqHz,
	windowPassbandOf,
	type ChannelCandidate,
} from "../../../../src/core/scanner/probes/ambient-channel.js"
import { createInterpreterState } from "../../../../src/core/scanner/probes/confirm/double-match.js"
import {
	RTL433_FIELD_MAX_CHARS,
	RTL433_MODEL_MAX_CHARS,
	interpretRtl433,
} from "../../../../src/core/scanner/probes/confirm/rtl433.js"

const CENTRE = 433_700_000
const HALF = 250_000
const passband = { centreHz: CENTRE, halfHz: HALF }

const obs = (
	id: string,
	hz: number,
	extra: Partial<ChannelCandidate> = {},
): ChannelCandidate => ({
	observationId: id,
	sourceId: "rtl",
	startedAt: 1_000,
	endedAt: 2_000,
	lastTrack: { centreHz: hz, obwHz: 10_000 },
	...extra,
})
const pick = (list: ChannelCandidate[], at = 1_500) =>
	pickChannelObservation(list, { sourceId: "rtl", passband, at }, 10_000, 2_000)

describe("pickChannelObservation", () => {
	it("names an observation inside the passband", () => {
		expect(pick([obs("a", CENTRE + 40_000)])?.observationId).toBe("a")
	})

	it("names nothing outside the passband, on another source or out of time", () => {
		expect(pick([obs("a", CENTRE + HALF + 1)])).toBeNull()
		expect(pick([obs("a", CENTRE, { sourceId: "other" })])).toBeNull()
		expect(pick([obs("a", CENTRE)], 4_001)).toBeNull()
		expect(pick([obs("a", CENTRE)], -1_001)).toBeNull()
	})

	it("includes both edges and excludes one hertz past them", () => {
		expect(pick([obs("lo", CENTRE - HALF)])?.observationId).toBe("lo")
		expect(pick([obs("hi", CENTRE + HALF)])?.observationId).toBe("hi")
		expect(pick([obs("lo", CENTRE - HALF - 1)])).toBeNull()
		expect(pick([obs("hi", CENTRE + HALF + 1)])).toBeNull()
	})

	it("names nothing without a discovery to name", () => {
		expect(pick([])).toBeNull()
		expect(pick([{ ...obs("a", CENTRE), lastTrack: null }])).toBeNull()
	})

	it("names nothing when two observations qualify", () => {
		// A burst at +40 kHz that ended and a carrier at +100 kHz still active both
		// overlap the decode: either could be the device, so neither is named.
		expect(
			pick(
				[
					obs("burst", CENTRE + 40_000, { endedAt: 1_800 }),
					obs("carrier", CENTRE + 100_000, { endedAt: undefined }),
				],
				1_850,
			),
		).toBeNull()
	})

	it("names the single qualifying one when others are out of passband or time", () => {
		expect(
			pick([
				obs("in", CENTRE + 40_000),
				obs("out", CENTRE + HALF + 1),
				obs("late", CENTRE, { startedAt: 9_000, endedAt: 9_500 }),
				obs("other", CENTRE, { sourceId: "x" }),
			])?.observationId,
		).toBe("in")
	})

	// Feature: rtl433-channel-association, Property 1: a channel decode names an observation exactly when one qualifies, and then that one
	// Validates: rtl433 channel association, exactly-one rule
	it("names an observation exactly when one qualifies", () => {
		const cand = fc.record({
			off: fc.integer({ min: -2 * HALF, max: 2 * HALF }),
			start: fc.integer({ min: -3_000, max: 6_000 }),
			len: fc.integer({ min: 0, max: 2_000 }),
			other: fc.boolean(),
		})
		fc.assert(
			fc.property(fc.array(cand, { maxLength: 6 }), cs => {
				const list = cs.map((c, i) =>
					obs(`o${i}`, CENTRE + c.off, {
						startedAt: c.start,
						endedAt: c.start + c.len,
						sourceId: c.other ? "x" : "rtl",
					}),
				)
				const qualifying = list.filter(
					o =>
						o.sourceId === "rtl" &&
						Math.abs(o.lastTrack!.centreHz - CENTRE) <= HALF &&
						1_500 >= o.startedAt - 2_000 &&
						1_500 <= o.endedAt! + 2_000,
				)
				const got = pick(list)
				expect(got).toBe(qualifying.length === 1 ? qualifying[0] : null)
			}),
			{ numRuns: 200 },
		)
	})
})

describe("channelPassbandOf", () => {
	it("reads the binding and halves the bandwidth", () => {
		expect(
			channelPassbandOf({ sourceId: "rtl", channelHz: CENTRE }, 2 * HALF),
		).toEqual({ sourceId: "rtl", centreHz: CENTRE, halfHz: HALF })
	})

	it("is null on a malformed binding or bandwidth", () => {
		for (const [binding, bw] of [
			[undefined, 1],
			[{ sourceId: "rtl", channelHz: null }, 1],
			[{ sourceId: "", channelHz: CENTRE }, 1],
			[{ sourceId: "rtl", channelHz: -1 }, 1],
			[{ sourceId: "rtl", channelHz: CENTRE }, 0],
			[{ sourceId: "rtl", channelHz: CENTRE }, Number.NaN],
			[{ sourceId: "rtl", channelHz: CENTRE }, "1"],
		] as const)
			expect(channelPassbandOf(binding, bw)).toBeNull()
	})

	it("accepts a half passband at the bound and refuses one past it", () => {
		const binding = { sourceId: "rtl", channelHz: CENTRE }
		expect(
			channelPassbandOf(binding, 2 * AMBIENT_CHANNEL_MAX_HALF_HZ)?.halfHz,
		).toBe(1_600_000)
		expect(
			channelPassbandOf(binding, 2 * AMBIENT_CHANNEL_MAX_HALF_HZ + 2),
		).toBeNull()
	})
})

const device = (model: unknown, extra: Record<string, unknown> = {}) => ({
	type: "signal",
	timestamp: new Date(5_000),
	data: { model, id: 42, mic: "CRC", ...extra },
})
const twice = (out: ReturnType<typeof device>) => {
	const state = createInterpreterState({
		epoch: 1,
		origin: "ambient",
		decoderId: "rtl433",
	})
	interpretRtl433(out, state)
	return interpretRtl433(out, state)
}

describe("interpretRtl433 model validation", () => {
	it("names the rtl_433 model on the second checksummed decode", () => {
		expect(twice(device("Acurite-Tower"))[0]).toMatchObject({
			protocol: "ism",
			identity: { kind: "ism-model", value: "Acurite-Tower:42" },
			metadata: { ismModels: ["Acurite-Tower"] },
		})
	})

	it("accepts a model at the length bound and refuses one past it", () => {
		expect(twice(device("M".repeat(RTL433_MODEL_MAX_CHARS)))).toHaveLength(1)
		expect(twice(device("M".repeat(RTL433_MODEL_MAX_CHARS + 1)))).toEqual([])
	})

	it("bounds the id and mic at the field bound", () => {
		const at = "x".repeat(RTL433_FIELD_MAX_CHARS)
		const past = "x".repeat(RTL433_FIELD_MAX_CHARS + 1)
		expect(twice(device("Ok", { id: at, mic: at }))).toHaveLength(1)
		expect(twice(device("Ok", { id: past }))).toEqual([])
		expect(twice(device("Ok", { mic: past }))).toEqual([])
	})

	it("gives no evidence for a malformed model", () => {
		for (const model of [undefined, 7, "", " lead", "trail ", "ctl\u0007", "é"])
			expect(twice(device(model))).toEqual([])
		expect(twice(device("Ok", { id: Number.POSITIVE_INFINITY }))).toEqual([])
		expect(twice(device("Ok", { mic: undefined }))).toEqual([])
	})
})

describe("AmbientEvidence rtl433 channel", () => {
	const setup = (
		bandwidthHz: number | undefined,
		sampleRateHz: number | undefined = 960_000,
	) => {
		const rates: number[] = []
		const dec = Object.assign(new EventEmitter(), {
			getChannelRequest: (input: { sampleRateHz: number }) =>
				rates.push(input.sampleRateHz) && bandwidthHz === undefined
					? { invalid: "none" }
					: {
							centerHz: CENTRE,
							bandwidthHz,
							transitionHz: 1,
							outputRateHz: 1,
							format: "cu8" as const,
						},
		})
		const decoders = Object.assign(new EventEmitter(), {
			getAllStatus: () => [
				{ id: "rtl433", type: "rtl433", sourceId: "rtl", owner: "config" },
			],
			getDecoder: () => dec,
		})
		const ambient = new AmbientEvidence({
			decoders: decoders as never,
			targetOf: () => ({
				sourceId: "rtl",
				hz: 433_900_000,
				targetsHz: [433_900_000],
				external: false,
			}),
			epochOf: () => 1,
			logger: pino({ level: "silent" }),
			sampleRateOf: () => sampleRateHz,
		})
		const got: AmbientEvidenceEvent[] = []
		ambient.on("evidence", (e: AmbientEvidenceEvent) => got.push(e))
		ambient.start()
		const emit = (binding: unknown) => {
			const out = device("Acurite-Tower")
			Object.defineProperty(out, "provenanceBinding", { value: binding })
			decoders.emit("decoder:output", "rtl433", out)
		}
		return { got, emit, ambient, rates }
	}

	it("stamps the channel centre and passband from the placement binding", () => {
		const { got, emit, ambient, rates } = setup(2 * HALF)
		emit({ sourceId: "rtl", channelHz: CENTRE })
		emit({ sourceId: "rtl", channelHz: CENTRE })
		ambient.stop()
		expect(got).toHaveLength(1)
		expect(got[0]).toMatchObject({ hz: CENTRE, passband })
		// The channel request sees the capture rate of the source.
		expect(rates).toEqual([960_000, 960_000])
	})

	it("keeps the point target only for an unplaced instance", () => {
		const { got, emit, ambient } = setup(2 * HALF)
		emit(undefined)
		emit(undefined)
		ambient.stop()
		expect(got).toHaveLength(1)
		expect(got[0]!.hz).toBe(433_900_000)
		expect(got[0]!.passband).toBeUndefined()
	})

	it("drops a placed decode whose binding or channel is unusable", () => {
		const good = { sourceId: "rtl", channelHz: CENTRE }
		for (const [binding, bw, rate] of [
			[{ sourceId: "other", channelHz: CENTRE }, 2 * HALF, 960_000],
			[{ sourceId: "rtl", channelHz: "x" }, 2 * HALF, 960_000],
			[null, 2 * HALF, 960_000],
			[good, undefined, 960_000],
			[good, 2 * HALF, Number.NaN],
			[good, 2 * HALF, 0],
		] as const) {
			const { got, emit, ambient } = setup(bw, rate)
			emit(binding)
			emit(binding)
			emit(binding)
			ambient.stop()
			expect(got).toEqual([])
		}
	})

	it("a dropped placed output never primes acceptance", () => {
		const good = { sourceId: "rtl", channelHz: CENTRE }
		for (const rejected of [
			{ sourceId: "other", channelHz: CENTRE },
			{ sourceId: "rtl", channelHz: "x" },
		]) {
			const { got, emit, ambient } = setup(2 * HALF)
			emit(rejected)
			// One valid decode alone is not the second checksummed occurrence.
			emit(good)
			expect(got).toEqual([])
			emit(good)
			ambient.stop()
			expect(got).toHaveLength(1)
		}
	})
})

describe("rtl_433 frequency estimate", () => {
	const at = (freqHz: number | undefined, list: ChannelCandidate[]) =>
		pickChannelObservation(
			list,
			{ sourceId: "rtl", passband, at: 1_500, freqHz },
			10_000,
			2_000,
		)
	// Track bandwidth 10 kHz: the tolerance is 60 kHz + 5 kHz.
	const tol = RTL433_FREQ_TOLERANCE_HZ + 5_000

	it("names the one track within tolerance of the estimate among several in the passband", () => {
		const list = [obs("a", CENTRE - 100_000), obs("b", CENTRE + 100_000)]
		expect(at(undefined, list)).toBeNull()
		expect(at(CENTRE + 100_000 + tol, list)?.observationId).toBe("b")
		expect(at(CENTRE - 100_000 - tol, list)?.observationId).toBe("a")
	})

	it("names nothing out of tolerance or when two tracks are within it", () => {
		expect(at(CENTRE + tol + 1, [obs("a", CENTRE)])).toBeNull()
		expect(
			at(CENTRE, [obs("a", CENTRE - 20_000), obs("b", CENTRE + 20_000)]),
		).toBeNull()
	})

	it("reads a usable estimate and ignores a malformed or edge one", () => {
		const usable = HALF * 0.8
		expect(rtl433FreqHz({ freq: (CENTRE + usable) / 1e6 }, passband)).toBe(
			CENTRE + usable,
		)
		for (const data of [
			{ freq: (CENTRE + usable + 1_000) / 1e6 },
			{ freq: "433.7" },
			{ freq: Number.NaN },
			{ freq: -1 },
			{ freq: 7_000 },
			{},
			null,
			"x",
		])
			expect(rtl433FreqHz(data, passband)).toBeUndefined()
	})
})

describe("windowPassbandOf", () => {
	const binding = { sourceId: "rtl", channelHz: null }
	it("is the whole capture", () => {
		expect(
			windowPassbandOf(binding, { centreHz: CENTRE, sampleRateHz: 960_000 }),
		).toEqual({ sourceId: "rtl", centreHz: CENTRE, halfHz: 480_000 })
	})
	it("refuses malformed captures and bindings, and a half width past the bound", () => {
		for (const capture of [
			{ centreHz: undefined, sampleRateHz: 960_000 },
			{ centreHz: CENTRE, sampleRateHz: 0 },
			{ centreHz: CENTRE, sampleRateHz: Number.NaN },
			{ centreHz: CENTRE, sampleRateHz: 2 * AMBIENT_CHANNEL_MAX_HALF_HZ + 2 },
		])
			expect(windowPassbandOf(binding, capture)).toBeNull()
		expect(
			windowPassbandOf(
				{ sourceId: "rtl", channelHz: CENTRE },
				{ centreHz: CENTRE, sampleRateHz: 960_000 },
			),
		).toBeNull()
		expect(
			windowPassbandOf(binding, {
				centreHz: CENTRE,
				sampleRateHz: 2 * AMBIENT_CHANNEL_MAX_HALF_HZ,
			}),
		).not.toBeNull()
	})
})

describe("AmbientEvidence rtl433 window reach", () => {
	it("stamps the capture passband and rtl_433's estimate for a window placement", () => {
		const decoders = Object.assign(new EventEmitter(), {
			getAllStatus: () => [
				{ id: "rtl433", type: "rtl433", sourceId: "rtl", owner: "config" },
			],
			getDecoder: () => new EventEmitter(),
		})
		const ambient = new AmbientEvidence({
			decoders: decoders as never,
			targetOf: () => ({
				sourceId: "rtl",
				hz: CENTRE,
				targetsHz: [CENTRE],
				external: false,
			}),
			epochOf: () => 1,
			logger: pino({ level: "silent" }),
			sampleRateOf: () => 960_000,
			centreOf: () => CENTRE,
		})
		const got: AmbientEvidenceEvent[] = []
		ambient.on("evidence", (e: AmbientEvidenceEvent) => got.push(e))
		ambient.start()
		for (let i = 0; i < 2; i++) {
			const out = device("Acurite-Tower", { freq: (CENTRE + 120_000) / 1e6 })
			Object.defineProperty(out, "provenanceBinding", {
				value: { sourceId: "rtl", channelHz: null },
			})
			decoders.emit("decoder:output", "rtl433", out)
		}
		ambient.stop()
		expect(got).toHaveLength(1)
		expect(got[0]).toMatchObject({
			hz: CENTRE,
			passband: { centreHz: CENTRE, halfHz: 480_000 },
			freqHz: CENTRE + 120_000,
		})
	})
})
