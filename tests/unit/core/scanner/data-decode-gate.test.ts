/**
 * Detection quality R4: the data decode gate withholds a closed analog
 * transmission from Activity when a same-source paging/APRS decode on a trusted
 * channel matches it, and publishes everything else as today.
 */
import { EventEmitter } from "node:events"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import fc from "fast-check"
import type { AnalogTransmissionPayload } from "@wavekit/api-types"
import type { DecodeEnvelope } from "../../../../src/core/activity/types.js"
import {
	DQ_DATA_FREQ_HZ,
	DQ_DATA_HELD_MAX,
	DQ_DATA_HOLD_MS,
	DQ_DATA_RATE_PER_S,
	DQ_DATA_RING,
	DQ_DATA_WINDOW_MS,
	createDataDecodeGate,
} from "../../../../src/core/scanner/data-decode-gate.js"
import type {
	DataDecodeClose,
	DataDecodeGate,
} from "../../../../src/core/scanner/data-decode-gate.js"
import { wireAnalogTransmissions } from "../../../../src/core/analog-transmission.js"
import type { AnalogTransmissionSource } from "../../../../src/core/analog-transmission.js"
import { createAnalogEvidenceLog } from "../../../../src/core/scanner/analog-evidence.js"
import { createLiveAudioEvidence } from "../../../../src/core/scanner/live-audio-evidence.js"
import { labelFromEvidence } from "../../../../src/core/scanner/classify/label-from-evidence.js"
import type {
	ProofAnalogInput,
	ProofInput,
} from "../../../../src/core/scanner/scanner-redesign-contract.js"
import type {
	Discovery,
	Observation,
} from "../../../../src/core/scanner/types.js"
import type { Logger } from "../../../../src/utils/logger.js"

const HZ = 439_987_500
const T0 = Date.parse("2026-10-25T10:00:00.000Z")
const A = "rtl-a"
const B = "rtl-b"

const iso = (ms: number): string => new Date(ms).toISOString()

/** A pager burst closed as an NFM transmission: 1.6 to 2.1 s, -29 dBFS peak. */
function burst(
	startMs: number,
	durationMs: number,
	over: Partial<AnalogTransmissionPayload> = {},
): AnalogTransmissionPayload {
	return {
		transmissionId: `tx-${startMs}`,
		sourceId: A,
		startedAt: iso(startMs),
		endedAt: iso(startMs + durationMs),
		durationMs,
		frequency: { hz: HZ, tuningTrust: "commanded" },
		modulation: "nfm",
		bandwidthHz: 12_500,
		squelchMode: "manual",
		thresholdDbfs: -45,
		peakChannelPowerDbfs: -29,
		meanChannelPowerDbfs: -30,
		closeReason: "squelch",
		...over,
	}
}

interface EnvOpts {
	sourceId?: string | null
	hz?: number
	basis?: "channel" | "probe"
	trust?: "commanded" | "relay" | "unverified"
	category?: DecodeEnvelope["category"]
	noFrequency?: boolean
	noProvenance?: boolean
}

function pagingDecode(atMs: number, o: EnvOpts = {}): DecodeEnvelope {
	const env = {
		version: 1,
		eventId: `e-${atMs}-${Math.random()}`,
		producedAt: iso(atMs),
		receivedAt: iso(atMs),
		decoderId: "pocsag",
		outputType: "pocsag",
		protocol: "pocsag",
		category: o.category ?? "paging",
		entityKey: null,
		title: null,
		fields: [],
		provenance: {
			sourceId: o.sourceId === undefined ? A : o.sourceId,
			frequency: o.noFrequency
				? null
				: {
						hz: o.hz ?? HZ,
						basis: o.basis ?? "channel",
						tuningTrust: o.trust ?? "commanded",
					},
		},
		decodedData: null,
	} as DecodeEnvelope
	if (o.noProvenance)
		(env as unknown as { provenance: undefined }).provenance = undefined
	return env
}

