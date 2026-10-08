import { describe, expect, it } from "vitest"
import {
	sourceActivityLabel,
	sourceSnapshotFresh,
} from "../../../cli/source/utils/source-activity.js"
import type { SourceStatus } from "../../../cli/source/types.js"

describe("source snapshot freshness", () => {
	const source: SourceStatus = {
		id: "iq",
		connected: true,
		activity: {
			state: "streaming",
			lastSampleAt: null,
			sampleAgeMs: null,
			timeoutMs: 10000,
		},
	}
	it("expires cached streaming after failed refresh and recovers on a new snapshot", () => {
		expect(sourceActivityLabel(source, sourceSnapshotFresh(1000, 15999))).toBe(
			"streaming",
		)
		expect(sourceActivityLabel(source, sourceSnapshotFresh(1000, 16000))).toBe(
			"status stale",
		)
		expect(sourceActivityLabel(source, sourceSnapshotFresh(1000, 30000))).toBe(
			"status stale",
		)
		expect(sourceActivityLabel(source, sourceSnapshotFresh(30000, 30001))).toBe(
			"streaming",
		)
		expect(sourceActivityLabel(source, sourceSnapshotFresh(null, 30000))).toBe(
			"status stale",
		)
	})
	it("does not infer streaming from an older server's connected flag", () => {
		expect(sourceActivityLabel({ id: "old", connected: true }, true)).toBe(
			"connected",
		)
		expect(sourceActivityLabel({ id: "old", connected: false }, true)).toBe(
			"disconnected",
		)
	})
})
