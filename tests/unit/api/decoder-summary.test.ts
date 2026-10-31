import Fastify from "fastify"
import { describe, expect, it } from "vitest"
import {
	decoderCoversHz,
	decoderSummary,
	decoderSummaryRoutes,
	DECODING_WINDOW_MS,
} from "../../../src/api/routes/decoder-summary.js"
import type { DecoderStatus } from "../../../src/decoders/types.js"
import fc from "fast-check"
import {
	DECODER_SUMMARY_MAX_HZ,
	DECODER_VERDICT_ACTIONS,
	DECODER_VERDICT_CODES,
	decoderVerdictSchema,
} from "@wavekit/api-types"

const now = Date.parse("2026-10-01T12:00:00Z")
const status = (patch: Partial<DecoderStatus> = {}): DecoderStatus => ({
	id: "synthetic",
	type: "multimon-ng",
	running: true,
	health: "running",
	uptime: 1,
	stats: { bytesIn: 1, eventsOut: 3, errors: 0 },
	restartCount: 0,
	lastOutputAt: new Date(now),
	...patch,
})
it.each([
	[{}, "decoding"],
	[{ lastOutputAt: new Date(now - DECODING_WINDOW_MS) }, "decoding"],
	[{ lastOutputAt: new Date(now - DECODING_WINDOW_MS - 1) }, "idle"],
	[{ lastOutputAt: undefined }, "idle"],
	[{ lastOutputAt: new Date(now + 1) }, "idle"],
	[{ running: false }, "idle"],
	[{ suspended: true }, "suspended"],
	[
		{ suspension: { reasonCode: "no-channel-selected", since: new Date(now) } },
		"suspended",
	],
	[{ health: "faulted", suspended: true }, "failed"],
	[{ health: "restarting" }, "failed"],
] as const)("computes the health verdict for %j", (patch, health) => {
	expect(decoderSummary(status(patch), now).health).toBe(health)
})
it("serves a compact summary and takes static precedence over decoder ids", async () => {
	const app = Fastify()
	await app.register(decoderSummaryRoutes, {
		decoderManager: {
			getAllStatus: () => [
				status({
					placements: [
						{
							sourceId: "synthetic",
							channelHz: 123,
							running: true,
							reach: "channel",
							origin: "configured",
							primary: true,
							costCores: 0,
						},
						{
							sourceId: "synthetic",
							channelHz: 456,
							running: false,
							reach: "channel",
							origin: "configured",
							primary: false,
							costCores: 0,
						},
					],
				}),
			],
		},
	})
	app.get("/api/decoders/:id", async () => ({ wrong: true }))
	try {
		const response = await app.inject("/api/decoders/summary")
		expect(response.statusCode).toBe(200)
		const [entry] = response.json()
		expect(entry).toMatchObject({
			id: "synthetic",
			protocol: "multimon-ng",
			state: "running",
			eventsOut: 3,
			placements: [{ sourceId: "synthetic", frequencyHz: 123 }],
			suspensionReason: null,
		})
		expect(Object.keys(entry).sort()).toEqual(
			[
				"id",
				"name",
				"protocol",
				"state",
				"eventsOut",
				"placements",
				"lastOutputAt",
				"suspensionReason",
				"health",
				"verdict",
			].sort(),
		)
	} finally {
		await app.close()
	}
})

it("represents a running decoder without placement metadata conservatively", () => {
	expect(
		decoderSummary(
			status({ sourceId: "synthetic", targetFrequenciesHz: [123] }),
			now,
		).placements,
	).toEqual([{ sourceId: "synthetic", frequencyHz: 123 }])
	expect(
		decoderSummary(status({ targetFrequenciesHz: [123, 456] }), now).placements,
	).toEqual([{ sourceId: null, frequencyHz: null }])
	expect(decoderSummary(status({ running: false }), now).placements).toEqual([])
})

