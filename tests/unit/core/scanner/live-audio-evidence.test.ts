/**
 * WG12 req 6.3: closed live-audio transmissions attach analog evidence to the
 * nearest existing discovery's overlapping observation. Nothing is created.
 */
import { describe, expect, it, vi } from "vitest"
import {
	DCS_STANDARD_CODES,
	DISCOVERY_NEAR_DEFAULT_TOLERANCE_HZ,
} from "@wavekit/api-types"
import type { AnalogTransmissionEventData } from "@wavekit/api-types"
import { createAnalogEvidenceLog } from "../../../../src/core/scanner/analog-evidence.js"
import { createLiveAudioEvidence } from "../../../../src/core/scanner/live-audio-evidence.js"
import type { AnalogEvidenceTransmission } from "../../../../src/core/scanner/identify-analog-contract.js"
import type { ProofAnalogInput } from "../../../../src/core/scanner/scanner-redesign-contract.js"
import type {
	Discovery,
	Observation,
} from "../../../../src/core/scanner/types.js"
import type { TuningTrust } from "../../../../src/core/spectrum/types.js"
import type { Logger } from "../../../../src/utils/logger.js"

const HZ = 446_006_250
const T0 = Date.parse("2026-10-17T10:00:00.000Z")
const SOURCE = "rtl"

function iso(ms: number): string {
	return new Date(ms).toISOString()
}

function transmission(
	over: Partial<AnalogEvidenceTransmission> = {},
): AnalogEvidenceTransmission {
	return {
		transmissionId: "tx1",
		sourceId: SOURCE,
		startedAtMs: T0,
		endedAtMs: T0 + 2_000,
		hz: HZ,
		tuningTrust: "commanded",
		modulation: "nfm",
		ctcssHz: 88.5,
		dcs: null,
		...over,
	}
}

function discovery(over: Partial<Discovery> = {}): Discovery {
	return {
		id: "d_near",
		frequencyHz: HZ,
		sourceIds: [SOURCE],
		...over,
	} as unknown as Discovery
}

function observation(
	over: Partial<Omit<Observation, "endedAt">> & {
		endedAt?: string | undefined
	} = {},
): Observation {
	return {
		id: "o_1",
		discoveryId: "d_near",
		sourceId: SOURCE,
		startedAt: iso(T0 - 100),
		endedAt: iso(T0 + 2_100),
		...over,
	} as unknown as Observation
}

interface StoreOpts {
	discoveries?: Discovery[]
	observations?: Observation[]
	near?: (hz: number, toleranceHz: number, sourceId?: string) => Discovery[]
	observationsOf?: (
		discoveryId: string,
		cursor: string | null,
		limit: number,
	) => { items: Observation[]; nextCursor: string | null }
	recordAnalog?: (observationId: string, analog: ProofAnalogInput) => boolean
}

