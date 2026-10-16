import { EventEmitter } from "node:events"
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import type { AnalogTransmissionEventData } from "@wavekit/api-types"
import { AnalogTransmissionTracker } from "../../../src/core/analog-transmission.js"
import type { AnalogTransmissionSource } from "../../../src/core/analog-transmission.js"
import {
	buildActivityRow,
	parseStoredRecord,
	parseStoredSummary,
} from "../../../src/core/activity/storage/row.js"
import { ACTIVITY_RECORD_VERSION } from "../../../src/core/activity/storage/contract.js"
import type { AnalogTransmissionPayload } from "../../../src/core/activity/storage/contract.js"
import { MAX_SUMMARY_BYTES } from "../../../src/core/activity/storage/contract.js"
import type {
	LiveAudioLevel,
	LiveDemodConfig,
	LiveDemodStatus,
} from "../../../src/core/live-demodulator.js"

class FakeSource extends EventEmitter implements AnalogTransmissionSource {
	running = true
	squelchOpen = false
	squelch = -40
	squelchMode: "manual" | "auto" = "manual"
	sourceId = "rtl0"
	modulation: LiveDemodConfig["modulation"] = "nfm"
	bandwidth = 12_500
	offsetHz = 0
	frequencyHz: number | null = 146_000_000

	getStatus(): LiveDemodStatus {
		return {
			enabled: true,
			running: this.running,
			sourceId: this.sourceId,
			sourceConnected: true,
			sourceIqSampleRate: 1_024_000,
			config: {
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
			},
			effectiveSampleRate: 25_000,
			decimationFactor: 1,
			httpUrl: "http://127.0.0.1/stream",
			wavUrl: "http://127.0.0.1/stream.wav",
			clientCount: 0,
			bytesStreamed: 0,
			pipelineHealth: this.running ? "running" : "stopped",
			pipelineRestarts: 0,
			thresholdDbfs: this.squelch,
		}
	}

	isSquelchOpen(): boolean {
		return this.running && this.squelchOpen
	}

	squelchHangMs(): number {
		return 250
	}

	gated(): boolean {
		return this.running && (this.squelchMode === "auto" || this.squelch !== 0)
	}
}

type Command =
	| { t: "squelch"; open: boolean }
	| { t: "level"; power: number | null }
	| { t: "retune"; hz: number | null }
	| { t: "modulation"; modulation: LiveDemodConfig["modulation"] }
	| { t: "bandwidth"; bandwidth: number }
	| { t: "offset"; offsetHz: number }
	| { t: "source"; sourceId: string }
	| { t: "mode"; mode: "manual" | "auto" }
	| { t: "threshold"; squelch: number }
	| { t: "running"; running: boolean }
	| { t: "stop" }
	| { t: "advance"; ms: number }

const commandArb: fc.Arbitrary<Command> = fc.oneof(
	fc.record({
		t: fc.constant("squelch" as const),
		open: fc.boolean(),
	}),
	fc.record({
		t: fc.constant("level" as const),
		power: fc.option(fc.integer({ min: -160, max: 0 }), { nil: null }),
	}),
	fc.record({
		t: fc.constant("retune" as const),
		hz: fc.option(fc.integer({ min: 0, max: 2_000_000_000 }), { nil: null }),
	}),
	fc.record({
		t: fc.constant("modulation" as const),
		modulation: fc.constantFrom(
			"nfm",
			"wfm",
			"am",
			"usb",
			"lsb",
			"dsb",
			"cw",
			"raw",
		),
	}),
	fc.record({
		t: fc.constant("bandwidth" as const),
		bandwidth: fc.integer({ min: 0, max: 200_000 }),
	}),
	fc.record({
		t: fc.constant("offset" as const),
		offsetHz: fc.integer({ min: -1_000_000, max: 1_000_000 }),
	}),
	fc.record({
		t: fc.constant("source" as const),
		sourceId: fc.string({ minLength: 0, maxLength: 12 }),
	}),
	fc.record({
		t: fc.constant("mode" as const),
		mode: fc.constantFrom("manual", "auto"),
	}),
	fc.record({
		t: fc.constant("threshold" as const),
		squelch: fc.integer({ min: -160, max: 0 }),
	}),
	fc.record({
		t: fc.constant("running" as const),
		running: fc.boolean(),
	}),
	fc.constant({ t: "stop" as const }),
	fc.record({
		t: fc.constant("advance" as const),
		ms: fc.integer({ min: 0, max: 20_000 }),
	}),
)

