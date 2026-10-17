import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { RTL_TUNER_GAIN_TABLES } from "@wavekit/api-types"
import type { ExtendedSourceStatus, TunerState } from "@wavekit/api-types"
import type { ReceiverCaps, TunerRelayView } from "../../src/data/index.ts"
import {
	controlAvailability,
	controlErrorText,
	controlNote,
	rateLabel,
	rateWarning,
	receiverLock,
	sampleRateOptions,
} from "../../src/features/receiver/controls.ts"
import {
	gainAt,
	gainHint,
	gainSteps,
	nearestGainIndex,
	snapGain,
} from "../../src/features/receiver/gain.ts"

const R820T = RTL_TUNER_GAIN_TABLES[5]?.valuesTenthsDb ?? []

const IDS = [
	"frequency",
	"sampleRate",
	"gainMode",
	"gain",
	"ppm",
	"ifGain",
	"testMode",
	"agcMode",
	"directSampling",
	"offsetTuning",
	"rtlXtal",
	"tunerXtal",
	"gainIndex",
	"biasTee",
	"tunerIfGain",
]

function caps(over: Partial<ReceiverCaps> = {}, rtl = true): ReceiverCaps {
	return {
		schemaVersion: 1,
		sourceId: "rtl-0",
		sessionId: "b".repeat(32),
		snapshotId: "c".repeat(32),
		capturedAt: "2026-10-17T10:00:00.000Z",
		source: {
			type: rtl ? "rtl_tcp" : "sdrpp-network",
			kind: "iq",
			format: "U8_IQ",
		},
		connection: "connected",
		peerHeader: { state: "advertised", tunerType: 5, gainCount: 29 },
		controls: IDS.map(id => ({
			id,
			unit: "x",
			command: {
				state: "implemented" as const,
				validation: {
					rule:
						id === "gain"
							? { kind: "integer-range" as const, min: 0, max: 500 }
							: { kind: "boolean" as const },
				},
			},
			transport: rtl
				? { state: "applicable" as const, reason: "rtl-tcp" }
				: { state: "not-applicable" as const, reason: "non-rtl-transport" },
		})),
		declaredStream: { sampleRateHz: 2_400_000, centerFrequencyHz: 161_500_000 },
		sampleRatePresets: {
			state: "suggested",
			valuesHz: [250_000, 1_024_000, 2_048_000, 2_400_000, 3_200_000],
		},
		gainTable: {
			state: "suggested",
			tuner: "R820T",
			valuesTenthsDb: [...R820T],
		},
		...over,
	}
}

const tuner = (over: Partial<TunerState> = {}): TunerState => ({
	sourceId: "rtl-0",
	frequency: 161_500_000,
	sampleRate: 2_400_000,
	gainMode: "manual",
	gain: 297,
	ppm: 0,
	agcMode: false,
	biasTee: false,
	directSampling: "off",
	offsetTuning: false,
	ifGain: 0,
	tunerIfGain: null,
	testMode: false,
	controlMode: "internal",
	commandCount: 0,
	...over,
})

describe("gain table mapping", () => {
	it("uses the tuner's table from the capabilities", () => {
		const steps = gainSteps(caps())
		expect(steps.source).toBe("table")
		expect(steps.tuner).toBe("R820T")
		expect(steps.valuesTenthsDb).toHaveLength(29)
		expect(gainHint(steps)).toBe("Steps follow the R820T's own gain table.")
		expect(nearestGainIndex(steps, 297)).toBe(16)
		expect(gainAt(steps, 16)).toBe(297)
		expect(gainAt(steps, 99)).toBe(496)
		expect(gainAt(steps, -3)).toBe(0)
		// 30.0 dB sits between 29.7 and 32.8: nearest is 29.7
		expect(snapGain(steps, 300)).toBe(297)
		expect(snapGain(steps, 115)).toBe(125)
		expect(snapGain(steps, 11)).toBe(9)
		// a tie goes to the lower step (2.7 and 3.7 around 3.2)
		expect(snapGain(steps, 32)).toBe(27)
	})

	it("falls back to 1 dB steps, saying why, without a table", () => {
		const header = gainSteps(
			caps({
				gainTable: { state: "unknown", reason: "header-not-advertised" },
			}),
		)
		expect(header.source).toBe("fallback")
		expect(header.valuesTenthsDb).toHaveLength(51)
		expect(header.valuesTenthsDb[1]).toBe(10)
		expect(gainHint(header)).toMatch(
			/^The receiver has not sent its tuner header yet/,
		)
		expect(gainSteps(null).reason).toBe("Receiver capabilities unavailable")
		const { gainTable: _omit, ...older } = caps()
		expect(gainSteps(older).reason).toBe(
			"This core does not report a gain table",
		)
	})

	it("keeps table values inside the command range, sorted and unique", () => {
		const steps = gainSteps(
			caps({
				gainTable: {
					state: "suggested",
					tuner: "FC0013",
					valuesTenthsDb: [-99, -73, 58, 58, 197, 600],
				},
			}),
		)
		expect(steps.valuesTenthsDb).toEqual([58, 197])
	})

	it("snaps any gain to a table value no farther than any other (property)", () => {
		// Feature: web receiver controls, Property 1: gain snaps to the nearest table step
		const steps = gainSteps(caps())
		fc.assert(
			fc.property(fc.integer({ min: -100, max: 700 }), g => {
				const snapped = snapGain(steps, g)
				expect(steps.valuesTenthsDb).toContain(snapped)
				for (const v of steps.valuesTenthsDb)
					expect(Math.abs(snapped - g)).toBeLessThanOrEqual(Math.abs(v - g))
				expect(gainAt(steps, nearestGainIndex(steps, g))).toBe(snapped)
			}),
			{ numRuns: 200 },
		)
	})
})