it.each([
	[{}, "decoding", []],
	[{ lastOutputAt: undefined }, "listening", []],
	[{ mode: "off", running: false }, "off", ["turn-on"]],
	[{ running: false, desiredRunning: false }, "stopped", ["start"]],
	[{ running: false, desiredRunning: true }, "starting", []],
	[{ health: "faulted", running: false }, "failed", ["restart"]],
	// the manager already brings it back: no Restart to race it
	[{ health: "faulted" }, "failed", []],
	[{ health: "restarting", running: false }, "failed", []],
	[
		{ health: "faulted", running: false, nextRestartAt: new Date(now + 1) },
		"failed",
		[],
	],
	[
		{
			running: false,
			suspension: { reasonCode: "efficiency-budget", since: new Date(now) },
			efficiency: { detail: "budget" },
		},
		"efficiency-budget",
		["raise-budget", "turn-off-others", "pause-scanner"],
	],
	// No refusal from the gate: never "CPU budget full" without a budget detail.
	[
		{
			running: false,
			suspension: { reasonCode: "efficiency-budget", since: new Date(now) },
		},
		"efficiency-waiting",
		[],
	],
	[
		{
			running: false,
			suspension: { reasonCode: "efficiency-budget", since: new Date(now) },
			efficiency: { detail: "unknown" },
		},
		"efficiency-waiting",
		[],
	],
	[
		{
			running: false,
			suspension: { reasonCode: "efficiency-budget", since: new Date(now) },
			efficiency: { detail: "future-new-detail" },
		},
		"unknown",
		[],
	],
	[
		{
			running: false,
			suspension: {
				reasonCode: "frequency-out-of-band",
				since: new Date(now),
			},
		},
		"out-of-band",
		["tune-to-band"],
	],
	[
		{
			running: false,
			suspension: { reasonCode: "source-rate-unknown", since: new Date(now) },
		},
		"source-unavailable",
		["check-source"],
	],
	[
		{
			running: false,
			suspension: {
				reasonCode: "insufficient-sample-rate",
				since: new Date(now),
			},
		},
		"unsupported-rate",
		["change-sample-rate"],
	],
	[
		{
			running: false,
			suspension: { reasonCode: "tuner-scanning", since: new Date(now) },
		},
		"scanner-busy",
		["pause-scanner"],
	],
] as const)("gives one verdict for %j", (patch, code, actions) => {
	const verdict = decoderSummary(
		status(patch as Partial<DecoderStatus>),
		now,
	).verdict
	expect(verdict.code).toBe(code)
	expect(verdict.actions).toEqual(actions)
	expect(decoderVerdictSchema.parse(verdict)).toEqual(verdict)
})

it("names a paused ADS-B decoder plainly", () => {
	expect(
		decoderSummary(
			status({
				type: "readsb",
				running: false,
				suspension: { reasonCode: "efficiency-budget", since: new Date(now) },
				efficiency: { detail: "budget" },
			}),
			now,
		).verdict.text,
	).toBe("ADS-B paused: CPU budget full")
})

const KNOWN_DETAILS: readonly string[] = [
	"budget",
	"cpu",
	"drops",
	"late-drops",
	"unknown",
]

// Feature: decoder-autostart, Property 5: one valid verdict for any status
// Validates: Requirements R4
it("always yields a verdict from the closed sets, generic for unknown input", () => {
	fc.assert(
		fc.property(
			fc.record({
				type: fc.string(),
				running: fc.boolean(),
				desiredRunning: fc.option(fc.boolean(), { nil: undefined }),
				mode: fc.option(fc.string(), { nil: undefined }),
				health: fc.constantFrom("running", "idle", "restarting", "faulted"),
				reason: fc.option(
					fc.oneof(
						fc.constantFrom("efficiency-budget", "frequency-out-of-band"),
						fc.string().map(s => `future-${s}`),
						fc.string(),
					),
					{ nil: undefined },
				),
				detail: fc.option(
					fc.oneof(
						fc.constantFrom(...KNOWN_DETAILS),
						fc.string().map(s => `future-${s}`),
					),
					{ nil: undefined },
				),
			}),
			input => {
				const summary = decoderSummary(
					status({
						type: input.type,
						running: input.running,
						desiredRunning: input.desiredRunning,
						health: input.health,
						...(input.mode !== undefined
							? { mode: input.mode as NonNullable<DecoderStatus["mode"]> }
							: {}),
						...(input.reason !== undefined
							? {
									suspension: {
										reasonCode: input.reason as never,
										since: new Date(now),
									},
								}
							: {}),
						...(input.detail !== undefined
							? { efficiency: { detail: input.detail as never } }
							: {}),
					}),
					now,
				)
				const verdict = summary.verdict
				expect(DECODER_VERDICT_CODES).toContain(verdict.code)
				for (const action of verdict.actions)
					expect(DECODER_VERDICT_ACTIONS).toContain(action)
				expect(decoderVerdictSchema.safeParse(verdict).success).toBe(true)
				// The suspension branch decides: unrecognised input reads the
				// generic verdict, never a cause or an action it cannot back.
				const judged =
					summary.health === "suspended" &&
					input.mode !== "off" &&
					!(input.desiredRunning === false && summary.state !== "running")
				if (!judged) return
				const unknownDetail =
					input.detail !== undefined && !KNOWN_DETAILS.includes(input.detail)
				const unknownReason =
					input.detail === undefined &&
					input.reason?.startsWith("future-") === true
				if (unknownDetail || unknownReason) {
					expect(verdict).toEqual({
						code: "unknown",
						text: expect.stringMatching(/ status unknown$/),
						actions: [],
					})
				}
				if (input.detail === undefined && input.reason === "efficiency-budget")
					expect(verdict.code).toBe("efficiency-waiting")
				// "CPU budget full" only for the gate's budget refusal.
				if (verdict.code === "efficiency-budget")
					expect(input.detail).toBe("budget")
			},
		),
		{ numRuns: 200 },
	)
})

