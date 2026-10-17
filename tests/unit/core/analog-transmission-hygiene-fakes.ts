/**
 * Shared fakes for the WG10 activity hygiene tests of the analog transmission tracker:
 * a source with a scripted squelch, clock, carrier-block counter and a manual timer.
 */
import { EventEmitter } from "node:events"
import type {
	AnalogTransmissionEventData,
	AnalogTransmissionPayload,
} from "@wavekit/api-types"
import { AnalogTransmissionTracker } from "../../../src/core/analog-transmission.js"
import type {
	AnalogTransmissionHygiene,
	AnalogTransmissionSource,
} from "../../../src/core/analog-transmission.js"
import type {
	LiveAudioLevel,
	LiveDemodConfig,
	LiveDemodStatus,
} from "../../../src/core/live-demodulator.js"

export class HygieneSource
	extends EventEmitter
	implements AnalogTransmissionSource
{
	open = false
	modulation: LiveDemodConfig["modulation"] = "nfm"
	offsetHz = 0
	/** Null: the pipeline has no carrier evidence (am, ssb, ...). */
	carrier: number | null = 0

	getStatus(): LiveDemodStatus {
		return {
			enabled: true,
			running: true,
			sourceId: "rtl0",
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
			sourceId: "rtl0",
			httpPort: 8081,
			modulation: this.modulation,
			bandwidth: 12_500,
			squelch: -40,
			squelchMode: "auto",
			noiseReduction: "off",
			lowPass: 0,
			highPass: 0,
			gain: 2,
			deEmphasis: false,
			deEmphasisTau: 50,
			audioFormat: "s16le",
			iqDcBlock: false,
			offsetHz: this.offsetHz,
		}
	}

	isSquelchOpen(): boolean {
		return this.open
	}

	squelchHangMs(): number {
		return 250
	}

	transmissionCloseOverride(): null {
		return null
	}

	carrierBlocks(): number | null {
		return this.carrier
	}

	gate(open: boolean): void {
		this.open = open
		this.emit("squelch-changed", open)
	}

	level(): void {
		const level: LiveAudioLevel = {
			sourceId: "rtl0",
			channelPowerDbfs: -30,
			noiseFloorDbfs: -60,
			squelchOpen: this.open,
			thresholdDbfs: -40,
		}
		this.emit("level", level)
	}

	reconfigure(patch: Partial<LiveDemodConfig>): void {
		if (patch.offsetHz !== undefined) this.offsetHz = patch.offsetHz
		if (patch.modulation !== undefined) this.modulation = patch.modulation
		this.emit("config-changed", this.demodConfig())
	}
}

export interface PendingTimer {
	at: number
	fn: () => void
	cancelled: boolean
}

export function hygieneHarness(hygiene?: Partial<AnalogTransmissionHygiene>) {
	const source = new HygieneSource()
	let now = 1_700_000_000_000
	let seq = 0
	const timers: PendingTimer[] = []
	const events: AnalogTransmissionEventData[] = []
	const rows: AnalogTransmissionPayload[] = []
	const suppressedLog: string[] = []
	const tracker = new AnalogTransmissionTracker({
		source,
		frequencyAt: (_id, offsetHz) => ({
			hz: 446_000_000 + offsetHz,
			tuningTrust: "commanded",
		}),
		now: () => now,
		randomUUID: () => `tx-${++seq}`,
		setTimer: (fn, ms) => {
			const timer: PendingTimer = { at: now + ms, fn, cancelled: false }
			timers.push(timer)
			return () => {
				timer.cancelled = true
			}
		},
		onSuppressed: reason => suppressedLog.push(reason),
		...(hygiene === undefined ? {} : { hygiene }),
	})
	tracker.on("transmission", event => events.push(event))
	tracker.on("closed", payload => rows.push(payload))
	tracker.start()
	/** Advances the clock, firing due timers in order. */
	const advance = (ms: number): void => {
		const target = now + ms
		for (;;) {
			const due = timers
				.filter(t => !t.cancelled && t.at <= target)
				.sort((a, b) => a.at - b.at)[0]
			if (due === undefined) break
			due.cancelled = true
			now = Math.max(now, due.at)
			due.fn()
		}
		now = target
	}
	/** Open for `openMs` with `carrierPerBlock` of its 10 ms blocks quieted, then close. */
	const burst = (openMs: number, carrier: boolean): void => {
		source.gate(true)
		for (let t = 0; t < openMs; t += 10) {
			if (carrier && source.carrier !== null) source.carrier += 1
			advance(10)
		}
		source.gate(false)
	}
	return {
		source,
		tracker,
		events,
		rows,
		timers,
		suppressedLog,
		advance,
		burst,
		now: () => now,
	}
}
