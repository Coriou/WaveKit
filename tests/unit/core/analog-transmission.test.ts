import { EventEmitter } from "node:events"
import { describe, expect, it } from "vitest"
import type {
	AnalogTransmissionEventData,
	AnalogTransmissionFrequency,
} from "@wavekit/api-types"
import {
	AnalogTransmissionTracker,
	toActivityPayload,
} from "../../../src/core/analog-transmission.js"
import type { AnalogTransmissionSource } from "../../../src/core/analog-transmission.js"
import type {
	LiveAudioLevel,
	LiveDemodConfig,
	LiveDemodStatus,
} from "../../../src/core/live-demodulator.js"
import { WaveKitError } from "../../../src/utils/errors.js"

class FakeSource extends EventEmitter implements AnalogTransmissionSource {
	running = true
	squelchOpen = false
	squelch = -40
	squelchMode: "manual" | "auto" = "manual"
	sourceId = "rtl0"
	modulation: LiveDemodConfig["modulation"] = "nfm"
	bandwidth = 12_500
	offsetHz = 0
	thresholdDbfs = -40
	frequencyHz: number | null = 446_000_000
	trust: AnalogTransmissionFrequency["tuningTrust"] = "commanded"
	hang = 250
	override: "stopped" | "config" | null = null
	throwFrequency = false

	getStatus(): LiveDemodStatus {
		return {
			enabled: true,
			running: this.running,
			sourceId: this.sourceId,
			sourceConnected: true,
			sourceIqSampleRate: 2_048_000,
			config: this.demodConfig(),
			effectiveSampleRate: 25_000,
			decimationFactor: 1,
			httpUrl: "http://127.0.0.1/stream",
			wavUrl: "http://127.0.0.1/stream.wav",
			clientCount: 0,
			bytesStreamed: 0,
			pipelineHealth: this.running ? "running" : "stopped",
			pipelineRestarts: 0,
			squelchOpen: this.squelchOpen,
			thresholdDbfs: this.thresholdDbfs,
		}
	}

