/**
 * Detection quality R4 composition (DQ.11): admitted paging receptions reach the
 * data-decode gate through the Activity runtime's onEnvelope tap, and the gate
 * keeps a pager burst on the live channel out of analog voice Activity and out
 * of identify's analog evidence. Real runtime, ingress and store; fake demod.
 */
import { EventEmitter } from "node:events"
import { rm } from "node:fs/promises"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { LiveAudioLevel, TunerState } from "@wavekit/api-types"
import { startActivityRuntime } from "../../../../src/core/activity/runtime.js"
import type {
	ActivityRuntime,
	StartActivityRuntimeOptions,
} from "../../../../src/core/activity/runtime.js"
import type {
	ActivityDecoderBinding,
	DecodeEnvelope,
} from "../../../../src/core/activity/types.js"
import {
	tunerFrequencyAt,
	wireAnalogTransmissions,
} from "../../../../src/core/analog-transmission.js"
import type {
	AnalogTransmissionSource,
	AnalogTransmissionTracker,
} from "../../../../src/core/analog-transmission.js"
import type {
	LiveDemodConfig,
	LiveDemodStatus,
} from "../../../../src/core/live-demodulator.js"
import { createAnalogEvidenceLog } from "../../../../src/core/scanner/analog-evidence.js"
import {
	DQ_DATA_HOLD_MS,
	createDataDecodeGate,
} from "../../../../src/core/scanner/data-decode-gate.js"
import type { DataDecodeGate } from "../../../../src/core/scanner/data-decode-gate.js"
import { createLiveAudioEvidence } from "../../../../src/core/scanner/live-audio-evidence.js"
import type { ProofAnalogInput } from "../../../../src/core/scanner/scanner-redesign-contract.js"
import type {
	Discovery,
	Observation,
} from "../../../../src/core/scanner/types.js"
import type { ActivityPublisher } from "../../../../src/decoders/manager.js"
import type { DecoderOutput } from "../../../../src/decoders/types.js"
import {
	feedAnalogEvidence,
	stopAnalogTransmissions,
} from "../../../../src/index.js"
import { GracefulShutdown } from "../../../../src/utils/graceful-shutdown.js"
import type { Logger } from "../../../../src/utils/logger.js"
import { logger, readRecords, roots, tempDir } from "./storage/helpers.js"

const SOURCE = "rtl0"
/** Tuner 446 MHz + live offset 6.25 kHz. */
const TX_HZ = 446_006_250

class FakeDemod extends EventEmitter implements AnalogTransmissionSource {
	open = false
	readonly config: LiveDemodConfig = {
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
		offsetHz: 6_250,
	}

	getStatus(): LiveDemodStatus {
		return {
			enabled: true,
			running: true,
			sourceId: SOURCE,
			sourceConnected: true,
			sourceIqSampleRate: 2_048_000,
			config: this.config,
			effectiveSampleRate: 25_000,
			decimationFactor: 1,
			httpUrl: "http://127.0.0.1/stream",
			wavUrl: "http://127.0.0.1/stream.wav",
			clientCount: 0,
			bytesStreamed: 0,
			pipelineHealth: "running",
			pipelineRestarts: 0,
			squelchOpen: this.open,
			thresholdDbfs: -40,
		}
	}
	isSquelchOpen(): boolean {
		return this.open
	}
	squelchHangMs(): number {
		return 250
	}
	gate(open: boolean): void {
		this.open = open
		this.emit("squelch-changed", open)
	}
	level(): void {
		const level: LiveAudioLevel = {
			sourceId: SOURCE,
			channelPowerDbfs: -30,
			noiseFloorDbfs: -60,
			squelchOpen: this.open,
			thresholdDbfs: -40,
		}
		this.emit("level", level)
	}
}

const tuner = tunerFrequencyAt(
	(): TunerState =>
		({
			frequency: 446_000_000,
			controlMode: "internal",
		}) as TunerState,
)

/** Manual gate timers: the store and the tracker keep real time. */
function manualTimers() {
	const pending = new Set<() => void>()
	return {
		setTimer(fn: () => void, _ms: number): () => void {
			const entry = (): void => {
				pending.delete(entry)
				fn()
			}
			pending.add(entry)
			return () => {
				pending.delete(entry)
			}
		},
		fireAll(): void {
			for (const fn of [...pending]) fn()
		},
		size: () => pending.size,
	}
}

function page(at: number, message: string): DecoderOutput {
	return {
		timestamp: new Date(at),
		decoder: "pocsag-1",
		type: "message",
		data: {
			protocol: "POCSAG1200",
			address: 1200,
			function: 0,
			messageType: "alpha",
			message,
		},
	}
}

const runtimes: ActivityRuntime[] = []
const trackers: AnalogTransmissionTracker[] = []

afterEach(async () => {
	for (const t of trackers.splice(0)) t.stop()
	await Promise.all(runtimes.splice(0).map(r => r.close()))
	await Promise.all(
		roots.splice(0).map(root => rm(root, { recursive: true, force: true })),
	)
})