/** Runs one close with optional decodes; returns the delivered decision. */
function decide(
	gate: DataDecodeGate,
	close: DataDecodeClose,
	decodes: DecodeEnvelope[],
): boolean[] {
	const out: boolean[] = []
	gate.hold(close, d => out.push(d))
	for (const env of decodes) gate.noteEnvelope(env)
	vi.advanceTimersByTime(DQ_DATA_HOLD_MS)
	return out
}

beforeEach(() => {
	vi.useFakeTimers()
	vi.setSystemTime(T0)
})
afterEach(() => {
	vi.useRealTimers()
})

describe("data decode gate fixtures", () => {
	it("pager: bursts of 1.6 s and 2.1 s with a decode within 1 s are data", () => {
		const gate = createDataDecodeGate()
		for (const [i, dur] of [1_600, 2_100].entries()) {
			const start = T0 + i * 300_000
			vi.setSystemTime(start + dur)
			const out = decide(gate, burst(start, dur), [
				pagingDecode(start + dur + 400 * (i + 1)),
			])
			expect(out).toEqual([true])
		}
	})

	it("voice with no decode publishes after the hold, not before", () => {
		const gate = createDataDecodeGate()
		const out: boolean[] = []
		gate.hold(burst(T0, 4_000), d => out.push(d))
		vi.advanceTimersByTime(DQ_DATA_HOLD_MS - 1)
		expect(out).toEqual([])
		vi.advanceTimersByTime(1)
		expect(out).toEqual([false])
	})

	it("two sources: a decode reported by B does not suppress A", () => {
		const gate = createDataDecodeGate()
		expect(
			decide(gate, burst(T0, 1_600), [
				pagingDecode(T0 + 1_800, { sourceId: B }),
			]),
		).toEqual([false])
	})

	it.each<[string, EnvOpts, number]>([
		["2 kHz away", { hz: HZ + 2_000 }, 1_800],
		["1.5 s after close", {}, 1_600 + 1_500],
		["probe basis", { basis: "probe" }, 1_800],
		["unverified trust", { trust: "unverified" }, 1_800],
		["missing source", { sourceId: null }, 1_800],
		["no frequency", { noFrequency: true }, 1_800],
		["no provenance", { noProvenance: true }, 1_800],
		["voice category", { category: "voice" }, 1_800],
	])("control: %s publishes", (_name, o, at) => {
		const gate = createDataDecodeGate()
		expect(decide(gate, burst(T0, 1_600), [pagingDecode(at, o)])).toEqual([
			false,
		])
	})

	it("relay trust and aprs category match", () => {
		const gate = createDataDecodeGate()
		expect(
			decide(gate, burst(T0, 1_600), [
				pagingDecode(T0 + 1_700, { trust: "relay", category: "aprs" }),
			]),
		).toEqual([true])
	})

	it("a close with null frequency or an empty source delivers at once", () => {
		const gate = createDataDecodeGate()
		const out: boolean[] = []
		gate.hold(burst(T0, 1_600, { frequency: null }), d => out.push(d))
		gate.hold({ ...burst(T0, 1_600), sourceId: "" }, d => out.push(d))
		expect(out).toEqual([false, false])
	})
})

describe("data decode gate boundaries", () => {
	it.each<[string, number, number, boolean]>([
		["+1250 Hz", DQ_DATA_FREQ_HZ, 1_800, true],
		["-1250 Hz", -DQ_DATA_FREQ_HZ, 1_800, true],
		["+1251 Hz", DQ_DATA_FREQ_HZ + 1, 1_800, false],
		["-1251 Hz", -DQ_DATA_FREQ_HZ - 1, 1_800, false],
		["start - 1 s", 0, -DQ_DATA_WINDOW_MS, true],
		["start - 1.001 s", 0, -DQ_DATA_WINDOW_MS - 1, false],
		["end + 1 s", 0, 1_600 + DQ_DATA_WINDOW_MS, true],
		["end + 1.001 s", 0, 1_600 + DQ_DATA_WINDOW_MS + 1, false],
	])("%s", (_name, dHz, dt, expected) => {
		const gate = createDataDecodeGate()
		expect(
			decide(gate, burst(T0, 1_600), [pagingDecode(T0 + dt, { hz: HZ + dHz })]),
		).toEqual([expected])
	})
})

