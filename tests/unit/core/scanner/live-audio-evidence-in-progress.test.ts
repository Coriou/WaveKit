/**
 * In-progress tone evidence: a live-audio transmission whose CTCSS tone or DCS code qualifies
 * on 0.75 s of audio is recorded while it is still open (tracker "tone" event → evidence log
 * `recordTone` → live-audio evidence), once per transmission; its close adds no second entry.
 */
import { EventEmitter } from "node:events"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
	DCS_MIN_AUDIO_SECONDS,
	type AnalogTransmissionEventData,
	type AnalogTransmissionTone,
} from "@wavekit/api-types"
import {
	ANALOG_TONE_RECHECK_SECONDS,
	AnalogTransmissionTracker,
	CTCSS_MIN_AUDIO_SECONDS,
	type AnalogTransmissionSource,
} from "../../../../src/core/analog-transmission.js"
import type { LiveDemodConfig } from "../../../../src/core/live-demodulator.js"
import { createAnalogEvidenceLog } from "../../../../src/core/scanner/analog-evidence.js"
import { createLiveAudioEvidence } from "../../../../src/core/scanner/live-audio-evidence.js"
import type { AnalogEvidenceTransmission } from "../../../../src/core/scanner/identify-analog-contract.js"
import type { ProofAnalogInput } from "../../../../src/core/scanner/scanner-redesign-contract.js"
import type {
	Discovery,
	Observation,
} from "../../../../src/core/scanner/types.js"
import type { Logger } from "../../../../src/utils/logger.js"

const HZ = 446_006_250
const T0 = Date.parse("2026-10-17T10:00:00.000Z")
const SOURCE = "rtl0"
const RATE = 8_000
/** s16le at 8 kHz: 2 bytes per sample. */
const BYTES_PER_SECOND = RATE * 2
const CTCSS = { ctcssHz: 88.5, dtmf: null, dcs: null }
const DCS = {
	ctcssHz: null,
	dtmf: null,
	dcs: { code: "023", polarity: "inverted" as const },
}
const NONE = { ctcssHz: null, dtmf: null, dcs: null }

afterEach(() => {
	vi.useRealTimers()
})

class Src extends EventEmitter implements AnalogTransmissionSource {
	open = false
	getStatus(): ReturnType<AnalogTransmissionSource["getStatus"]> {
		return {
			enabled: true,
			running: true,
			sourceId: SOURCE,
			sourceConnected: true,
			sourceIqSampleRate: 2_048_000,
			config: this.demodConfig(),
			effectiveSampleRate: 25_000,
			decimationFactor: 1,
			httpUrl: "",
			wavUrl: "",
			clientCount: 0,
			bytesStreamed: 0,
			pipelineHealth: "running",
			pipelineRestarts: 0,
			squelchOpen: this.open,
			thresholdDbfs: -40,
		}
	}
	demodConfig(): LiveDemodConfig {
		return {
			enabled: true,
			sourceId: SOURCE,
			httpPort: 8081,
			modulation: "nfm",
			bandwidth: 12_500,
			squelch: -40,
			squelchMode: "manual",
			noiseReduction: "off",
			lowPass: 0,
			highPass: 0,
			gain: 2,
			deEmphasis: false,
			deEmphasisTau: 50,
			audioFormat: "s16le",
			iqDcBlock: false,
			offsetHz: 0,
		}
	}
	isSquelchOpen(): boolean {
		return this.open
	}
	squelchHangMs(): number {
		return 0
	}
	transmissionCloseOverride(): null {
		return null
	}
	gate(open: boolean): void {
		this.open = open
		this.emit("squelch-changed", open)
	}
	audio(seconds: number): void {
		this.emit("pcm", Buffer.alloc(Math.round(seconds * BYTES_PER_SECOND)), {
			rate: RATE,
			format: "s16le",
		})
	}
}

