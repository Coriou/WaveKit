/**
 * WG3 frozen contract (docs/specs/web-gaps-3, task 0.1): retention policy plumbing,
 * provenance pass-through default and the additive DTO fields. No behaviour beyond defaults.
 */
import { describe, expect, it } from "vitest"
import type * as Api from "@wavekit/api-types"
import { COVERAGE_PROTOCOLS } from "@wavekit/api-types"
import { ActivityConfigSchema } from "../../../src/config.js"
import { activityConfigOptions } from "../../../src/core/activity/runtime.js"
import type { StoreIdentity } from "../../../src/core/activity/storage/contract.js"
import {
	ACTIVITY_LIMIT_DEFAULTS,
	ACTIVITY_RETENTION_POLICY_DEFAULT,
	resolveActivityLimits,
} from "../../../src/core/activity/storage/limits.js"

describe("WG3 contract", () => {
	it("defaults the retention policy to fair-share (provisional) and keeps the caps", () => {
		// Feature: web-gaps-3, requirement 1.1 and 1.16
		expect(ACTIVITY_RETENTION_POLICY_DEFAULT).toBe("fair-share")
		const limits = resolveActivityLimits()
		expect(limits.retentionPolicy).toBe("fair-share")
		expect(limits.maxRows).toBe(250_000)
		expect(limits.maxDbBytes).toBe(256 * 1024 * 1024)
		expect(limits.maxAgeMs).toBe(3 * 24 * 60 * 60 * 1000)
		expect(ACTIVITY_LIMIT_DEFAULTS.globalRatePerSec).toBe(50)
	})

	it("accepts the oldest-first opt-out and rejects unknown policies", () => {
		expect(
			resolveActivityLimits({ retentionPolicy: "oldest-first" })
				.retentionPolicy,
		).toBe("oldest-first")
		expect(() =>
			resolveActivityLimits({
				retentionPolicy: "newest-first" as "oldest-first",
			}),
		).toThrow("Invalid activity retention policy")
	})

	it("parses activity.retention.policy and leaves enabled on by default", () => {
		const parsed = ActivityConfigSchema.parse({
			retention: { policy: "oldest-first" },
		})
		expect(parsed.enabled).toBe(true)
		expect(parsed.retention?.policy).toBe("oldest-first")
		expect(ActivityConfigSchema.parse({}).retention).toBeUndefined()
		expect(() =>
			ActivityConfigSchema.parse({ retention: { policy: "lru" } }),
		).toThrow()
		expect(activityConfigOptions(parsed).retention?.policy).toBe("oldest-first")
	})

	it("keeps hole fields and WG3 DTO fields optional", () => {
		const identity: StoreIdentity = {
			storeUuid: "u",
			restoreGeneration: 0,
			pruneWatermark: "0",
			pruneGeneration: 0,
			committedMax: "0",
		}
		expect(identity.holeWatermark ?? "0").toBe("0")
		const node: Pick<Api.MeshNode, "telemetry" | "neighbours"> = {}
		expect(node.telemetry).toBeUndefined()
		const stats: Pick<Api.ActivityStoreStats, "retention" | "floodCopies"> = {}
		expect(stats.floodCopies).toBeUndefined()
		expect(COVERAGE_PROTOCOLS).toEqual(["adsb", "ais"])
	})
})