describe("data decode gate caps", () => {
	it("the ninth held close publishes immediately and is counted", () => {
		const gate = createDataDecodeGate()
		const out: [number, boolean][] = []
		for (let i = 0; i <= DQ_DATA_HELD_MAX; i++)
			gate.hold(burst(T0 + i, 1_600), d => out.push([i, d]))
		expect(out).toEqual([[DQ_DATA_HELD_MAX, false]])
		expect(gate.stats().heldOverflow).toBe(1)
		gate.noteEnvelope(pagingDecode(T0 + 1_700))
		vi.advanceTimersByTime(DQ_DATA_HOLD_MS)
		expect(out).toHaveLength(DQ_DATA_HELD_MAX + 1)
		expect(out.slice(1).every(([, d]) => d)).toBe(true)
	})

	it("20 receptions in 1 s from one source: 16 kept, 4 dropped; another source is not capped", () => {
		const gate = createDataDecodeGate()
		for (let i = 0; i < 20; i++)
			gate.noteEnvelope(pagingDecode(T0 + i, { hz: HZ + 10_000 }))
		expect(gate.stats().dropped).toBe(20 - DQ_DATA_RATE_PER_S)
		gate.noteEnvelope(pagingDecode(T0 + 21, { sourceId: B }))
		expect(gate.stats().dropped).toBe(4)
		// Source B has its own budget, so its decode is retained and matches.
		expect(decide(gate, burst(T0, 1_600, { sourceId: B }), [])).toEqual([true])
	})

	it("the 17th reception in a second is dropped, the next second admits again", () => {
		const gate = createDataDecodeGate()
		for (let i = 0; i < DQ_DATA_RATE_PER_S; i++)
			gate.noteEnvelope(pagingDecode(T0, { hz: HZ + 10_000 }))
		gate.noteEnvelope(pagingDecode(T0 + 1_700))
		expect(gate.stats().dropped).toBe(1)
		expect(decide(gate, burst(T0, 1_600), [])).toEqual([false])
		vi.setSystemTime(T0 + 5_000)
		expect(
			decide(gate, burst(T0 + 4_000, 500), [pagingDecode(T0 + 4_600)]),
		).toEqual([true])
	})

	it("the 257th decode overwrites the oldest: a match lost to the ring publishes", () => {
		const gate = createDataDecodeGate()
		gate.noteEnvelope(pagingDecode(T0 + 1_700))
		for (let i = 1; i <= DQ_DATA_RING; i++) {
			vi.setSystemTime(T0 + i * 1_000)
			gate.noteEnvelope(pagingDecode(T0 + i * 1_000, { hz: HZ + 50_000 }))
		}
		expect(gate.stats().dropped).toBe(0)
		expect(decide(gate, burst(T0, 1_600), [])).toEqual([false])
		// With 256 only, the first is still retained.
		const kept = createDataDecodeGate()
		kept.noteEnvelope(pagingDecode(T0 + 1_700))
		for (let i = 1; i < DQ_DATA_RING; i++) {
			vi.setSystemTime(T0 + i * 1_000)
			kept.noteEnvelope(pagingDecode(T0 + i * 1_000, { hz: HZ + 50_000 }))
		}
		expect(decide(kept, burst(T0, 1_600), [])).toEqual([true])
	})

	it("stop delivers held closes as not-data, once; later holds deliver at once", () => {
		const gate = createDataDecodeGate()
		const out: boolean[] = []
		gate.hold(burst(T0, 1_600), d => out.push(d))
		gate.noteEnvelope(pagingDecode(T0 + 1_700))
		gate.stop()
		vi.advanceTimersByTime(DQ_DATA_HOLD_MS * 2)
		expect(out).toEqual([false])
		gate.hold(burst(T0, 1_600), d => out.push(d))
		expect(out).toEqual([false, false])
	})

	it("two holds of one transmission share a slot and both deliver", () => {
		const gate = createDataDecodeGate()
		const out: string[] = []
		const tx = burst(T0, 1_600)
		gate.hold(tx, d => out.push(`a${d}`))
		gate.hold(tx, d => out.push(`b${d}`))
		for (let i = 1; i < DQ_DATA_HELD_MAX; i++)
			gate.hold(burst(T0 + i, 1_600), () => undefined)
		expect(gate.stats().heldOverflow).toBe(0)
		gate.noteEnvelope(pagingDecode(T0 + 1_700))
		vi.advanceTimersByTime(DQ_DATA_HOLD_MS)
		expect(out).toEqual(["atrue", "btrue"])
	})

	it("a throwing consumer or envelope does not break the gate", () => {
		const gate = createDataDecodeGate()
		const hostile = {
			get category(): never {
				throw new Error("x")
			},
		} as unknown as DecodeEnvelope
		expect(() => gate.noteEnvelope(hostile)).not.toThrow()
		gate.hold(burst(T0, 1_600), () => {
			throw new Error("consumer")
		})
		expect(() => vi.advanceTimersByTime(DQ_DATA_HOLD_MS)).not.toThrow()
	})
})