function harness(opts: {
	trust?: TuningTrust | "throw" | "unknown"
	eventTrust?: TuningTrust
	store?: StoreOpts
	closed?: AnalogEvidenceTransmission[]
}) {
	const recorded: { observationId: string; analog: ProofAnalogInput }[] = []
	const calls: string[] = []
	let created = 0
	const discoveries = opts.store?.discoveries ?? [discovery()]
	const observations = opts.store?.observations ?? [observation()]
	const warn = vi.fn()
	const child = { warn, child: () => child }
	const logger = { warn, child: () => child } as unknown as Logger
	const store = {
		near(hz: number, toleranceHz: number, sourceId?: string): Discovery[] {
			calls.push("near")
			if (opts.store?.near) return opts.store.near(hz, toleranceHz, sourceId)
			return discoveries
				.filter(
					d =>
						(sourceId === undefined || d.sourceIds.includes(sourceId)) &&
						Math.abs(d.frequencyHz - hz) <= toleranceHz,
				)
				.sort(
					(a, b) =>
						Math.abs(a.frequencyHz - hz) - Math.abs(b.frequencyHz - hz) ||
						a.id.localeCompare(b.id),
				)
		},
		observations(discoveryId: string, cursor: string | null, limit: number) {
			calls.push("observations")
			if (opts.store?.observationsOf)
				return opts.store.observationsOf(discoveryId, cursor, limit)
			const items = observations.filter(o => o.discoveryId === discoveryId)
			return { items: items.slice(0, limit), nextCursor: null }
		},
		recordAnalog(observationId: string, analog: ProofAnalogInput): boolean {
			calls.push("recordAnalog")
			if (opts.store?.recordAnalog)
				return opts.store.recordAnalog(observationId, analog)
			recorded.push({ observationId, analog })
			return true
		},
		create(): void {
			created += 1
		},
	}
	const listeners = new Set<(t: AnalogEvidenceTransmission) => void>()
	const log = {
		subscribe(listener: (t: AnalogEvidenceTransmission) => void): () => void {
			listeners.add(listener)
			return () => {
				listeners.delete(listener)
			}
		},
		emit(t: AnalogEvidenceTransmission): void {
			for (const listener of [...listeners]) listener(t)
		},
	}
	const evidence = createLiveAudioEvidence({
		store,
		analogLog: log as unknown as Parameters<
			typeof createLiveAudioEvidence
		>[0]["analogLog"],
		trust: () => {
			if (opts.trust === "throw") throw new Error(`hz=${HZ} tx=SECRET`)
			if (opts.trust === "unknown") return "unknown" as TuningTrust
			return opts.trust ?? "commanded"
		},
		logger,
	})
	evidence.start()
	const closed = opts.closed ?? [
		transmission(opts.eventTrust ? { tuningTrust: opts.eventTrust } : {}),
	]
	for (const t of closed) log.emit(t)
	return { recorded, calls, created, evidence, warn, log, store }
}

