import { EventEmitter } from "node:events"
import fc from "fast-check"
import pino from "pino"
import { describe, expect, it, vi } from "vitest"
import type { SourceCaps } from "../../../src/config.js"
import { tunerFrequencyAt } from "../../../src/core/analog-transmission.js"
import { SpectrumEngine } from "../../../src/core/spectrum/spectrum-engine.js"
import type { TuningTrust } from "../../../src/core/spectrum/types.js"
import type { SourceManager } from "../../../src/core/source-manager.js"
import { TunerController } from "../../../src/core/tuner-controller.js"
import { tuningTrustOf } from "../../../src/core/tuning-trust.js"
import type { TuningTrustInput } from "../../../src/core/tuning-trust.js"
import { FakeSources, testSettings } from "../../mocks/scanner/engine-fakes.js"

const logger = pino({ level: "silent" })
/** rtl_tcp opcodes (protocol constants). */
const RTL_TCP_COMMANDS = { SET_FREQUENCY: 0x01, SET_SAMPLE_RATE: 0x02 } as const

/** Oracle for requirement 3.1, written independently of the implementation. */
function oracle(state: unknown): TuningTrust {
	if (typeof state !== "object" || state === null) return "unverified"
	const s = state as Record<string, unknown>
	for (const key of ["unknownFields", "declaredOnlyFields"]) {
		const list = s[key]
		if (list === undefined) continue
		if (!Array.isArray(list)) return "unverified"
		if (list.some(v => typeof v !== "string")) return "unverified"
		if (list.includes("frequency") || list.includes("sampleRate"))
			return "unverified"
	}
	if (s["controlMode"] === "external") return "relay"
	if (s["controlMode"] === "internal") return "commanded"
	return "unverified"
}

const fieldName = fc.constantFrom(
	"frequency",
	"sampleRate",
	"gain",
	"gainMode",
	"ppm",
	"testMode",
)
const list = fc.oneof(
	fc.constant(undefined),
	fc.array(fieldName, { maxLength: 4 }),
	fc.array(fc.oneof(fieldName, fc.integer(), fc.constant(null)), {
		maxLength: 3,
	}),
	fc.constantFrom("frequency", 7, null, {}),
)
const stateArb: fc.Arbitrary<unknown> = fc.oneof(
	{ weight: 1, arbitrary: fc.constantFrom(null, undefined, 0, "x") },
	{
		weight: 8,
		arbitrary: fc.record(
			{
				frequency: fc.constant(446_000_000),
				controlMode: fc.oneof(
					fc.constantFrom("internal", "external"),
					fc.constantFrom("INTERNAL", "", undefined, 1),
				),
				unknownFields: list,
				declaredOnlyFields: list,
			},
			{ requiredKeys: ["frequency"] },
		),
	},
)

/** Reaches the engine's two private derivation sites without starting a pipeline. */
type EngineTrustSites = {
	initialTrust(): TuningTrust
	stateTrust(): TuningTrust
}

function engineFor(state: unknown, written?: boolean): EngineTrustSites {
	const tuner = Object.assign(new EventEmitter(), {
		getState: () => state as never,
		...(written === undefined
			? {}
			: { tuningWrittenOnConnection: () => written }),
	})
	const engine = new SpectrumEngine({
		sourceId: "rtl",
		sources: new FakeSources(),
		routing: {
			getFanout: () => undefined as never,
			releaseUnused: () => undefined,
		},
		tuner,
		settings: () => testSettings(),
		logger,
	})
	return engine as unknown as EngineTrustSites
}

describe("tuningTrustOf (WG9 req 3.1)", () => {
	it("is unverified for missing, null and malformed state", () => {
		expect(tuningTrustOf(undefined)).toBe("unverified")
		expect(tuningTrustOf(null)).toBe("unverified")
		expect(tuningTrustOf("internal" as never)).toBe("unverified")
		expect(
			tuningTrustOf({
				controlMode: "internal",
				unknownFields: "gain" as never,
			}),
		).toBe("unverified")
		expect(
			tuningTrustOf({
				controlMode: "internal",
				declaredOnlyFields: [3] as never,
			}),
		).toBe("unverified")
		expect(tuningTrustOf({ controlMode: "other" as never })).toBe("unverified")
		expect(tuningTrustOf({} as TuningTrustInput)).toBe("unverified")
	})

	it("is unverified when frequency or sample rate is unknown or declared only", () => {
		for (const key of ["unknownFields", "declaredOnlyFields"] as const)
			for (const field of ["frequency", "sampleRate"] as const) {
				expect(tuningTrustOf({ controlMode: "internal", [key]: [field] })).toBe(
					"unverified",
				)
				expect(
					tuningTrustOf({ controlMode: "external", [key]: ["gain", field] }),
				).toBe("unverified")
			}
	})

	it("is commanded for internal and relay for external when both are proven", () => {
		expect(tuningTrustOf({ controlMode: "internal" })).toBe("commanded")
		expect(
			tuningTrustOf({ controlMode: "internal", unknownFields: ["gain"] }),
		).toBe("commanded")
		expect(tuningTrustOf({ controlMode: "external" })).toBe("relay")
	})

	it("Property 6 holds at every derivation site", () => {
		// Feature: web-gaps-9, Property 6: Strict trust
		// Validates: Requirements 3.1, 3.2
		fc.assert(
			fc.property(
				stateArb,
				fc.option(fc.boolean(), { nil: undefined }),
				(state, written) => {
					const expected = oracle(state)
					expect(tuningTrustOf(state as TuningTrustInput)).toBe(expected)
					// The engine's initial label and its caps-change/suppressed-centre relabel.
					const withConnection =
						written === false && expected !== "unverified"
							? "unverified"
							: expected
					const engine = engineFor(state, written)
					expect(engine.initialTrust()).toBe(withConnection)
					expect(engine.stateTrust()).toBe(withConnection)
					// The analog transmission frequency (null only when frequency is unknown).
					const at = tunerFrequencyAt(
						() => state as never,
						written === undefined ? undefined : () => written,
					)
					const unknown =
						typeof state === "object" &&
						state !== null &&
						Array.isArray((state as TuningTrustInput).unknownFields) &&
						(state as TuningTrustInput).unknownFields!.includes("frequency")
					const result = at("rtl", 1_000)
					if (typeof state !== "object" || state === null || unknown) {
						expect(result).toBeNull()
					} else {
						expect(result).toEqual({
							hz: 446_001_000,
							tuningTrust: withConnection,
						})
					}
				},
			),
			{ numRuns: 200 },
		)
	})
})

