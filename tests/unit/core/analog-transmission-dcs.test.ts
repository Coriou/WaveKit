import { EventEmitter } from "node:events"
import { describe, expect, it } from "vitest"
import type { AnalogTransmissionEventData } from "@wavekit/api-types"
import {
	AnalogTransmissionTracker,
	toActivityPayload,
} from "../../../src/core/analog-transmission.js"
import type { LiveDemodConfig } from "../../../src/core/live-demodulator.js"
import type {
	AnalogTransmissionSource,
	ToneDetectorPort,
} from "../../../src/core/analog-transmission.js"

class Src extends EventEmitter implements AnalogTransmissionSource {
	open = false
	getStatus(): ReturnType<AnalogTransmissionSource["getStatus"]> {
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
		return 250
	}
	transmissionCloseOverride(): null {
		return null
	}
	gate(open: boolean): void {
		this.open = open
		this.emit("squelch-changed", open)
	}
}

function run(
	detector: () => ToneDetectorPort,
	bytes: number,
): AnalogTransmissionEventData | undefined {
	const source = new Src()
	const events: AnalogTransmissionEventData[] = []
	let seq = 0
	const tracker = new AnalogTransmissionTracker({
		source,
		frequencyAt: () => ({ hz: 446_000_000, tuningTrust: "commanded" }),
		now: () => 1_700_000_000_000,
		randomUUID: () => `tx-${++seq}`,
		createToneDetector: detector,
		// WG10 activity hygiene off: this suite pins the DCS copy, not merge/minimum/carrier.
		hygiene: { mergeGapMs: 0, minDurationMs: 0, minCarrierBlocks: 0 },
	})
	tracker.on("transmission", event => events.push(event))
	tracker.start()
	source.gate(true)
	if (bytes > 0) {
		source.emit("pcm", Buffer.alloc(bytes), { rate: 8_000, format: "s16le" })
	}
	source.gate(false)
	return events[1]
}

const withDcs = (dcs: unknown): (() => ToneDetectorPort) => {
	return () => ({
		push() {},
		result: () => ({ ctcssHz: null, dtmf: null, dcs }) as never,
		reset() {},
	})
}

describe("analog transmission DCS", () => {
	const good = { code: "023", polarity: "normal" as const }

	it("withholds dcs under 0.75 s and keeps it at 0.75 s", () => {
		// 8 kHz s16le: 0.74 s = 5920 samples, 0.75 s = 6000 samples.
		expect(run(withDcs(good), 5_920 * 2)?.tone?.dcs).toBeNull()
		expect(run(withDcs(good), 6_000 * 2)?.tone?.dcs).toEqual(good)
	})

	it("yields null when the detector is broken", () => {
		const throwing = run(
			() => ({
				push() {},
				result() {
					throw new Error("boom")
				},
				reset() {},
			}),
			12_000,
		)
		expect(throwing?.tone).toEqual({ ctcssHz: null, dtmf: null, dcs: null })
		const factory = run(() => {
			throw new Error("no detector")
		}, 12_000)
		expect(factory?.tone).toEqual({ ctcssHz: null, dtmf: null, dcs: null })
		const pushBreaks = run(
			() => ({
				push() {
					throw new Error("push")
				},
				result: () => ({ ctcssHz: 100, dtmf: "5", dcs: good }),
				reset() {},
			}),
			12_000,
		)
		expect(pushBreaks?.tone?.dcs).toBeNull()
	})

	it("rejects malformed or missing dcs", () => {
		for (const bad of [
			undefined,
			null,
			"023",
			42,
			{},
			{ code: "023" },
			{ code: "089", polarity: "normal" },
			{ code: "024", polarity: "normal" },
			{ code: "23", polarity: "normal" },
			{ code: "0234", polarity: "normal" },
			{ code: 23, polarity: "normal" },
			{ code: "023", polarity: "sideways" },
		]) {
			expect(run(withDcs(bad), 12_000)?.tone?.dcs).toBeNull()
		}
		const noKey = run(
			() => ({
				push() {},
				result: () => ({ ctcssHz: 100, dtmf: "5" }),
				reset() {},
			}),
			12_000,
		)
		expect(noKey?.tone).toEqual({ ctcssHz: 100, dtmf: "5", dcs: null })
	})

	it("copies dcs into the activity payload as a fresh object", () => {
		const event = run(withDcs(good), 12_000)!
		const payload = toActivityPayload(event)
		expect(payload.tone?.dcs).toEqual(good)
		expect(payload.tone?.dcs).not.toBe(event.tone?.dcs)
		const none = toActivityPayload(run(withDcs(null), 12_000)!)
		expect(none.tone?.dcs).toBeNull()
	})
})