describe("live-audio evidence", () => {
	it("CTCSS on commanded attaches decoded with the tone", () => {
		const { recorded, created, calls } = harness({})
		expect(created).toBe(0)
		expect(calls.filter(c => c === "near")).toEqual(["near"])
		expect(recorded).toEqual([
			{
				observationId: "o_1",
				analog: {
					outcome: "decoded",
					mode: "nfm",
					voice: true,
					tone: { ctcssHz: 88.5, dcs: null },
					transport: "live",
					at: T0 + 2_000,
				},
			},
		])
	})

	it("no tone attaches heard", () => {
		const { recorded } = harness({
			closed: [transmission({ ctcssHz: null, dcs: null })],
		})
		expect(recorded).toHaveLength(1)
		expect(recorded[0]?.analog.outcome).toBe("heard")
		expect(recorded[0]?.analog.tone).toEqual({ ctcssHz: null, dcs: null })
		expect(recorded[0]?.analog.voice).toBe(true)
	})

	it("a DCS code with no CTCSS is decoded", () => {
		const { recorded } = harness({
			closed: [
				transmission({
					ctcssHz: null,
					dcs: { code: "023", polarity: "inverted" },
				}),
			],
		})
		expect(recorded[0]?.analog).toMatchObject({
			outcome: "decoded",
			tone: { ctcssHz: null, dcs: { code: "023", polarity: "inverted" } },
		})
	})

	it("an off-table tone is no tone, so the outcome is heard", () => {
		const { recorded } = harness({
			closed: [
				transmission({
					ctcssHz: 12,
					dcs: { code: "999", polarity: "normal" },
				}),
			],
		})
		expect(recorded[0]?.analog.outcome).toBe("heard")
		expect(recorded[0]?.analog.tone).toEqual({ ctcssHz: null, dcs: null })
		expect(DCS_STANDARD_CODES.includes("023")).toBe(true)
	})

	it("unverified trust records nothing", () => {
		const { recorded, calls, created } = harness({ trust: "unverified" })
		expect(recorded).toEqual([])
		expect(calls).toEqual([])
		expect(created).toBe(0)
	})

	it("an unknown trust answer records nothing", () => {
		const { recorded, calls } = harness({ trust: "unknown" })
		expect(recorded).toEqual([])
		expect(calls).toEqual([])
	})

	it("a throwing trust records nothing and does not throw", () => {
		expect(() => harness({ trust: "throw" })).not.toThrow()
		const { recorded, calls, warn } = harness({ trust: "throw" })
		expect(recorded).toEqual([])
		expect(calls).toEqual([])
		expect(warn).not.toHaveBeenCalled()
	})

	it("an unverified transmission records nothing even when the source is commanded", () => {
		const { recorded, calls } = harness({ eventTrust: "unverified" })
		expect(recorded).toEqual([])
		expect(calls).toEqual([])
	})

	it("relay counts as trusted", () => {
		const { recorded } = harness({
			trust: "relay",
			eventTrust: "relay",
		})
		expect(recorded).toHaveLength(1)
		expect(recorded[0]?.analog.outcome).toBe("decoded")
	})

	it("no discovery within 6250 Hz records nothing and creates none", () => {
		const { recorded, created, calls, store } = harness({
			store: { discoveries: [discovery({ frequencyHz: HZ + 6_251 })] },
		})
		expect(recorded).toEqual([])
		expect(created).toBe(0)
		expect(calls).toEqual(["near"])
		expect(store.near(HZ, DISCOVERY_NEAR_DEFAULT_TOLERANCE_HZ, SOURCE)).toEqual(
			[],
		)
		expect(DISCOVERY_NEAR_DEFAULT_TOLERANCE_HZ).toBe(6_250)
	})

	it("uses the nearest discovery and does not fall through when it does not overlap", () => {
		const far = discovery({ id: "d_far", frequencyHz: HZ + 5_000 })
		const near = discovery({ id: "d_near", frequencyHz: HZ + 100 })
		const seen: string[] = []
		const { recorded } = harness({
			store: {
				discoveries: [near, far],
				observationsOf: discoveryId => {
					seen.push(discoveryId)
					if (discoveryId === "d_far")
						return { items: [observation({ discoveryId })], nextCursor: null }
					return {
						items: [
							observation({
								discoveryId,
								startedAt: iso(T0 + 10_000),
								endedAt: iso(T0 + 12_000),
							}),
						],
						nextCursor: null,
					}
				},
			},
		})
		expect(seen).toEqual(["d_near"])
		expect(recorded).toEqual([])
	})

	it("reads only the first observation page of 64, newest first", () => {
		const items = Array.from({ length: 70 }, (_, i) =>
			observation({
				id: `o_${i}`,
				startedAt: iso(T0 + 50_000),
				endedAt: iso(T0 + 60_000),
			}),
		)
		items.push(
			observation({
				id: "o_overlap_late",
				startedAt: iso(T0 - 100),
				endedAt: iso(T0 + 2_100),
			}),
		)
		let limit = 0
		const { recorded } = harness({
			store: {
				observationsOf: (_id, cursor, size) => {
					limit = size
					expect(cursor).toBeNull()
					return { items, nextCursor: null }
				},
			},
		})
		expect(limit).toBe(64)
		expect(recorded).toEqual([])
	})

	it("attaches to the first overlapping observation on that page", () => {
		const { recorded } = harness({
			store: {
				observations: [
					observation({
						id: "o_after",
						startedAt: iso(T0 + 9_000),
						endedAt: iso(T0 + 10_000),
					}),
					observation({ id: "o_hit" }),
				],
			},
		})
		expect(recorded.map(r => r.observationId)).toEqual(["o_hit"])
	})

	it("an open observation overlaps when it is still open through the transmission", () => {
		const { recorded } = harness({
			store: {
				observations: [observation({ id: "o_open", endedAt: undefined })],
			},
		})
		expect(recorded.map(r => r.observationId)).toEqual(["o_open"])
	})

	it("maps AM and DSB to am and wide FM to nfm", () => {
		const am = harness({
			closed: [transmission({ modulation: "am", ctcssHz: null })],
		})
		const dsb = harness({
			closed: [transmission({ modulation: "dsb", ctcssHz: null })],
		})
		const wfm = harness({
			closed: [transmission({ modulation: "wfm", ctcssHz: null })],
		})
		expect(am.recorded[0]?.analog.mode).toBe("am")
		expect(dsb.recorded[0]?.analog.mode).toBe("am")
		expect(wfm.recorded[0]?.analog.mode).toBe("nfm")
	})

	it("ignores an open transmission", () => {
		const { recorded, calls } = harness({
			closed: [transmission({ endedAtMs: null, ctcssHz: null })],
		})
		expect(recorded).toEqual([])
		expect(calls).toEqual([])
	})

	it("stop ends the subscription and start is idempotent", () => {
		const h = harness({ closed: [] })
		h.evidence.start()
		h.log.emit(transmission())
		expect(h.recorded).toHaveLength(1)
		h.evidence.stop()
		h.log.emit(transmission({ transmissionId: "tx2" }))
		expect(h.recorded).toHaveLength(1)
		h.evidence.stop()
	})

	it("a throwing store call records nothing, once, without the values", () => {
		const boom = new Error(`hz=${HZ} tx=SECRET`)
		const first = harness({
			store: {
				near: () => {
					throw boom
				},
			},
		})
		expect(first.recorded).toEqual([])
		expect(first.created).toBe(0)
		expect(first.warn).toHaveBeenCalledTimes(1)
		const payload = JSON.stringify(first.warn.mock.calls)
		expect(payload).not.toContain(String(HZ))
		expect(payload).not.toContain("SECRET")
		expect(payload).not.toContain("tx1")
		first.log.emit(transmission({ transmissionId: "tx2" }))
		expect(first.warn).toHaveBeenCalledTimes(1)

		const second = harness({
			store: {
				observationsOf: () => {
					throw boom
				},
			},
		})
		expect(second.recorded).toEqual([])
		expect(second.warn).toHaveBeenCalledTimes(1)

		const third = harness({
			store: {
				recordAnalog: () => {
					throw boom
				},
			},
		})
		expect(third.recorded).toEqual([])
		expect(third.warn).toHaveBeenCalledTimes(1)
	})

	it("a throwing closed-transmission listener does not break the log", () => {
		const evidenceLog = createAnalogEvidenceLog({
			monitoring: () => false,
		})
		const seen: string[] = []
		evidenceLog.subscribe(() => {
			throw new Error("listener failed")
		})
		evidenceLog.subscribe(t => {
			seen.push(t.transmissionId)
		})
		const event: AnalogTransmissionEventData = {
			transmissionId: "tx-live",
			sourceId: SOURCE,
			state: "closed",
			startedAt: iso(T0),
			endedAt: iso(T0 + 2_000),
			durationMs: 2_000,
			frequency: { hz: HZ, tuningTrust: "commanded" },
			modulation: "nfm",
			bandwidthHz: 12_500,
			squelchMode: "manual",
			thresholdDbfs: -40,
			peakChannelPowerDbfs: -30,
			meanChannelPowerDbfs: -32,
			closeReason: "squelch",
			tone: { ctcssHz: 88.5, dtmf: null, dcs: null },
		}
		expect(() => evidenceLog.record(event)).not.toThrow()
		expect(seen).toEqual(["tx-live"])
		expect(evidenceLog.transmissionsNear(SOURCE, HZ, 1_000, 0)).toHaveLength(1)
		evidenceLog.record({ ...event, state: "open", transmissionId: "tx-open" })
		expect(seen).toEqual(["tx-live"])
	})

	it("puts a source's tone on that source's observation when another source overlaps first", () => {
		const { recorded } = harness({
			closed: [transmission({ sourceId: "A" })],
			store: {
				discoveries: [discovery({ sourceIds: ["A", "B"] })],
				observations: [
					observation({ id: "o_b", sourceId: "B" }),
					observation({ id: "", sourceId: "A" }),
					observation({
						id: "o_backwards",
						sourceId: "A",
						startedAt: iso(T0 + 1_000),
						endedAt: iso(T0 + 500),
					}),
					observation({ id: "o_a", sourceId: "A" }),
				],
			},
		})
		expect(recorded.map(r => r.observationId)).toEqual(["o_a"])
	})

	it("records nothing when only another source's observation overlaps", () => {
		const { recorded, calls } = harness({
			closed: [transmission({ sourceId: "A" })],
			store: {
				discoveries: [discovery({ sourceIds: ["A", "B"] })],
				observations: [observation({ id: "o_b", sourceId: "B" })],
			},
		})
		expect(recorded).toEqual([])
		expect(calls).toEqual(["near", "observations"])
	})

	it("records nothing when the page returns another discovery's observation", () => {
		const { recorded, calls } = harness({
			store: {
				observationsOf: () => ({
					items: [
						observation({
							id: "o_other",
							discoveryId: "d_other",
							sourceId: SOURCE,
						}),
					],
					nextCursor: null,
				}),
			},
		})
		expect(recorded).toEqual([])
		expect(calls).toEqual(["near", "observations"])
	})

	it("a throwing subscribe does not escape start and is logged once without values", () => {
		const secret = "subscribe-SECRET"
		let calls = 0
		const { evidence, warn } = subscriptionHarness(() => {
			calls += 1
			throw new Error(secret)
		})
		expect(() => evidence.start()).not.toThrow()
		expect(calls).toBe(1)
		expect(warn).toHaveBeenCalledTimes(1)
		expect(JSON.stringify(warn.mock.calls)).not.toContain(secret)
		expect(() => evidence.start()).not.toThrow()
		expect(calls).toBe(2)
		expect(warn).toHaveBeenCalledTimes(1)
		expect(() => evidence.stop()).not.toThrow()
	})

	it("a subscribe that does not return a function is not kept and is logged once", () => {
		const secret = "not-a-function-SECRET"
		let calls = 0
		const { evidence, warn, recorded } = subscriptionHarness(() => {
			calls += 1
			return secret
		})
		expect(() => evidence.start()).not.toThrow()
		expect(calls).toBe(1)
		expect(warn).toHaveBeenCalledTimes(1)
		expect(JSON.stringify(warn.mock.calls)).not.toContain(secret)
		expect(recorded).toEqual([])
		expect(() => evidence.stop()).not.toThrow()
		expect(() => evidence.start()).not.toThrow()
		expect(calls).toBe(2)
		expect(warn).toHaveBeenCalledTimes(1)
	})

	it("a throwing unsubscribe does not escape, runs once, and later events are ignored", () => {
		const secret = "unsubscribe-SECRET"
		let unsubscribes = 0
		const heard: {
			fn: ((t: AnalogEvidenceTransmission) => void) | null
		} = { fn: null }
		const { evidence, warn, recorded } = subscriptionHarness(fn => {
			heard.fn = fn
			return () => {
				unsubscribes += 1
				throw new Error(secret)
			}
		})
		expect(() => evidence.start()).not.toThrow()
		expect(warn).not.toHaveBeenCalled()
		expect(() => evidence.stop()).not.toThrow()
		expect(unsubscribes).toBe(1)
		expect(warn).toHaveBeenCalledTimes(1)
		expect(JSON.stringify(warn.mock.calls)).not.toContain(secret)
		expect(() => evidence.stop()).not.toThrow()
		expect(unsubscribes).toBe(1)
		heard.fn?.(transmission())
		expect(recorded).toEqual([])
		evidence.start()
		heard.fn?.(transmission())
		expect(recorded).toEqual(["o_1"])
	})
})

function subscriptionHarness(
	subscribe: (listener: (t: AnalogEvidenceTransmission) => void) => unknown,
) {
	const recorded: string[] = []
	const warn = vi.fn()
	const child = { warn, child: () => child }
	const evidence = createLiveAudioEvidence({
		store: {
			near: () => [discovery()],
			observations: () => ({
				items: [observation()],
				nextCursor: null,
			}),
			recordAnalog: (observationId: string) => {
				recorded.push(observationId)
				return true
			},
		},
		analogLog: { subscribe } as unknown as Parameters<
			typeof createLiveAudioEvidence
		>[0]["analogLog"],
		trust: () => "commanded",
		logger: { warn, child: () => child } as unknown as Logger,
	})
	return { evidence, warn, recorded }
}