interface Harness {
	stateDir: string
	runtime: ActivityRuntime
	publish: ActivityPublisher
	gate: DataDecodeGate
	timers: ReturnType<typeof manualTimers>
	demod: FakeDemod
	tracker: AnalogTransmissionTracker
	clock: { now: number }
	binding: ActivityDecoderBinding
	evidence: {
		record: ReturnType<typeof vi.fn>
		analog: ProofAnalogInput[]
		stop: () => void
	}
	rows: () => Promise<{ kind: string; eventId: string }[]>
}

/** Mirrors the src/index.ts composition with fakes at the edges. */
async function harness(
	overrides: Partial<StartActivityRuntimeOptions> = {},
	tap?: (gate: DataDecodeGate, env: DecodeEnvelope) => void,
): Promise<Harness> {
	const stateDir = await tempDir()
	// All transmission times sit 30 s in the past so identify's observation window holds.
	const clock = { now: Date.now() - 30_000 }
	const timers = manualTimers()
	const gate = createDataDecodeGate({
		now: () => clock.now,
		setTimer: timers.setTimer,
	})
	const binding: ActivityDecoderBinding = {
		sourceId: SOURCE,
		targetFrequenciesHz: [TX_HZ + 800],
		tuningTrust: "commanded",
	}
	let publish: ActivityPublisher | null = null
	const runtime = await startActivityRuntime({
		enabled: true,
		stateDir,
		logger,
		execution: "inline",
		queryExecution: "inline",
		limits: { batchWindowMs: 0 },
		setPublisher: p => {
			publish = p
		},
		resolveProvenance: () => binding,
		onEnvelope: env => {
			if (tap) tap(gate, env)
			else gate.noteEnvelope(env)
		},
		...overrides,
	})
	runtimes.push(runtime)
	expect(runtime.status).toBe("ready")
	const demod = new FakeDemod()
	const tracker = wireAnalogTransmissions({
		source: demod,
		frequencyAt: tuner,
		broadcast: () => undefined,
		sink: () => runtime.transmissionSink(),
		now: () => clock.now,
		dataGate: gate,
	})
	trackers.push(tracker)

	// Identify's analog evidence: the real log and live-audio evidence with a fake store.
	const analog: ProofAnalogInput[] = []
	const log = createAnalogEvidenceLog({ monitoring: () => false })
	const record = vi.fn(log.record.bind(log))
	const disc = {
		id: "d1",
		frequencyHz: TX_HZ,
		sourceIds: [SOURCE],
	} as unknown as Discovery
	const obs = {
		id: "o1",
		discoveryId: "d1",
		sourceId: SOURCE,
		startedAt: new Date(clock.now - 5_000).toISOString(),
		endedAt: new Date(Date.now()).toISOString(),
	} as unknown as Observation
	const child = { warn: vi.fn(), child: () => child }
	const live = createLiveAudioEvidence({
		store: {
			near: () => [disc],
			observations: () => ({ items: [obs], nextCursor: null }),
			recordAnalog: (_id: string, a: ProofAnalogInput) => {
				analog.push(a)
				return true
			},
		} as unknown as Parameters<typeof createLiveAudioEvidence>[0]["store"],
		analogLog: log,
		trust: () => "commanded",
		logger: child as unknown as Logger,
	})
	live.start()
	feedAnalogEvidence(tracker, { record }, gate)

	return {
		stateDir,
		runtime,
		get publish(): ActivityPublisher {
			if (publish === null) throw new Error("no publisher")
			return publish
		},
		gate,
		timers,
		demod,
		tracker,
		clock,
		binding,
		evidence: { record, analog, stop: () => live.stop() },
		rows: async () =>
			(await readRecords(join(stateDir, "activity", "activity.db"))).map(r => ({
				kind: r.kind,
				eventId: r.eventId,
			})),
	}
}

/** Opens at the clock, closes after `durationMs`, finalises past the merge gap. */
function over(h: Harness, durationMs: number): { startedAt: number } {
	const startedAt = h.clock.now
	h.demod.gate(true)
	h.clock.now += durationMs
	h.demod.gate(false)
	h.clock.now += 2_000
	h.demod.level()
	return { startedAt }
}

function closedEvidence(h: Harness): { data?: boolean }[] {
	return h.evidence.record.mock.calls
		.map(c => c[0] as { state: string; data?: boolean })
		.filter(e => e.state === "closed")
}

