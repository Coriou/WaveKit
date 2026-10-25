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
	channelPassbandOf,
	pickChannelObservation,
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
	peakDbfs = -30,
): ChannelCandidate => ({
	observationId: id,
	sourceId: "rtl",
	startedAt: 1_000,
	endedAt: 2_000,
	lastActivityAt: 2_000,
	lastTrack: { centreHz: hz, peakDbfs },
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

	it("prefers the most recent, then the strongest, then the smaller id", () => {
		expect(
			pick([
				obs("old", CENTRE, { lastActivityAt: 1_800 }, -10),
				obs("new", CENTRE + 1_000, { lastActivityAt: 1_900 }, -40),
			])?.observationId,
		).toBe("new")
		expect(
			pick([obs("weak", CENTRE, {}, -40), obs("strong", CENTRE, {}, -20)])
				?.observationId,
		).toBe("strong")
		expect(pick([obs("b", CENTRE), obs("a", CENTRE)])?.observationId).toBe("a")
	})

	// Feature: rtl433-channel-association, Property 1: a pick lies in the passband and beats every other in-passband candidate
	// Validates: channel-granular association rule
	it("picks only in-passband candidates and the best of them", () => {
		const cand = fc.record({
			off: fc.integer({ min: -2 * HALF, max: 2 * HALF }),
			act: fc.integer({ min: 1_000, max: 2_000 }),
			peak: fc.integer({ min: -90, max: 0 }),
		})
		fc.assert(
			fc.property(fc.array(cand, { maxLength: 8 }), cs => {
				const list = cs.map((c, i) =>
					obs(`o${i}`, CENTRE + c.off, { lastActivityAt: c.act }, c.peak),
				)
				const inside = list.filter(
					o => Math.abs(o.lastTrack!.centreHz - CENTRE) <= HALF,
				)
				const got = pick(list)
				if (inside.length === 0) {
					expect(got).toBeNull()
					return
				}
				expect(got).not.toBeNull()
				expect(inside).toContain(got)
				for (const o of inside) {
					expect(o.lastActivityAt <= got!.lastActivityAt).toBe(true)
					if (o.lastActivityAt === got!.lastActivityAt)
						expect(o.lastTrack!.peakDbfs <= got!.lastTrack!.peakDbfs).toBe(true)
				}
			}),
			{ numRuns: 100 },
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
	const setup = (bandwidthHz: number | undefined) => {
		const dec = Object.assign(new EventEmitter(), {
			getChannelRequest: () =>
				bandwidthHz === undefined
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
		})
		const got: AmbientEvidenceEvent[] = []
		ambient.on("evidence", (e: AmbientEvidenceEvent) => got.push(e))
		ambient.start()
		const emit = (binding: unknown) => {
			const out = device("Acurite-Tower")
			Object.defineProperty(out, "provenanceBinding", { value: binding })
			decoders.emit("decoder:output", "rtl433", out)
		}
		return { got, emit, ambient }
	}

	it("stamps the channel centre and passband from the placement binding", () => {
		const { got, emit, ambient } = setup(2 * HALF)
		emit({ sourceId: "rtl", channelHz: CENTRE })
		emit({ sourceId: "rtl", channelHz: CENTRE })
		ambient.stop()
		expect(got).toHaveLength(1)
		expect(got[0]).toMatchObject({ hz: CENTRE, passband })
	})

	it("keeps the decoder target without a usable binding", () => {
		for (const binding of [
			undefined,
			{ sourceId: "other", channelHz: CENTRE },
		]) {
			const { got, emit, ambient } = setup(2 * HALF)
			emit(binding)
			emit(binding)
			ambient.stop()
			expect(got).toHaveLength(1)
			expect(got[0]!.hz).toBe(433_900_000)
			expect(got[0]!.passband).toBeUndefined()
		}
		const { got, emit, ambient } = setup(undefined)
		emit({ sourceId: "rtl", channelHz: CENTRE })
		emit({ sourceId: "rtl", channelHz: CENTRE })
		ambient.stop()
		expect(got[0]!.passband).toBeUndefined()
	})
})
