import { describe, expect, it } from "vitest"
import * as fc from "fast-check"
import {
	SOURCE_VERDICT_CODES,
	type SdrHostStatus,
	type SourceFeed,
} from "@wavekit/api-types"
import {
	SOURCE_FACTS_MAX_AGE_MS,
	sourceVerdict,
} from "../../../src/core/source-verdict.js"
import type { SourceStatus } from "../../../src/core/source-manager.js"

const now = 1_800_000_000_000

const host = (patch: Partial<SdrHostStatus> = {}): SdrHostStatus => ({
	available: true,
	sourceId: "s",
	apiUrl: "http://receiver.invalid:8080",
	uptime: 1,
	rtlTcp: null,
	rtlmux: null,
	dongle: null,
	warnings: [],
	errors: [],
	lastFetchedAt: new Date(now).toISOString(),
	fetchError: null,
	receiverFacts: { deviceFound: false, rtlTcpRunning: false },
	...patch,
})

const status = (
	state: SourceStatus["activity"]["state"],
	feed?: SourceFeed["state"],
) =>
	({
		activity: { state, lastSampleAt: null, sampleAgeMs: null, timeoutMs: 1 },
		...(feed ? { feed: { state: feed } } : {}),
	}) as Pick<SourceStatus, "activity" | "feed">

describe("sourceVerdict", () => {
	it("holds a device claim at the age bound and drops it one millisecond past", () => {
		const at = (age: number) =>
			sourceVerdict(
				status("stale"),
				host({ lastFetchedAt: new Date(now - age).toISOString() }),
				now,
			).code
		expect(at(SOURCE_FACTS_MAX_AGE_MS)).toBe("receiver-no-device")
		expect(at(SOURCE_FACTS_MAX_AGE_MS + 1)).toBe("no-samples")
	})

	it.each([
		["a time in the future", new Date(now + 1).toISOString()],
		["no fetch time", null],
		["a malformed fetch time", "yesterday"],
	])("treats %s as stale", (_name, lastFetchedAt) => {
		expect(
			sourceVerdict(status("stale"), host({ lastFetchedAt }), now),
		).toMatchObject({ code: "no-samples", deviceFacts: "stale" })
	})

	it("says plainly that a device is gone only when the receiver's USB check answered", () => {
		const of = (deviceProbe?: "observed" | "failed") =>
			sourceVerdict(
				status("stale"),
				host({
					receiverFacts: {
						deviceFound: deviceProbe === "failed" ? null : false,
						rtlTcpRunning: false,
						...(deviceProbe ? { deviceProbe } : {}),
					},
				}),
				now,
			)
		expect(of("observed")).toEqual({
			code: "receiver-no-device",
			message: "receiver has no device; re-attach USB",
			deviceFacts: "absent",
		})
		// An older host cannot tell a failed check from an absence: same code, hedged text.
		expect(of()).toEqual({
			code: "receiver-no-device",
			message:
				"receiver reports no device; check USB and re-attach it if unplugged",
			deviceFacts: "absent",
		})
		const failed = of("failed")
		expect(failed).toMatchObject({
			code: "no-samples",
			deviceFacts: "probe-failed",
		})
		expect(failed.message).not.toMatch(/re-attach/)
	})

	it("makes no device claim from a failed USB check, even with a stale present flag", () => {
		for (const deviceFound of [true, false, null]) {
			const verdict = sourceVerdict(
				status("disconnected"),
				host({
					receiverFacts: {
						deviceFound,
						rtlTcpRunning: false,
						deviceProbe: "failed",
					},
				}),
				now,
			)
			expect(verdict.code).toBe("disconnected")
			expect(verdict.deviceFacts).toBe("probe-failed")
		}
	})

	it("claims nothing when the device and rtl_tcp facts disagree", () => {
		const verdict = sourceVerdict(
			status("stale"),
			host({ receiverFacts: { deviceFound: false, rtlTcpRunning: true } }),
			now,
		)
		expect(verdict.code).toBe("no-samples")
		expect(verdict.message).not.toMatch(/re-attach/)
	})

	it("says rtl_tcp is down only when a device is reported and rtl_tcp stated off", () => {
		const of = (rtlTcpRunning: boolean | null) =>
			sourceVerdict(
				status("stale"),
				host({ receiverFacts: { deviceFound: true, rtlTcpRunning } }),
				now,
			).code
		expect(of(false)).toBe("receiver-not-running")
		expect(of(null)).toBe("no-samples")
		expect(of(true)).toBe("no-samples")
	})

	it("reads a device loss even before samples are due, or while disconnected", () => {
		expect(sourceVerdict(status("waiting"), host(), now).code).toBe(
			"receiver-no-device",
		)
		expect(sourceVerdict(status("disconnected"), host(), now).code).toBe(
			"receiver-no-device",
		)
	})

	it("never lets receiver facts override what the core sees itself", () => {
		const of = (
			state: SourceStatus["activity"]["state"],
			feed?: SourceFeed["state"],
		) => sourceVerdict(status(state, feed), host(), now).code
		expect(of("streaming")).toBe("ok")
		expect(of("paused")).toBe("backpressure")
		expect(of("ended")).toBe("ended")
		expect(of("disconnected", "paused")).toBe("feed-paused")
		expect(of("disconnected", "resuming")).toBe("feed-paused")
		expect(of("disconnected", "error")).toBe("feed-error")
	})

	// Feature: agent whys, Property 1: no device claim without fresh boolean facts
	// Validates: Requirements 3 (verdict), trust values default to the safe answer
	it("never claims a device state without fresh, well-formed facts", () => {
		const anything = fc.oneof(
			fc.constant(undefined),
			fc.constant(null),
			fc.boolean(),
			fc.string(),
			fc.integer(),
		)
		fc.assert(
			fc.property(
				fc.record({
					available: fc.boolean(),
					age: fc.integer({ min: -60_000, max: 60_000 }),
					deviceFound: anything,
					rtlTcpRunning: anything,
					state: fc.constantFrom(
						"disconnected",
						"waiting",
						"streaming",
						"stale",
						"paused",
						"ended",
					) as fc.Arbitrary<SourceStatus["activity"]["state"]>,
				}),
				input => {
					const verdict = sourceVerdict(
						status(input.state),
						host({
							available: input.available,
							lastFetchedAt: new Date(now - input.age).toISOString(),
							receiverFacts: {
								deviceFound: input.deviceFound as boolean,
								rtlTcpRunning: input.rtlTcpRunning as boolean,
							},
						}),
						now,
					)
					expect(SOURCE_VERDICT_CODES).toContain(verdict.code)
					if (
						verdict.code === "receiver-no-device" ||
						verdict.code === "receiver-not-running"
					) {
						expect(input.available).toBe(true)
						expect(input.age).toBeGreaterThanOrEqual(0)
						expect(input.age).toBeLessThanOrEqual(SOURCE_FACTS_MAX_AGE_MS)
						expect(typeof input.deviceFound).toBe("boolean")
					}
				},
			),
			{ numRuns: 200 },
		)
	})
})