describe("data decode gate property", () => {
	it("never suppresses without a same-source matching decode, and delivers each close once", () => {
		// Feature: detection-quality, Property 11: Data suppression
		// Validates: Requirements 4.1, 4.3, 4.5, 4.6
		const sources = [A, B]
		const decodeArb = fc.record({
			source: fc.constantFrom<string | null>(A, B, null),
			dHz: fc.integer({ min: -3_000, max: 3_000 }),
			dt: fc.integer({ min: -3_000, max: 6_000 }),
			basis: fc.constantFrom<"channel" | "probe">("channel", "probe"),
			trust: fc.constantFrom<"commanded" | "relay" | "unverified">(
				"commanded",
				"relay",
				"unverified",
			),
			category: fc.constantFrom<DecodeEnvelope["category"]>(
				"paging",
				"aprs",
				"voice",
			),
		})
		const closeArb = fc.record({
			source: fc.constantFrom(...sources),
			dHz: fc.integer({ min: -2_000, max: 2_000 }),
			start: fc.integer({ min: 0, max: 2_000 }),
			dur: fc.integer({ min: 500, max: 3_000 }),
		})
		fc.assert(
			fc.property(
				fc.array(closeArb, { minLength: 1, maxLength: 12 }),
				fc.array(decodeArb, { maxLength: 30 }),
				(closes, decodes) => {
					vi.setSystemTime(T0)
					const gate = createDataDecodeGate()
					const delivered = closes.map(() => [] as boolean[])
					closes.forEach((c, i) => {
						gate.hold(
							burst(T0 + c.start, c.dur, {
								transmissionId: `p${i}`,
								sourceId: c.source,
								frequency: { hz: HZ + c.dHz, tuningTrust: "commanded" },
							}),
							d => delivered[i]?.push(d),
						)
					})
					for (const d of decodes)
						gate.noteEnvelope(
							pagingDecode(T0 + d.dt, {
								sourceId: d.source,
								hz: HZ + d.dHz,
								basis: d.basis,
								trust: d.trust,
								category: d.category,
							}),
						)
					vi.advanceTimersByTime(DQ_DATA_HOLD_MS)
					gate.stop()
					closes.forEach((c, i) => {
						const out = delivered[i] ?? []
						expect(out).toHaveLength(1)
						const held = i < DQ_DATA_HELD_MAX
						const match = decodes.some(
							d =>
								d.source === c.source &&
								d.basis === "channel" &&
								d.trust !== "unverified" &&
								d.category !== "voice" &&
								Math.abs(d.dHz - c.dHz) <= DQ_DATA_FREQ_HZ &&
								d.dt >= c.start - DQ_DATA_WINDOW_MS &&
								d.dt <= c.start + c.dur + DQ_DATA_WINDOW_MS,
						)
						// Rate-dropped decodes are never retained; only retained matches
						// can suppress, so suppression implies a same-source match.
						if (out[0] === true) expect(held && match).toBe(true)
						if (!held) expect(out[0]).toBe(false)
					})
				},
			),
			{ numRuns: 200 },
		)
	})
})