/** A tracker whose detector always reports `tone` (the tracker's 0.75 s gate decides). */
function trackerRig(
	tone: AnalogTransmissionTone,
	opts: { minDurationMs?: number; mergeGapMs?: number } = {},
) {
	const source = new Src()
	let now = T0
	let seq = 0
	const results: number[] = []
	const tracker = new AnalogTransmissionTracker({
		source,
		frequencyAt: () => ({ hz: HZ, tuningTrust: "commanded" }),
		now: () => now,
		randomUUID: () => `tx-${++seq}`,
		createToneDetector: () => ({
			push() {},
			result: () => {
				results.push(now)
				return {
					ctcssHz: tone.ctcssHz,
					dtmf: tone.dtmf,
					dcs: tone.dcs ? { ...tone.dcs } : null,
				}
			},
			reset() {},
		}),
		hygiene: {
			mergeGapMs: opts.mergeGapMs ?? 0,
			minDurationMs: opts.minDurationMs ?? 0,
			minCarrierBlocks: 0,
		},
		setTimer: () => () => {},
	})
	const transmissions: AnalogTransmissionEventData[] = []
	const tones: AnalogTransmissionEventData[] = []
	tracker.on("transmission", e => transmissions.push(e))
	tracker.on("tone", e => tones.push(e))
	tracker.start()
	return {
		source,
		tracker,
		transmissions,
		tones,
		results,
		advance(ms: number) {
			now += ms
		},
	}
}

describe("tracker in-progress tone event", () => {
	it("the bounds are the existing 0.75 s CTCSS and DCS qualification", () => {
		expect(CTCSS_MIN_AUDIO_SECONDS).toBe(0.75)
		expect(DCS_MIN_AUDIO_SECONDS).toBe(0.75)
	})

	it("emits at qualification (0.75 s of audio), before the close", () => {
		const r = trackerRig(CTCSS)
		r.source.gate(true)
		r.source.audio(0.5)
		expect(r.tones).toEqual([])
		r.source.audio(0.25)
		expect(r.tones).toHaveLength(1)
		const event = r.tones[0]
		expect(event?.state).toBe("open")
		expect(event?.endedAt).toBeNull()
		expect(event?.transmissionId).toBe("tx-1")
		expect(event?.tone).toEqual(CTCSS)
		expect(r.transmissions.map(e => e.state)).toEqual(["open"])
		r.source.gate(false)
		expect(r.transmissions.map(e => e.state)).toEqual(["open", "closed"])
		expect(r.tones).toHaveLength(1)
	})

	it("does not emit below 0.75 s (0.74 s), even at the close", () => {
		const r = trackerRig(CTCSS)
		r.source.gate(true)
		r.source.audio(0.74)
		expect(r.tones).toEqual([])
		r.source.gate(false)
		expect(r.tones).toEqual([])
		expect(r.transmissions[1]?.tone?.ctcssHz).toBeNull()
	})

	it("emits for a DCS code past the bound", () => {
		const r = trackerRig(DCS)
		r.source.gate(true)
		r.source.audio(0.74)
		expect(r.tones).toEqual([])
		r.source.audio(0.26)
		expect(r.tones).toHaveLength(1)
		expect(r.tones[0]?.tone?.dcs).toEqual(DCS.dcs)
	})

	it("a tone-less transmission emits no tone event and reads the detector throttled", () => {
		const r = trackerRig(NONE)
		r.source.gate(true)
		// 4 s of audio in 10 ms chunks: checks at 0.75 s, then every 0.25 s.
		for (let i = 0; i < 400; i++) r.source.audio(0.01)
		expect(r.tones).toEqual([])
		const checks = Math.floor((4 - 0.75) / ANALOG_TONE_RECHECK_SECONDS) + 1
		expect(r.results.length).toBeLessThanOrEqual(checks + 1)
		expect(r.results.length).toBeGreaterThanOrEqual(checks - 1)
		r.source.gate(false)
		expect(r.tones).toEqual([])
	})

	it("re-qualification on more audio and a merged segment emits once", () => {
		const r = trackerRig(CTCSS, { mergeGapMs: 1_500 })
		r.source.gate(true)
		r.source.audio(1)
		r.source.audio(5)
		r.advance(6_000)
		r.source.gate(false)
		r.advance(500)
		r.source.gate(true)
		r.source.audio(2)
		expect(r.tones).toHaveLength(1)
		// After qualification the detector is read only at the close.
		expect(r.transmissions.map(e => e.transmissionId)).toEqual(["tx-1"])
	})

	it("waits for the announcement before emitting", () => {
		const r = trackerRig(CTCSS, { minDurationMs: 2_000 })
		r.source.gate(true)
		r.source.audio(1)
		expect(r.transmissions).toEqual([])
		expect(r.tones).toEqual([])
		r.advance(2_000)
		r.source.emit("level", -30)
		expect(r.transmissions.map(e => e.state)).toEqual(["open"])
		r.source.audio(0.25)
		expect(r.tones).toHaveLength(1)
	})

	it("a throwing tone listener does not break the close", () => {
		const r = trackerRig(CTCSS)
		r.tracker.on("tone", () => {
			throw new Error("listener")
		})
		r.source.gate(true)
		r.source.audio(1)
		r.source.gate(false)
		expect(r.transmissions.map(e => e.state)).toEqual(["open", "closed"])
	})
})

