import { describe, expect, it } from "vitest"
import { decoderVerdictSchema } from "@wavekit/api-types"
import { decoderSummary } from "../../../src/api/routes/decoder-summary.js"
import { suspendedStartReason } from "../../../src/api/routes/decoders.js"
import type { DecoderStatus } from "../../../src/decoders/types.js"

const now = Date.parse("2026-10-01T12:00:00Z")
const status = (patch: Partial<DecoderStatus> = {}): DecoderStatus => ({
	id: "synthetic",
	type: "readsb",
	running: true,
	health: "running",
	uptime: 1,
	stats: { bytesIn: 1, eventsOut: 3, errors: 0 },
	restartCount: 0,
	lastOutputAt: new Date(now),
	...patch,
})
const shed = (
	efficiency: NonNullable<DecoderStatus["efficiency"]>,
	patch: Partial<DecoderStatus> = {},
): DecoderStatus =>
	status({
		running: false,
		suspended: true,
		suspension: { reasonCode: "efficiency-budget", since: new Date(now) },
		efficiency,
		...patch,
	})
const busy = { congestedBranches: 2, loopLagP99Ms: 120 }

describe("host-busy verdicts", () => {
	it("a running decoder says the host is busy, with no action", () => {
		const v = decoderSummary(status({ hostBusy: busy }), now).verdict
		expect(v).toEqual({
			code: "decoding",
			text: "ADS-B decoding: host busy: samples were dropped for every decoder",
			actions: [],
			cause: "host",
		})
		expect(decoderVerdictSchema.safeParse(v).success).toBe(true)
		const idle = decoderSummary(
			status({ hostBusy: busy, lastOutputAt: undefined }),
			now,
		).verdict
		expect(idle.code).toBe("listening")
		expect(idle.text).toBe(
			"ADS-B listening: host busy: samples were dropped for every decoder",
		)
	})

	it("host busy wins the listening sentence while the reception hint stays its own field", () => {
		const summary = decoderSummary(
			status({
				type: "lora-meshtastic",
				lastOutputAt: undefined,
				hostBusy: busy,
				counters: {
					preambles: { total: 12, perMin: 2, latest: 12, listening: 12 },
					framesOk: { total: 0, perMin: 0, latest: 0, listening: 0 },
				},
			}),
			now,
		)
		expect(summary.verdict).toEqual({
			code: "listening",
			text: "LoRa listening: host busy: samples were dropped for every decoder",
			actions: [],
			cause: "host",
		})
		expect(summary.reception).toBe("heard-undecoded")
	})

	it("without host starvation the running verdict is unchanged", () => {
		expect(decoderSummary(status(), now).verdict).toEqual({
			code: "decoding",
			text: "ADS-B decoding",
			actions: [],
		})
	})

	it.each(["drops", "late-drops"] as const)(
		"a %s shed the host caused offers no lower sample rate",
		detail => {
			const v = decoderSummary(shed({ detail, cause: "host" }), now).verdict
			expect(v.text).toBe(
				"ADS-B paused: host busy: samples were dropped for every decoder",
			)
			expect(v.actions).toEqual(["turn-off-others", "pause-scanner"])
			expect(v.actions).not.toContain("lower-sample-rate")
			expect(v.cause).toBe("host")
		},
	)

	it("an unattributed loss shed during host starvation reads host busy", () => {
		const v = decoderSummary(
			shed({ detail: "late-drops" }, { hostBusy: busy }),
			now,
		).verdict
		expect(v.cause).toBe("host")
		expect(v.actions).not.toContain("lower-sample-rate")
	})

	it("a decoder's own loss shed keeps its actions and says when it retries", () => {
		const v = decoderSummary(
			shed({
				detail: "late-drops",
				cause: "decoder",
				retryAt: new Date(now + 40_000).toISOString(),
			}),
			now,
		).verdict
		expect(v).toEqual({
			code: "efficiency-late-drops",
			text: "ADS-B paused: samples were dropped while it ran; retrying in 40 s",
			actions: ["turn-off-others", "lower-sample-rate"],
			cause: "decoder",
			retryAt: new Date(now + 40_000).toISOString(),
		})
	})

	it.each([
		[1, "1 s"],
		[1_000, "1 s"],
		[1_001, "2 s"],
	] as const)("a retry %i ms away reads %s", (ms, text) => {
		const v = decoderSummary(
			shed({
				detail: "drops",
				cause: "decoder",
				retryAt: new Date(now + ms).toISOString(),
			}),
			now,
		).verdict
		expect(v.text.endsWith(`retrying in ${text}`)).toBe(true)
	})

	it.each([0, -1, -60_000])(
		"a retry %i ms away (due or past) is not announced",
		ms => {
			const v = decoderSummary(
				shed({
					detail: "drops",
					cause: "decoder",
					retryAt: new Date(now + ms).toISOString(),
				}),
				now,
			).verdict
			expect(v.text).toBe("ADS-B paused: the source was dropping samples")
			expect(v.retryAt).toBeUndefined()
		},
	)

	it("a malformed retry time is ignored", () => {
		const v = decoderSummary(
			shed({ detail: "drops", cause: "decoder", retryAt: "soon" }),
			now,
		).verdict
		expect(v.retryAt).toBeUndefined()
		expect(v.text).toBe("ADS-B paused: the source was dropping samples")
	})
})

describe("the start response names the real reason", () => {
	it.each([
		[{ detail: "budget" }, "suspended: the CPU budget is full"],
		[{ detail: "cpu" }, "suspended: the host CPU is over its guard"],
		[
			{ detail: "late-drops", cause: "host" },
			"suspended: the host is busy and every decoder dropped samples",
		],
		[
			{ detail: "late-drops", cause: "decoder" },
			"suspended: it dropped samples while it ran",
		],
		[{ detail: "unknown" }, "suspended: waiting for the source to settle"],
	] as const)("efficiency %j", (efficiency, text) => {
		expect(suspendedStartReason(shed(efficiency))).toBe(text)
	})

	it("adds the retry time", () => {
		const retryAt = new Date(now + 30_000).toISOString()
		expect(
			suspendedStartReason(
				shed({ detail: "drops", cause: "decoder", retryAt }),
			),
		).toBe(`suspended: it dropped samples while it ran; retries at ${retryAt}`)
	})

	it.each([
		[
			"frequency-out-of-band",
			"suspended until the tuned frequency is in its band",
		],
		["insufficient-sample-rate", "suspended until the source rate is usable"],
		["tuner-scanning", "suspended while the scanner holds the tuner"],
	] as const)("suspension %s", (reasonCode, text) => {
		expect(
			suspendedStartReason(
				status({
					running: false,
					suspended: true,
					suspension: { reasonCode, since: new Date(now) },
				}),
			),
		).toBe(text)
	})
})