	demodConfig(): LiveDemodConfig {
		return {
			enabled: true,
			sourceId: this.sourceId,
			httpPort: 8081,
			modulation: this.modulation,
			bandwidth: this.bandwidth,
			squelch: this.squelch,
			squelchMode: this.squelchMode,
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
		return this.running && this.squelchOpen
	}

	squelchHangMs(): number {
		return this.hang
	}

	transmissionCloseOverride(): "stopped" | "config" | null {
		return this.override
	}

	gate(open: boolean): void {
		this.squelchOpen = open
		this.emit("squelch-changed", open)
	}

	level(power: number | null): void {
		const level: LiveAudioLevel = {
			sourceId: this.sourceId,
			channelPowerDbfs: power,
			noiseFloorDbfs: null,
			squelchOpen: this.squelchOpen,
			thresholdDbfs: this.thresholdDbfs,
		}
		this.emit("level", level)
	}

	reconfigure(patch: Partial<LiveDemodConfig>): void {
		if (patch.sourceId !== undefined) this.sourceId = patch.sourceId
		if (patch.modulation !== undefined) this.modulation = patch.modulation
		if (patch.bandwidth !== undefined) this.bandwidth = patch.bandwidth
		if (patch.offsetHz !== undefined) this.offsetHz = patch.offsetHz
		if (patch.squelchMode !== undefined) this.squelchMode = patch.squelchMode
		if (patch.squelch !== undefined) this.squelch = patch.squelch
		this.emit("config-changed", this.demodConfig())
	}
}

function harness(options?: { maxDurationMs?: number }) {
	const source = new FakeSource()
	let now = 1_700_000_000_000
	let seq = 0
	const events: AnalogTransmissionEventData[] = []
	const closed: string[] = []
	const tracker = new AnalogTransmissionTracker({
		source,
		frequencyAt: (_sourceId, offsetHz) => {
			if (source.throwFrequency) throw new Error("tuner down")
			if (source.frequencyHz === null) return null
			return {
				hz: source.frequencyHz + offsetHz,
				tuningTrust: source.trust,
			}
		},
		now: () => now,
		randomUUID: () => `tx-${++seq}`,
		...(options?.maxDurationMs === undefined
			? {}
			: { maxDurationMs: options.maxDurationMs }),
	})
	tracker.on("transmission", event => {
		events.push(event)
	})
	tracker.on("closed", payload => {
		closed.push(payload.transmissionId)
	})
	tracker.start()
	return {
		source,
		tracker,
		events,
		closed,
		setNow: (value: number) => {
			now = value
		},
		advance: (ms: number) => {
			now += ms
		},
	}
}

describe("analog transmission tracker", () => {
	it("produces no transmission when manual squelch is 0", () => {
		const { source, events } = harness()
		source.squelch = 0
		source.gate(true)
		source.level(-20)
		source.gate(false)
		expect(events).toEqual([])
	})

	it("opens in auto mode even when the manual threshold is 0", () => {
		const { source, events } = harness()
		source.squelch = 0
		source.squelchMode = "auto"
		source.gate(true)
		expect(events).toHaveLength(1)
		expect(events[0]).toMatchObject({ state: "open", squelchMode: "auto" })
	})

	it("pairs an open with a squelch close and subtracts the hang", () => {
		const { source, events, closed, setNow } = harness()
		setNow(1_000)
		source.gate(true)
		setNow(5_000)
		source.level(-10)
		source.level(null)
		source.level(-30)
		setNow(8_000)
		source.gate(false)
		expect(events.map(event => event.state)).toEqual(["open", "closed"])
		expect(events[1]).toMatchObject({
			transmissionId: "tx-1",
			state: "closed",
			closeReason: "squelch",
			startedAt: new Date(1_000).toISOString(),
			endedAt: new Date(7_750).toISOString(),
			durationMs: 6_750,
			peakChannelPowerDbfs: -10,
			meanChannelPowerDbfs: -20,
			frequency: { hz: 446_000_000, tuningTrust: "commanded" },
		})
		expect(closed).toEqual(["tx-1"])
		expect(toActivityPayload(events[1]!).transmissionId).toBe("tx-1")
	})

	it("never ends a short squelch close before it started", () => {
		const { source, events, setNow } = harness()
		setNow(1_000)
		source.gate(true)
		setNow(1_100)
		source.gate(false)
		expect(events[1]).toMatchObject({
			endedAt: new Date(1_000).toISOString(),
			durationMs: 0,
			closeReason: "squelch",
		})
	})

	it("uses the close time for stopped and config", () => {
		const stopped = harness()
		stopped.setNow(1_000)
		stopped.source.gate(true)
		stopped.setNow(5_000)
		stopped.source.emit("stopped")
		expect(stopped.events[1]).toMatchObject({
			closeReason: "stopped",
			endedAt: new Date(5_000).toISOString(),
			durationMs: 4_000,
		})

		const configured = harness()
		configured.setNow(1_000)
		configured.source.gate(true)
		configured.setNow(5_000)
		configured.source.reconfigure({ modulation: "am" })
		expect(configured.events[1]).toMatchObject({
			closeReason: "config",
			endedAt: new Date(5_000).toISOString(),
			durationMs: 4_000,
			modulation: "nfm",
		})
		expect(configured.events).toHaveLength(2)
	})

	it("keeps a transmission open across a threshold-only change", () => {
		const { source, tracker, events } = harness()
		source.gate(true)
		source.thresholdDbfs = -30
		source.reconfigure({ squelch: -30 })
		expect(tracker.current()?.transmissionId).toBe("tx-1")
		expect(events).toHaveLength(1)
		source.reconfigure({ bandwidth: 25_000 })
		expect(events[1]?.closeReason).toBe("config")
		expect(tracker.current()).toBeNull()
	})

	it("closes on source, offset and squelch mode, and does not reopen", () => {
		for (const patch of [
			{ sourceId: "rtl1" },
			{ offsetHz: 12_500 },
			{ squelchMode: "auto" as const },
		]) {
			const { source, events, tracker } = harness()
			source.gate(true)
			source.reconfigure(patch)
			expect(events[1]?.closeReason).toBe("config")
			expect(tracker.current()).toBeNull()
			expect(events).toHaveLength(2)
		}
	})

	it("ends a retune at the retune time, without subtracting the squelch hang", () => {
		const { source, events, setNow } = harness()
		setNow(5_000)
		source.gate(true)
		setNow(7_000)
		source.frequencyHz = 446_000_500
		source.level(-15)
		expect(events[1]).toMatchObject({
			closeReason: "retune",
			endedAt: new Date(7_000).toISOString(),
			durationMs: 2_000,
		})
	})

	it("ends a retune and opens the next transmission at the new frequency", () => {
		const { source, events } = harness()
		source.gate(true)
		source.frequencyHz = 446_000_001
		source.level(-15)
		expect(events).toHaveLength(1)
		source.frequencyHz = 446_000_003
		source.level(-12)
		expect(events.map(event => event.state)).toEqual(["open", "closed", "open"])
		expect(events[1]).toMatchObject({
			closeReason: "retune",
			transmissionId: "tx-1",
			frequency: { hz: 446_000_000 },
			peakChannelPowerDbfs: -12,
		})
		expect(events[2]).toMatchObject({
			state: "open",
			transmissionId: "tx-2",
			frequency: { hz: 446_000_003 },
			peakChannelPowerDbfs: null,
		})
	})

	it("treats a null-ness change as a retune and a frequencyAt failure as unknown", () => {
		const { source, events } = harness()
		source.frequencyHz = null
		source.gate(true)
		expect(events[0]?.frequency).toBeNull()
		source.frequencyHz = 100_000_000
		source.level(-20)
		expect(events[1]).toMatchObject({
			closeReason: "retune",
			frequency: null,
		})
		expect(events[2]?.frequency).toEqual({
			hz: 100_000_000,
			tuningTrust: "commanded",
		})

		const thrown = harness()
		thrown.source.throwFrequency = true
		thrown.source.gate(true)
		expect(thrown.events[0]?.frequency).toBeNull()
	})

	it("rolls a max-duration transmission into a new one while the squelch is open", () => {
		const { source, events, setNow } = harness({ maxDurationMs: 1_000 })
		setNow(10_000)
		source.gate(true)
		source.level(-8)
		setNow(11_000)
		source.level(-6)
		expect(events.map(event => [event.state, event.closeReason])).toEqual([
			["open", null],
			["closed", "max-duration"],
			["open", null],
		])
		expect(events[1]).toMatchObject({
			transmissionId: "tx-1",
			peakChannelPowerDbfs: -6,
			// The squelch is still open: no hang to subtract (R1 m1).
			durationMs: 1_000,
		})
		expect(events[2]).toMatchObject({
			transmissionId: "tx-2",
			startedAt: new Date(11_000).toISOString(),
			peakChannelPowerDbfs: null,
		})
	})

	it("does not reopen after max-duration when the squelch has closed", () => {
		const { source, events, setNow } = harness({ maxDurationMs: 1_000 })
		setNow(0)
		source.gate(true)
		source.squelchOpen = false
		setNow(1_000)
		source.level(-6)
		expect(events.map(event => event.state)).toEqual(["open", "closed"])
		expect(events[1]?.closeReason).toBe("max-duration")
	})

	it("does not open while stopped, and stop() closes then detaches", () => {
		const { source, tracker, events } = harness()
		source.running = false
		source.gate(true)
		expect(events).toEqual([])
		source.running = true
		source.squelchOpen = false
		source.gate(true)
		expect(tracker.current()?.state).toBe("open")
		tracker.stop()
		expect(events[1]).toMatchObject({ closeReason: "stopped" })
		source.gate(false)
		source.gate(true)
		expect(events).toHaveLength(2)
	})

	it("reads a squelch drop during stop or reconfigure as that reason", () => {
		const stopped = harness()
		stopped.source.override = "stopped"
		stopped.source.gate(true)
		stopped.source.gate(false)
		expect(stopped.events[1]?.closeReason).toBe("stopped")

		const configured = harness()
		configured.source.override = "config"
		configured.source.gate(true)
		configured.source.gate(false)
		expect(configured.events[1]?.closeReason).toBe("config")
	})

	it("keeps the open frequency when later samples do not move it", () => {
		const { source, tracker, events } = harness()
		source.gate(true)
		source.trust = "relay"
		source.level(-40)
		expect(tracker.current()?.frequency).toEqual({
			hz: 446_000_000,
			tuningTrust: "commanded",
		})
		expect(events).toHaveLength(1)
	})

	it("does not let a subscriber error escape into the source", () => {
		const { source, tracker, events, closed } = harness()
		tracker.on("transmission", () => {
			throw new Error("listener failed")
		})
		expect(() => source.gate(true)).not.toThrow()
		expect(() => source.gate(false)).not.toThrow()
		expect(events.map(event => event.state)).toEqual(["open", "closed"])
		expect(closed).toEqual(["tx-1"])
	})

	it("rejects an open event as an activity payload", () => {
		const { events, source } = harness()
		source.gate(true)
		expect(() => toActivityPayload(events[0]!)).toThrow(WaveKitError)
	})

	it("returns an independent current snapshot", () => {
		const { source, tracker } = harness()
		source.gate(true)
		const first = tracker.current()
		source.level(-5)
		expect(first?.peakChannelPowerDbfs).toBeNull()
		expect(tracker.current()?.peakChannelPowerDbfs).toBe(-5)
	})
})