function openEvent(
	over: Partial<AnalogTransmissionEventData> = {},
): AnalogTransmissionEventData {
	return {
		transmissionId: "tx1",
		sourceId: SOURCE,
		state: "open",
		startedAt: new Date(T0).toISOString(),
		endedAt: null,
		durationMs: null,
		frequency: { hz: HZ, tuningTrust: "commanded" },
		modulation: "nfm",
		bandwidthHz: 12_500,
		squelchMode: "manual",
		thresholdDbfs: -40,
		peakChannelPowerDbfs: -30,
		meanChannelPowerDbfs: -32,
		closeReason: null,
		...over,
	}
}

function closedEvent(
	over: Partial<AnalogTransmissionEventData> = {},
): AnalogTransmissionEventData {
	return openEvent({
		state: "closed",
		endedAt: new Date(T0 + 28_000).toISOString(),
		durationMs: 28_000,
		closeReason: "squelch",
		tone: CTCSS,
		...over,
	})
}

describe("evidence log recordTone", () => {
	function logRig() {
		const log = createAnalogEvidenceLog({ monitoring: () => true })
		const seen: AnalogEvidenceTransmission[] = []
		log.subscribe(t => seen.push(t))
		return { log, seen }
	}

	it("notifies once with an open transmission carrying the tone", () => {
		const { log, seen } = logRig()
		log.record(openEvent())
		log.recordTone(openEvent({ tone: CTCSS }))
		log.recordTone(openEvent({ tone: CTCSS }))
		expect(seen).toHaveLength(1)
		expect(seen[0]).toMatchObject({
			transmissionId: "tx1",
			endedAtMs: null,
			ctcssHz: 88.5,
			dcs: null,
		})
		// identify's kept entry is unchanged: closed tones only.
		expect(log.transmissionsNear(SOURCE, HZ, 0, 0)[0]?.ctcssHz).toBeNull()
		log.record(closedEvent())
		expect(seen).toHaveLength(2)
		expect(seen[1]?.endedAtMs).toBe(T0 + 28_000)
		log.recordTone(openEvent({ tone: CTCSS }))
		expect(seen).toHaveLength(2)
	})

	it("carries a DCS code", () => {
		const { log, seen } = logRig()
		log.record(openEvent())
		log.recordTone(openEvent({ tone: DCS }))
		expect(seen[0]?.dcs).toEqual(DCS.dcs)
		expect(seen[0]?.ctcssHz).toBeNull()
	})

	it("drops unknown, tone-less, malformed, other-source and closed events", () => {
		const { log, seen } = logRig()
		log.recordTone(openEvent({ tone: CTCSS }))
		log.record(openEvent())
		log.recordTone(openEvent())
		log.recordTone(openEvent({ tone: NONE }))
		log.recordTone(openEvent({ tone: { ...CTCSS, ctcssHz: 90 } }))
		log.recordTone(openEvent({ sourceId: "other", tone: CTCSS }))
		log.recordTone(closedEvent())
		log.recordTone(null as unknown as AnalogTransmissionEventData)
		expect(seen).toEqual([])
	})
})

