import { rm } from "node:fs/promises"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { AnalogTransmissionPayload } from "../../../../src/core/activity/storage/contract.js"
import { startActivityRuntime } from "../../../../src/core/activity/runtime.js"
import { readRecords, logger, roots, tempDir } from "./storage/helpers.js"

function payload(): AnalogTransmissionPayload {
	return {
		transmissionId: "tx-runtime",
		sourceId: "rtl0",
		startedAt: "2026-10-13T00:00:00.000Z",
		endedAt: "2026-10-13T00:00:03.000Z",
		durationMs: 3_000,
		frequency: { hz: 446_006_250, tuningTrust: "commanded" },
		modulation: "nfm",
		bandwidthHz: 12_500,
		squelchMode: "manual",
		thresholdDbfs: -40,
		peakChannelPowerDbfs: -11,
		meanChannelPowerDbfs: -16,
		closeReason: "squelch",
	}
}

afterEach(async () => {
	await Promise.all(
		roots.splice(0).map(root => rm(root, { recursive: true, force: true })),
	)
})

describe("activity runtime transmission sink", () => {
	it("is null when activity is disabled and constructs nothing", async () => {
		const stateDir = await tempDir()
		const runtime = await startActivityRuntime({
			enabled: false,
			stateDir,
			logger,
			setPublisher: () => {
				throw new Error("disabled runtime must not publish")
			},
		})
		expect(runtime.status).toBe("disabled")
		expect(runtime.transmissionSink()).toBeNull()
		await runtime.close()
		expect(runtime.transmissionSink()).toBeNull()
	})

	it("is null when activity is unavailable", async () => {
		const stateDir = await tempDir()
		const runtime = await startActivityRuntime({
			enabled: true,
			stateDir,
			logger,
			probe: async () => ({ ok: false, reason: "fts5 missing" }),
			setPublisher: () => {
				throw new Error("unavailable runtime must not publish")
			},
		})
		expect(runtime.status).toBe("unavailable")
		expect(runtime.transmissionSink()).toBeNull()
		await runtime.close()
	})

	it("stores a closed transmission and ignores calls after close", async () => {
		const stateDir = await tempDir()
		const runtime = await startActivityRuntime({
			enabled: true,
			stateDir,
			logger,
			execution: "inline",
			queryExecution: "inline",
			limits: { batchWindowMs: 0 },
			setPublisher: () => {},
		})
		expect(runtime.status).toBe("ready")
		const sink = runtime.transmissionSink()
		expect(typeof sink).toBe("function")
		const body = payload()
		sink!(body)
		const records = await readRecords(join(stateDir, "activity", "activity.db"))
		expect(records).toHaveLength(1)
		expect(records[0]).toMatchObject({
			kind: "analog-transmission",
			eventId: "tx-runtime",
			producedAt: body.endedAt,
			payload: body,
		})
		expect(records[0]?.receivedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
		expect(() => sink!({ ...body, transmissionId: "" })).not.toThrow()
		await runtime.close()
		expect(runtime.transmissionSink()).toBeNull()
		expect(() => sink!(body)).not.toThrow()
	})
})