describe("data-decode gate wiring (detection quality R4)", () => {
	it("a POCSAG reception at the transmission's frequency keeps the burst out of voice Activity and analog proof", async () => {
		const h = await harness()
		const { startedAt } = over(h, 2_100)
		// The close is held; nothing reached Activity or identify yet.
		expect(h.timers.size()).toBe(1)
		expect(closedEvidence(h)).toEqual([])
		// Decoded 300 ms after the audio end, 800 Hz from the live channel.
		h.publish("pocsag-1", "multimon", page(startedAt + 2_100, "STATION 4"))
		h.timers.fireAll()

		const rows = await h.rows()
		expect(rows.map(r => r.kind)).toEqual(["decoder-reception"])
		const closed = closedEvidence(h)
		expect(closed).toHaveLength(1)
		expect(closed[0]?.data).toBe(true)
		expect(h.evidence.analog).toEqual([])
		h.evidence.stop()
	})

	it("a plain analog over with no decode is a voice row after the hold", async () => {
		const h = await harness()
		over(h, 3_000)
		expect((await h.rows()).map(r => r.kind)).toEqual([])
		h.clock.now += DQ_DATA_HOLD_MS
		h.timers.fireAll()

		expect((await h.rows()).map(r => r.kind)).toEqual(["analog-transmission"])
		const closed = closedEvidence(h)
		expect(closed).toHaveLength(1)
		expect(closed[0]?.data).toBeUndefined()
		expect(h.evidence.analog).toHaveLength(1)
		expect(h.evidence.analog[0]).toMatchObject({ voice: true })
		h.evidence.stop()
	})

	it("a reception the store drops does not mark the burst as data", async () => {
		// One token per decoder and no refill.
		const h = await harness({
			limits: {
				batchWindowMs: 0,
				decoderBurst: 1,
				decoderRatePerSec: 0,
			},
		})
		const seen: DecodeEnvelope[] = []
		const { startedAt } = over(h, 2_100)
		// First page is far off-channel and takes the only token.
		h.binding.targetFrequenciesHz = [TX_HZ + 100_000]
		h.publish("pocsag-1", "multimon", page(startedAt + 1_000, "FAR"))
		// The matching page is rate limited: never admitted, never offered to the gate.
		h.binding.targetFrequenciesHz = [TX_HZ + 800]
		const noteEnvelope = h.gate.noteEnvelope.bind(h.gate)
		h.gate.noteEnvelope = env => {
			seen.push(env)
			noteEnvelope(env)
		}
		h.publish("pocsag-1", "multimon", page(startedAt + 2_100, "NEAR"))
		h.timers.fireAll()

		expect(seen).toEqual([])
		const kinds = (await h.rows()).map(r => r.kind).sort()
		expect(kinds).toEqual(["analog-transmission", "decoder-reception"])
		expect(closedEvidence(h)[0]?.data).toBeUndefined()
		h.evidence.stop()
	})

	it("an onEnvelope that throws does not break admission", async () => {
		const offered: DecodeEnvelope[] = []
		const h = await harness({}, (_gate, env) => {
			offered.push(env)
			throw new Error("tap failure")
		})
		expect(() => {
			h.publish("pocsag-1", "multimon", page(h.clock.now, "ONE"))
			h.publish("pocsag-1", "multimon", page(h.clock.now + 10, "TWO"))
		}).not.toThrow()
		const rows = await h.rows()
		expect(rows.map(r => r.kind)).toEqual([
			"decoder-reception",
			"decoder-reception",
		])
		// The presented envelope (category from the pager presentation) is offered.
		expect(offered.map(e => e.category)).toEqual(["paging", "paging"])
		expect(offered.map(e => e.eventId).sort()).toEqual(
			rows.map(r => r.eventId).sort(),
		)
		h.evidence.stop()
	})

	it("shutdown flushes held closes as not-data exactly once, before Activity closes", async () => {
		const h = await harness()
		// A finished over waiting in the gate, and one still open at shutdown.
		over(h, 3_000)
		h.clock.now += 5_000
		h.demod.gate(true)
		h.clock.now += 1_500
		h.demod.level()

		// The src/index.ts order: "activity" registered before "analog-transmissions" (LIFO).
		const shutdown = new GracefulShutdown({ logger })
		shutdown.register({
			name: "activity",
			handler: () => h.runtime.close(),
			timeout: 5_000,
		})
		shutdown.register({
			name: "analog-transmissions",
			handler: async () => {
				stopAnalogTransmissions(h.tracker, h.gate)
			},
			timeout: 1_000,
		})
		await shutdown.shutdown()
		expect(h.timers.size()).toBe(0)
		h.timers.fireAll()

		const rows = await h.rows()
		expect(rows.map(r => r.kind)).toEqual([
			"analog-transmission",
			"analog-transmission",
		])
		expect(new Set(rows.map(r => r.eventId)).size).toBe(2)
		const closed = closedEvidence(h)
		expect(closed).toHaveLength(2)
		expect(closed.every(e => e.data === undefined)).toBe(true)
		// A close after the gate stopped is delivered at once.
		const late: boolean[] = []
		h.gate.hold(
			{
				sourceId: SOURCE,
				startedAt: new Date(h.clock.now).toISOString(),
				endedAt: new Date(h.clock.now + 1_000).toISOString(),
				frequency: { hz: TX_HZ },
			},
			d => late.push(d),
		)
		expect(late).toEqual([false])
		h.evidence.stop()
	})

	it("stopAnalogTransmissions stops the gate even when the tracker stop throws", () => {
		const order: string[] = []
		expect(() =>
			stopAnalogTransmissions(
				{
					stop: () => {
						order.push("tracker")
						throw new Error("stop failed")
					},
				},
				{ stop: () => order.push("gate") },
			),
		).toThrow("stop failed")
		expect(order).toEqual(["tracker", "gate"])
	})
})