interface Recorded {
	observationId: string
	analog: ProofAnalogInput
}

function evidenceRig(opts: { observations?: () => Observation[] } = {}) {
	const recorded: Recorded[] = []
	const log = createAnalogEvidenceLog({ monitoring: () => true })
	const warn = vi.fn()
	const child = { warn, child: () => child }
	const defaultObservations = (): Observation[] => [
		{
			id: "o_1",
			discoveryId: "d_near",
			sourceId: SOURCE,
			startedAt: new Date(T0 - 100).toISOString(),
		} as unknown as Observation,
	]
	const evidence = createLiveAudioEvidence({
		store: {
			near: () =>
				[
					{ id: "d_near", frequencyHz: HZ, sourceIds: [SOURCE] },
				] as unknown as Discovery[],
			observations: () => ({
				items: (opts.observations ?? defaultObservations)(),
				nextCursor: null,
			}),
			recordAnalog: (observationId: string, analog: ProofAnalogInput) => {
				recorded.push({ observationId, analog })
				return true
			},
		},
		analogLog: log,
		trust: () => "commanded",
		logger: { warn, child: () => child } as unknown as Logger,
	})
	evidence.start()
	return { recorded, log, evidence, warn }
}

describe("live-audio evidence in progress", () => {
	it("records a qualified CTCSS while open, at now, and nothing more at the close", () => {
		vi.useFakeTimers({ now: T0 + 3_000, toFake: ["Date"] })
		const { recorded, log } = evidenceRig()
		log.record(openEvent())
		expect(recorded).toEqual([])
		log.recordTone(openEvent({ tone: CTCSS }))
		expect(recorded).toEqual([
			{
				observationId: "o_1",
				analog: {
					outcome: "decoded",
					mode: "nfm",
					voice: true,
					tone: { ctcssHz: 88.5, dcs: null },
					transport: "live",
					at: T0 + 3_000,
				},
			},
		])
		log.recordTone(openEvent({ tone: CTCSS }))
		vi.setSystemTime(T0 + 28_000)
		log.record(closedEvent())
		expect(recorded).toHaveLength(1)
	})

	it("records a qualified DCS while open", () => {
		vi.useFakeTimers({ now: T0 + 2_000, toFake: ["Date"] })
		const { recorded, log } = evidenceRig()
		log.record(openEvent())
		log.recordTone(openEvent({ tone: DCS }))
		expect(recorded).toHaveLength(1)
		expect(recorded[0]?.analog).toMatchObject({
			outcome: "decoded",
			tone: { ctcssHz: null, dcs: { code: "023", polarity: "inverted" } },
			at: T0 + 2_000,
		})
		log.record(closedEvent({ tone: DCS }))
		expect(recorded).toHaveLength(1)
	})

	it("a repeated open transmission with a tone records once (idempotent)", () => {
		const recorded: Recorded[] = []
		const listeners: ((t: AnalogEvidenceTransmission) => void)[] = []
		const evidence = createLiveAudioEvidence({
			store: {
				near: () =>
					[
						{ id: "d_near", frequencyHz: HZ, sourceIds: [SOURCE] },
					] as unknown as Discovery[],
				observations: () => ({
					items: [
						{
							id: "o_1",
							discoveryId: "d_near",
							sourceId: SOURCE,
							startedAt: new Date(T0 - 100).toISOString(),
						} as unknown as Observation,
					],
					nextCursor: null,
				}),
				recordAnalog: (observationId: string, analog: ProofAnalogInput) => {
					recorded.push({ observationId, analog })
					return true
				},
			},
			analogLog: {
				subscribe: (l: (t: AnalogEvidenceTransmission) => void) => {
					listeners.push(l)
					return () => {}
				},
			} as unknown as Parameters<
				typeof createLiveAudioEvidence
			>[0]["analogLog"],
			trust: () => "commanded",
			logger: {
				warn: vi.fn(),
				child: () => ({ warn: vi.fn() }),
			} as unknown as Logger,
		})
		evidence.start()
		const emit = (t: AnalogEvidenceTransmission): void => {
			for (const l of listeners) l(t)
		}
		const open: AnalogEvidenceTransmission = {
			transmissionId: "tx1",
			sourceId: SOURCE,
			startedAtMs: T0,
			endedAtMs: null,
			hz: HZ,
			tuningTrust: "commanded",
			modulation: "nfm",
			ctcssHz: 88.5,
			dcs: null,
		}
		emit(open)
		emit(open)
		emit(open)
		expect(recorded).toHaveLength(1)
		emit({ ...open, endedAtMs: T0 + 28_000 })
		expect(recorded).toHaveLength(1)
		// The id left at its close: a later close of the same id records again.
		emit({ ...open, endedAtMs: T0 + 40_000 })
		expect(recorded).toHaveLength(2)
	})

	it("a tone-less transmission records only at the close, as heard", () => {
		const { recorded, log } = evidenceRig()
		log.record(openEvent())
		log.recordTone(openEvent({ tone: NONE }))
		expect(recorded).toEqual([])
		log.record(closedEvent({ tone: NONE }))
		expect(recorded).toHaveLength(1)
		expect(recorded[0]?.analog.outcome).toBe("heard")
		expect(recorded[0]?.analog.at).toBe(T0 + 28_000)
	})

	it("an early event that finds no observation leaves the close to record", () => {
		let observations: Observation[] = []
		const { recorded, log } = evidenceRig({ observations: () => observations })
		log.record(openEvent())
		log.recordTone(openEvent({ tone: CTCSS }))
		expect(recorded).toEqual([])
		observations = [
			{
				id: "o_2",
				discoveryId: "d_near",
				sourceId: SOURCE,
				startedAt: new Date(T0 + 1_000).toISOString(),
				endedAt: new Date(T0 + 29_000).toISOString(),
			} as unknown as Observation,
		]
		log.record(closedEvent())
		expect(recorded).toHaveLength(1)
		expect(recorded[0]?.observationId).toBe("o_2")
		expect(recorded[0]?.analog.at).toBe(T0 + 28_000)
	})

	it("end to end: a 28 s CTCSS voice transmission is recorded within 1 s of audio, once", () => {
		vi.useFakeTimers({ now: T0, toFake: ["Date"] })
		const r = trackerRig(CTCSS, { minDurationMs: 500 })
		const { recorded, log } = evidenceRig()
		r.tracker.on("transmission", e => {
			log.record(e)
		})
		r.tracker.on("tone", e => {
			log.recordTone(e)
		})
		r.source.gate(true)
		for (let i = 0; i < 20; i++) {
			r.advance(50)
			vi.setSystemTime(T0 + (i + 1) * 50)
			r.source.audio(0.05)
			r.source.emit("level", -30)
		}
		// 1 s of audio: announced at 0.5 s, qualified at 0.75 s.
		expect(recorded).toHaveLength(1)
		expect(recorded[0]?.analog.outcome).toBe("decoded")
		expect(recorded[0]?.analog.at).toBeLessThanOrEqual(T0 + 1_000)
		for (let i = 0; i < 27; i++) {
			r.advance(1_000)
			r.source.audio(1)
		}
		vi.setSystemTime(T0 + 28_000)
		r.source.gate(false)
		expect(r.transmissions.map(e => e.state)).toEqual(["open", "closed"])
		expect(recorded).toHaveLength(1)
	})
})