describe("control availability", () => {
	it("enables the RTL controls on an rtl_tcp source, with hardware caveats", () => {
		const c = caps()
		expect(controlAvailability("gain", c)).toEqual({
			enabled: true,
			reason: null,
		})
		expect(controlAvailability("sampleRate", c).enabled).toBe(true)
		expect(controlAvailability("biasTee", c)).toMatchObject({ enabled: true })
		expect(controlAvailability("biasTee", c).reason).toMatch(/bias-T/)
	})

	it("disables offset tuning on a tuner that is not an E4000", () => {
		expect(controlAvailability("offsetTuning", caps())).toEqual({
			enabled: false,
			reason: "Only E4000 tuners have offset tuning; this one is R820T",
		})
		expect(
			controlAvailability(
				"offsetTuning",
				caps({
					gainTable: {
						state: "suggested",
						tuner: "E4000",
						valuesTenthsDb: [0],
					},
				}),
			).enabled,
		).toBe(true)
		// unknown tuner: allowed, the core decides
		expect(controlAvailability("offsetTuning", null).enabled).toBe(true)
	})

	it("disables every control on a source the core cannot command", () => {
		const c = caps({}, false)
		for (const id of ["gain", "agcMode", "ppm", "directSampling"] as const)
			expect(controlAvailability(id, c)).toEqual({
				enabled: false,
				reason: "Not an rtl_tcp source: WaveKit cannot command it",
			})
		const missing = caps({ controls: [] })
		expect(controlAvailability("ppm", missing).reason).toBe(
			"This core does not offer it",
		)
	})

	it("offers the capability presets plus the current rate, or the RTL defaults", () => {
		expect(sampleRateOptions(caps(), 1_800_000)).toEqual([
			250_000, 1_024_000, 1_800_000, 2_048_000, 2_400_000, 3_200_000,
		])
		expect(sampleRateOptions(null, 2_400_000)).toHaveLength(11)
		expect(
			sampleRateOptions(
				caps({
					sampleRatePresets: {
						state: "not-applicable",
						reason: "non-rtl-transport",
					},
				}),
				2_400_000,
			),
		).toEqual([])
		expect(rateLabel(250_000)).toBe("0.25")
		expect(rateLabel(1_024_000)).toBe("1.024")
		expect(rateLabel(2_400_000)).toBe("2.4")
		expect(rateWarning(2_400_000)).toBeNull()
		expect(rateWarning(2_560_000)).toMatch(/drop samples/)
	})
})

describe("receiver lock", () => {
	const source = { id: "rtl-0", connected: true } as ExtendedSourceStatus
	const relay: TunerRelayView = {
		enabled: true,
		listening: true,
		port: 1234,
		sourceId: "rtl-0",
		clientsConnected: 1,
		controlClientRemote: "192.168.1.23:51544",
		controlPolicy: "exclusive",
	}

	it("is open when WaveKit has control of a connected source", () => {
		expect(
			receiverLock({ tuner: tuner(), source, readOnly: false, relay: null }),
		).toEqual({
			locked: false,
			reason: null,
			canReclaim: false,
		})
		expect(controlNote(tuner(), { ...relay, clientsConnected: 0 })).toBe(
			"WaveKit has control. SDR++ can take over through the relay on port 1234.",
		)
	})

	it("names the relay client holding the tuner and offers to take control back", () => {
		const lock = receiverLock({
			tuner: tuner({ controlMode: "external" }),
			source,
			readOnly: false,
			relay,
		})
		expect(lock.locked).toBe(true)
		expect(lock.canReclaim).toBe(true)
		expect(lock.reason).toMatch(
			/^An rtl_tcp client at 192\.168\.1\.23:51544 has the tuner/,
		)
		expect(controlNote(tuner({ controlMode: "external" }), relay)).toBeNull()
	})

	it("locks a read-only session and an offline source", () => {
		expect(
			receiverLock({ tuner: tuner(), source, readOnly: true, relay: null })
				.reason,
		).toMatch(/^Read-only/)
		expect(
			receiverLock({
				tuner: tuner(),
				source: { ...source, connected: false },
				readOnly: false,
				relay: null,
			}).reason,
		).toMatch(/offline/)
		expect(
			receiverLock({ tuner: undefined, source, readOnly: false, relay: null })
				.locked,
		).toBe(true)
	})

	it("words the core's errors", () => {
		expect(
			controlErrorText({
				code: "TUNER_CONTROL_EXTERNAL",
				status: 409,
				message: "x",
			}),
		).toMatch(/take control back/)
		expect(
			controlErrorText({
				code: "TUNER_VALIDATION_ERROR",
				status: 400,
				message: "ppm out of range: 900 (expected -500-500)",
			}),
		).toBe("The core refused it: ppm out of range: 900 (expected -500-500)")
		expect(
			controlErrorText({ code: "AUTH_REQUIRED", status: 401, message: "x" }),
		).toMatch(/Sign in/)
		expect(
			controlErrorText({ code: null, status: 0, message: "Failed to fetch" }),
		).toMatch(/did not answer/)
		expect(
			controlErrorText({
				code: "TUNER_ERROR",
				status: 500,
				message: "Source rtl-0 not connected",
			}),
		).toBe("Source rtl-0 not connected")
	})
})
