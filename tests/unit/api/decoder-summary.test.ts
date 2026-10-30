import Fastify from "fastify"
import { expect, it } from "vitest"
import {
	decoderSummary,
	decoderSummaryRoutes,
	DECODING_WINDOW_MS,
} from "../../../src/api/routes/decoder-summary.js"
import type { DecoderStatus } from "../../../src/decoders/types.js"
import fc from "fast-check"
import {
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
	[{ health: "faulted" }, "failed", ["restart"]],
	[
		{
			running: false,
			suspension: { reasonCode: "efficiency-budget", since: new Date(now) },
			efficiency: { detail: "budget" },
		},
		"efficiency-budget",
		["raise-budget", "turn-off-others", "pause-scanner"],
	],
	[
		{
			running: false,
			suspension: { reasonCode: "efficiency-budget", since: new Date(now) },
		},
		"efficiency-budget",
		["raise-budget", "turn-off-others", "pause-scanner"],
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
				reason: fc.option(fc.string(), { nil: undefined }),
				detail: fc.option(fc.string(), { nil: undefined }),
			}),
			input => {
				const verdict = decoderSummary(
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
				).verdict
				expect(DECODER_VERDICT_CODES).toContain(verdict.code)
				for (const action of verdict.actions)
					expect(DECODER_VERDICT_ACTIONS).toContain(action)
				expect(decoderVerdictSchema.safeParse(verdict).success).toBe(true)
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