function apply(source: FakeSource, command: Command): void {
	switch (command.t) {
		case "squelch":
			source.squelchOpen = command.open
			source.emit("squelch-changed", command.open)
			return
		case "level":
			source.emit("level", level(source, command.power))
			return
		case "retune":
			source.frequencyHz = command.hz
			source.emit("level", level(source, -20))
			return
		case "modulation":
			source.modulation = command.modulation
			source.emit("config-changed", source.getStatus().config)
			return
		case "bandwidth":
			source.bandwidth = command.bandwidth
			source.emit("config-changed", source.getStatus().config)
			return
		case "offset":
			source.offsetHz = command.offsetHz
			source.emit("config-changed", source.getStatus().config)
			return
		case "source":
			source.sourceId = command.sourceId
			source.emit("config-changed", source.getStatus().config)
			return
		case "mode":
			source.squelchMode = command.mode
			source.emit("config-changed", source.getStatus().config)
			return
		case "threshold":
			source.squelch = command.squelch
			source.emit("config-changed", source.getStatus().config)
			return
		case "running":
			source.running = command.running
			return
		case "stop":
			source.running = false
			source.squelchOpen = false
			source.emit("stopped")
			return
		case "advance":
			return
	}
}

function level(source: FakeSource, power: number | null): LiveAudioLevel {
	return {
		sourceId: source.sourceId,
		channelPowerDbfs: power,
		noiseFloorDbfs: null,
		squelchOpen: source.squelchOpen,
		thresholdDbfs: source.squelch,
	}
}

function assertPaired(events: readonly AnalogTransmissionEventData[]): void {
	let openId: string | null = null
	const seen = new Set<string>()
	for (const event of events) {
		if (event.state === "open") {
			expect(openId).toBeNull()
			expect(seen.has(event.transmissionId)).toBe(false)
			expect(event.endedAt).toBeNull()
			expect(event.durationMs).toBeNull()
			expect(event.closeReason).toBeNull()
			openId = event.transmissionId
			continue
		}
		expect(openId).toBe(event.transmissionId)
		expect(event.endedAt).not.toBeNull()
		expect(event.durationMs).not.toBeNull()
		expect(event.durationMs!).toBeGreaterThanOrEqual(0)
		expect(Date.parse(event.endedAt!)).toBeGreaterThanOrEqual(
			Date.parse(event.startedAt),
		)
		expect(event.durationMs).toBe(
			Date.parse(event.endedAt!) - Date.parse(event.startedAt),
		)
		openId = null
		seen.add(event.transmissionId)
	}
	expect(openId).toBeNull()
}