class FakeSource extends EventEmitter {
	getStatus(): unknown {
		return {
			enabled: true,
			running: true,
			sourceId: A,
			config: { modulation: "nfm", bandwidth: 12_500, sourceId: A },
			squelchOpen: false,
			thresholdDbfs: -45,
		}
	}
	isSquelchOpen(): boolean {
		return false
	}
	squelchHangMs(): number {
		return 250
	}
}

describe("wireAnalogTransmissions with the data gate", () => {
	function wire(gate?: DataDecodeGate) {
		const rows: AnalogTransmissionPayload[] = []
		const tracker = wireAnalogTransmissions({
			source: new FakeSource() as unknown as AnalogTransmissionSource,
			frequencyAt: () => ({ hz: HZ, tuningTrust: "commanded" }),
			broadcast: () => undefined,
			sink: () => p => rows.push(p),
			...(gate ? { dataGate: gate } : {}),
		})
		return { rows, tracker }
	}

	it("pager burst with a matching decode: no analog-transmission row", () => {
		const gate = createDataDecodeGate()
		const { rows, tracker } = wire(gate)
		tracker.emit("closed", burst(T0, 2_100))
		gate.noteEnvelope(pagingDecode(T0 + 2_600))
		vi.advanceTimersByTime(DQ_DATA_HOLD_MS)
		expect(rows).toEqual([])
		tracker.stop()
	})

	it("voice over with no decode: one row after the hold", () => {
		const gate = createDataDecodeGate()
		const { rows, tracker } = wire(gate)
		tracker.emit("closed", burst(T0, 3_000))
		expect(rows).toEqual([])
		vi.advanceTimersByTime(DQ_DATA_HOLD_MS)
		expect(rows).toHaveLength(1)
		tracker.stop()
	})

	it("without a gate the row is published at close as before", () => {
		const { rows, tracker } = wire()
		tracker.emit("closed", burst(T0, 2_100))
		expect(rows).toHaveLength(1)
		tracker.stop()
	})
})

describe("live evidence data flag (DQ.10)", () => {
	function proofFor(data: boolean): ProofInput {
		vi.useRealTimers()
		const recorded: ProofAnalogInput[] = []
		const now = Date.now()
		const log = createAnalogEvidenceLog({ monitoring: () => false })
		const disc = {
			id: "d1",
			frequencyHz: HZ,
			sourceIds: [A],
		} as unknown as Discovery
		const obs = {
			id: "o1",
			discoveryId: "d1",
			sourceId: A,
			startedAt: iso(now - 5_000),
			endedAt: iso(now),
		} as unknown as Observation
		const child = { warn: vi.fn(), child: () => child }
		const evidence = createLiveAudioEvidence({
			store: {
				near: () => [disc],
				observations: () => ({ items: [obs], nextCursor: null }),
				recordAnalog: (_id: string, a: ProofAnalogInput) => {
					recorded.push(a)
					return true
				},
			} as unknown as Parameters<typeof createLiveAudioEvidence>[0]["store"],
			analogLog: log,
			trust: () => "commanded",
			logger: child as unknown as Logger,
		})
		evidence.start()
		const closed = {
			...burst(now - 3_000, 2_000),
			state: "closed",
			level: null,
		}
		log.record({
			...(closed as unknown as Parameters<typeof log.record>[0]),
			...(data ? { data: true } : {}),
		})
		evidence.stop()
		return {
			observationId: "o1",
			decodes: [],
			trials: [],
			analog: recorded,
			unavailable: [],
			trust: "commanded",
			digitalPlanComplete: false,
		}
	}

	it("a voice transmission gives an analog-fm candidate", () => {
		const proof = proofFor(false)
		expect(proof.analog).toHaveLength(1)
		expect(labelFromEvidence(proof).protocol).toBe("analog-fm")
	})

	it("a data transmission attaches no analog proof and no analog-fm label", () => {
		const proof = proofFor(true)
		expect(proof.analog).toEqual([])
		expect(labelFromEvidence(proof).protocol).not.toBe("analog-fm")
	})
})