/** A SourceManager double the real TunerController drives (caps changes emit synchronously). */
function makeController(
	reconnectPolicy: "restore" | "reset",
	caps: Partial<SourceCaps> = {},
) {
	const sources = new FakeSources("rtl", caps)
	let failWrites = false
	const manager = Object.assign(sources, {
		writeToSource: vi.fn(() => {
			if (failWrites) throw new Error("socket closed")
			return true
		}),
		isRtlTcpSource: () => true,
		updateSourceCaps: (id: string, patch: Partial<SourceCaps>) => {
			sources.setCaps(id, patch)
			return sources.getCaps(id)
		},
		setTuningCaps: (id: string, patch: Partial<SourceCaps>) => {
			sources.setCaps(id, patch)
			return sources.getCaps(id)
		},
	})
	const controller = new TunerController(
		logger,
		manager as unknown as SourceManager,
		{ reconnectPolicy },
	)
	controller.on("error", () => undefined)
	controller.initializeSource("rtl", sources.getCaps("rtl"))
	return {
		sources,
		controller,
		failWrites: (on: boolean) => {
			failWrites = on
		},
	}
}

describe("analog transmission frequency trust (WG9 req 3.1, 3.2)", () => {
	const at = (c: TunerController) =>
		tunerFrequencyAt(
			id => c.getState(id),
			id => c.tuningWrittenOnConnection(id),
		)("rtl", 0)?.tuningTrust

	it("is unverified with a declared-only frequency or sample rate", async () => {
		const { controller } = makeController("restore")
		expect(at(controller)).toBe("unverified")
		await controller.setFrequency("rtl", 446_200_000)
		// sample rate is still only declared by the caps baseline
		expect(at(controller)).toBe("unverified")
		expect(
			tunerFrequencyAt(id => controller.getState(id))("rtl", 0)?.tuningTrust,
		).toBe("unverified")
	})

	it("is commanded after this core writes frequency and sample rate", async () => {
		const { controller } = makeController("restore")
		await controller.setSampleRate("rtl", 1_024_000)
		await controller.setFrequency("rtl", 446_200_000)
		expect(at(controller)).toBe("commanded")
	})

	it("is relay after accepted relay commands under external control", () => {
		const { controller } = makeController("restore")
		controller.applyExternalCommand(
			"rtl",
			RTL_TCP_COMMANDS.SET_SAMPLE_RATE,
			1_024_000,
		)
		controller.applyExternalCommand(
			"rtl",
			RTL_TCP_COMMANDS.SET_FREQUENCY,
			446_300_000,
		)
		expect(at(controller)).toBe("relay")
	})

	it("is unverified after a reset reconnect until this core commands again", async () => {
		const { controller } = makeController("reset")
		await controller.setSampleRate("rtl", 1_024_000)
		await controller.setFrequency("rtl", 446_200_000)
		controller.synchronizeOnConnect("rtl")
		expect(at(controller)).toBe("unverified")
		await controller.setSampleRate("rtl", 1_024_000)
		await controller.setFrequency("rtl", 446_200_000)
		expect(at(controller)).toBe("commanded")
	})

	it("is commanded after an accepted replay and unverified after a failed one", async () => {
		const { controller, failWrites } = makeController("restore")
		await controller.setSampleRate("rtl", 1_024_000)
		await controller.setFrequency("rtl", 446_200_000)
		controller.synchronizeOnConnect("rtl")
		expect(controller.tuningWrittenOnConnection("rtl")).toBe(true)
		expect(at(controller)).toBe("commanded")
		failWrites(true)
		controller.synchronizeOnConnect("rtl")
		// still accepted (replayed next time), but not written on this connection
		expect(controller.getState("rtl")?.declaredOnlyFields).toBeUndefined()
		expect(controller.tuningWrittenOnConnection("rtl")).toBe(false)
		expect(at(controller)).toBe("unverified")
	})

	it("follows a sample-rate change through the same rule", async () => {
		const { controller } = makeController("restore")
		await controller.setFrequency("rtl", 446_200_000)
		expect(at(controller)).toBe("unverified")
		await controller.setSampleRate("rtl", 2_048_000)
		expect(at(controller)).toBe("commanded")
	})
})