describe("analog transmission properties", () => {
	it("pairs every open with one close and never opens while ungated", () => {
		// Feature: web-gaps-1, Property 5: Transmission pairing
		// Validates: Requirements 3.1, 3.2, 3.3, 3.5, 3.6, 3.8
		fc.assert(
			fc.property(
				fc.array(commandArb, { minLength: 0, maxLength: 24 }),
				commands => {
					const source = new FakeSource()
					let now = 1_700_000_000_000
					let seq = 0
					const events: AnalogTransmissionEventData[] = []
					const tracker = new AnalogTransmissionTracker({
						source,
						maxDurationMs: 5_000,
						now: () => now,
						randomUUID: () => `id-${seq++}`,
						frequencyAt: (_sourceId, offsetHz) => {
							if (source.frequencyHz === null) return null
							return {
								hz: source.frequencyHz + offsetHz,
								tuningTrust: "commanded",
							}
						},
					})
					tracker.on("transmission", event => {
						if (event.state === "open") expect(source.gated()).toBe(true)
						events.push(event)
					})
					tracker.start()
					for (const command of commands) {
						if (command.t === "advance") now += command.ms
						apply(source, command)
					}
					tracker.stop()
					assertPaired(events)
				},
			),
			{ numRuns: 100 },
		)
	})

	it("round-trips a transmission row inside the summary budget", () => {
		// Feature: web-gaps-1, Property 6: Transmission row round trip
		// Validates: Requirements 4.1, 4.2, 4.4
		const payloadArb: fc.Arbitrary<AnalogTransmissionPayload> = fc
			.record({
				transmissionId: fc.uuid(),
				sourceId: fc.string({ minLength: 0, maxLength: 40 }),
				startedMs: fc.integer({
					min: 1_500_000_000_000,
					max: 1_900_000_000_000,
				}),
				durationMs: fc.integer({ min: 0, max: 600_000 }),
				hz: fc.option(fc.integer({ min: 0, max: 6_000_000_000 }), {
					nil: null,
				}),
				trust: fc.constantFrom("commanded", "relay", "unverified"),
				modulation: fc.constantFrom(
					"nfm",
					"wfm",
					"am",
					"usb",
					"lsb",
					"dsb",
					"cw",
					"raw",
				),
				bandwidthHz: fc.integer({ min: 0, max: 500_000 }),
				squelchMode: fc.constantFrom("manual", "auto"),
				thresholdDbfs: fc.integer({ min: -160, max: 0 }),
				peak: fc.option(fc.integer({ min: -160, max: 0 }), { nil: null }),
				mean: fc.option(fc.integer({ min: -160, max: 0 }), { nil: null }),
				closeReason: fc.constantFrom(
					"squelch",
					"retune",
					"config",
					"stopped",
					"max-duration",
				),
			})
			.map(
				(value): AnalogTransmissionPayload => ({
					transmissionId: value.transmissionId,
					sourceId: value.sourceId,
					startedAt: new Date(value.startedMs).toISOString(),
					endedAt: new Date(value.startedMs + value.durationMs).toISOString(),
					durationMs: value.durationMs,
					frequency:
						value.hz === null
							? null
							: { hz: value.hz, tuningTrust: value.trust },
					modulation: value.modulation,
					bandwidthHz: value.bandwidthHz,
					squelchMode: value.squelchMode,
					thresholdDbfs: value.thresholdDbfs,
					peakChannelPowerDbfs: value.peak,
					meanChannelPowerDbfs: value.mean,
					closeReason: value.closeReason,
				}),
			)
		fc.assert(
			fc.property(payloadArb, payload => {
				const row = buildActivityRow({
					version: ACTIVITY_RECORD_VERSION,
					eventId: payload.transmissionId,
					commitSeq: "0",
					producedAt: payload.endedAt,
					receivedAt: payload.endedAt,
					kind: "analog-transmission",
					payload,
				})
				expect(Buffer.byteLength(row.summaryJson, "utf8")).toBeLessThanOrEqual(
					MAX_SUMMARY_BYTES,
				)
				expect(row.kind).toBe("analog-transmission")
				expect(row.eventId).toBe(payload.transmissionId)
				expect(row.category).toBe("voice")
				expect(row.protocol).toBe("analog")
				expect(row.decoderId).toBeNull()
				expect(row.entityKey).toBeNull()
				expect(row.sourceId).toBe(payload.sourceId)
				expect(row.frequencyHz).toBe(
					payload.frequency === null ? null : payload.frequency.hz,
				)
				expect(row.refs).toEqual([])
				const stored = {
					seq: "7",
					event_id: row.eventId,
					kind: row.kind,
					summary_json: row.summaryJson,
					record_json: row.recordJson,
				}
				const record = parseStoredRecord(stored)
				expect(record).toMatchObject({
					kind: "analog-transmission",
					eventId: payload.transmissionId,
					commitSeq: "7",
					producedAt: payload.endedAt,
					payload,
				})
				const summary = parseStoredSummary(stored)
				expect(summary.kind).toBe("analog-transmission")
				expect(summary.category).toBe("voice")
				expect(summary.protocol).toBe("analog")
				expect(summary.decoderId).toBeNull()
				expect(summary.entityKey).toBeNull()
				expect(summary.sourceId).toBe(payload.sourceId)
				expect(summary.frequencyHz).toBe(row.frequencyHz)
				expect(
					summary.title?.startsWith(payload.modulation.toUpperCase()),
				).toBe(true)
				const keys = summary.fields.map(field => field.key)
				expect(keys[0]).toBe("durationMs")
				expect(summary.fields[0]).toMatchObject({
					value: payload.durationMs,
					unit: "ms",
				})
				expect(keys[1]).toBe("modulation")
				if (payload.peakChannelPowerDbfs === null) expect(keys).toHaveLength(2)
				else {
					expect(keys).toEqual([
						"durationMs",
						"modulation",
						"peakChannelPowerDbfs",
					])
					expect(summary.fields[2]).toMatchObject({
						value: payload.peakChannelPowerDbfs,
						unit: "dBFS",
					})
				}
			}),
			{ numRuns: 100 },
		)
	})
})