it("counts a running placement worker as the decoder running", () => {
	const summary = decoderSummary(
		status({
			type: "dsd-fme",
			running: false,
			placements: [
				{
					sourceId: "synthetic",
					channelHz: 123,
					running: true,
					reach: "channel",
					origin: "activity",
					primary: false,
					costCores: 0,
				},
			],
		}),
		now,
	)
	expect(summary.state).toBe("running")
	expect(summary.health).toBe("decoding")
	expect(summary.verdict.code).toBe("decoding")
})

it("says a failure the manager restarts on its own plainly", () => {
	expect(
		decoderSummary(status({ health: "restarting", running: false }), now)
			.verdict.text,
	).toBe("Pager failed: restarting on its own")
	expect(
		decoderSummary(status({ health: "faulted", running: false }), now).verdict
			.text,
	).toBe("Pager failed to run")
})

describe("which decoders cover a frequency", () => {
	const ADSB_HZ = 1_090_000_000
	const adsb = (patch: Partial<DecoderStatus> = {}) =>
		status({
			type: "readsb",
			bandAssessment: {
				verdict: "in-band",
				targetsHz: [ADSB_HZ],
				basis: "protocol",
			},
			...patch,
		})

	it("holds a target within 200 kHz, at the bound and not past it", () => {
		expect(decoderCoversHz(adsb(), ADSB_HZ + 62_000)).toBe(true)
		expect(decoderCoversHz(adsb(), ADSB_HZ + 200_000)).toBe(true)
		expect(decoderCoversHz(adsb(), ADSB_HZ + 200_001)).toBe(false)
		expect(decoderCoversHz(adsb(), ADSB_HZ - 200_001)).toBe(false)
	})

	it("ignores a channel that follows the tuner: only the decoder's own band counts", () => {
		// a pager whose VFO channel sits at 1090 MHz, with a synthetic 466 MHz band
		const pager = status({
			type: "multimon-ng",
			targetFrequenciesHz: [1_090_062_000],
			placements: [
				{
					sourceId: "synthetic",
					channelHz: 1_090_062_000,
					running: true,
					reach: "channel",
					origin: "vfo",
					primary: true,
					costCores: 0,
				},
			],
			bandAssessment: {
				verdict: "in-band",
				targetsHz: [466_000_000],
				basis: "configured",
			},
		})
		expect(decoderCoversHz(pager, 1_090_062_000)).toBe(false)
		expect(decoderCoversHz(pager, 466_012_500)).toBe(true)
	})

	it("reads a range widened by 200 kHz", () => {
		const ranged = status({
			type: "dsd-fme",
			bandAssessment: {
				verdict: "in-band",
				rangesHz: [{ minHz: 460_000_000, maxHz: 470_000_000 }],
				basis: "configured",
			},
		})
		expect(decoderCoversHz(ranged, 470_200_000)).toBe(true)
		expect(decoderCoversHz(ranged, 470_200_001)).toBe(false)
	})

	it("reads the configured targets before the first band assessment, with the same 200 kHz rule", () => {
		// at boot, before any source capabilities: no assessment yet
		const boot = status({ type: "readsb", targetFrequenciesHz: [ADSB_HZ] })
		expect(decoderCoversHz(boot, ADSB_HZ)).toBe(true)
		expect(decoderCoversHz(boot, ADSB_HZ + 200_000)).toBe(true)
		expect(decoderCoversHz(boot, ADSB_HZ + 200_001)).toBe(false)
		// an assessment that names no band reads the configured targets too
		expect(
			decoderCoversHz(
				status({
					type: "readsb",
					targetFrequenciesHz: [ADSB_HZ],
					bandAssessment: { verdict: "unknown" },
				}),
				ADSB_HZ,
			),
		).toBe(true)
		// an assessed band wins over the configured targets
		expect(
			decoderCoversHz(
				adsb({ targetFrequenciesHz: [466_000_000] }),
				466_000_000,
			),
		).toBe(false)
		// probes and malformed targets never cover
		expect(decoderCoversHz({ ...boot, ephemeral: true }, ADSB_HZ)).toBe(false)
		expect(
			decoderCoversHz(
				status({
					type: "readsb",
					targetFrequenciesHz: [Number.NaN, -1, "1090" as never],
				}),
				ADSB_HZ,
			),
		).toBe(false)
	})

	it("falls back to the built-in band plan's protocols for a decoder with no band", () => {
		const pager = status({
			type: "multimon-ng",
			bandAssessment: { verdict: "unknown", reasonCode: "no-target-frequency" },
		})
		// VHF paging lists POCSAG and FLEX
		expect(decoderCoversHz(pager, 150_000_000)).toBe(true)
		// nothing there lists a paging protocol
		expect(decoderCoversHz(pager, ADSB_HZ)).toBe(false)
		// a type with no protocol list and no band covers nothing
		expect(
			decoderCoversHz(
				status({ type: "readsb", bandAssessment: { verdict: "unknown" } }),
				ADSB_HZ,
			),
		).toBe(false)
	})

	it("never covers for scanner probes or malformed input", () => {
		expect(decoderCoversHz(adsb({ owner: "scanner" }), ADSB_HZ)).toBe(false)
		expect(decoderCoversHz(adsb({ ephemeral: true }), ADSB_HZ)).toBe(false)
		expect(decoderCoversHz(adsb(), Number.NaN)).toBe(false)
		expect(decoderCoversHz(adsb(), 0)).toBe(false)
		expect(
			decoderCoversHz(
				adsb({
					bandAssessment: {
						verdict: "in-band",
						targetsHz: "1090" as never,
						rangesHz: [{ minHz: 5, maxHz: 1 }],
					},
				}),
				ADSB_HZ,
			),
		).toBe(false)
	})

	it("adds coversHz and the name only when asked, and refuses a bad hz", async () => {
		const app = Fastify()
		await app.register(decoderSummaryRoutes, {
			decoderManager: {
				getAllStatus: () => [
					adsb({ id: "readsb" }),
					status({
						id: "pager",
						bandAssessment: {
							verdict: "in-band",
							targetsHz: [466_000_000],
						},
					}),
				],
			},
		})
		try {
			const plain = (await app.inject("/api/decoders/summary")).json()
			expect(plain[0]).toMatchObject({ id: "readsb", name: "ADS-B" })
			expect(plain[0]).not.toHaveProperty("coversHz")
			const at = await app.inject("/api/decoders/summary?hz=1090062000")
			expect(at.statusCode).toBe(200)
			expect(
				at
					.json()
					.map((i: { id: string; coversHz: boolean }) => [i.id, i.coversHz]),
			).toEqual([
				["readsb", true],
				["pager", false],
			])
			const max = await app.inject(
				`/api/decoders/summary?hz=${DECODER_SUMMARY_MAX_HZ}`,
			)
			expect(max.statusCode).toBe(200)
			for (const bad of [
				String(DECODER_SUMMARY_MAX_HZ + 1),
				"0",
				"-5",
				"Infinity",
				"abc",
				"",
			]) {
				const res = await app.inject(
					`/api/decoders/summary?hz=${encodeURIComponent(bad)}`,
				)
				expect(res.statusCode, bad).toBe(400)
				expect(res.json()).toMatchObject({ code: "VALIDATION_ERROR" })
			}
		} finally {
			await app.close()
		}
	})
})
