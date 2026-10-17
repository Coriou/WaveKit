/**
 * WG10 RK2: createScannerRecordingDeleter with fakes (requirements 1.2, 1.4): unlink first,
 * bookkeeping after, a bookkeeping failure is a logged count and still `deleted`.
 */
import { describe, expect, it, vi } from "vitest"
import { RecordingKeepError } from "../../../../src/core/recordings/contract.js"
import { createScannerRecordingDeleter } from "../../../../src/core/scanner/recording-delete.js"
import type { Logger } from "../../../../src/utils/logger.js"

const ID = "d_SECRET~call-secret.wav"

function logs(): { logger: Logger; lines: unknown[][] } {
	const lines: unknown[][] = []
	const l: Record<string, unknown> = {}
	for (const level of ["warn", "info", "debug", "error", "trace", "fatal"])
		l[level] = vi.fn((...args: unknown[]) => {
			lines.push([level, ...args])
		})
	l["child"] = (b: unknown) => {
		lines.push(["child", b])
		return l
	}
	return { logger: l as unknown as Logger, lines }
}

describe("createScannerRecordingDeleter", () => {
	it("unlinks first, then forgets the id; passes the decision through", async () => {
		const order: string[] = []
		const decision = (): boolean => true
		let passed: (() => boolean) | null = null
		const { logger, lines } = logs()
		const d = createScannerRecordingDeleter({
			evidence: {
				deleteRecording: async (id, still) => {
					order.push(`unlink:${id === ID}`)
					passed = still
					return "deleted"
				},
			},
			discovery: {
				forgetRecording: id => {
					order.push(`forget:${id === ID}`)
					return true
				},
			},
			logger,
		})
		await expect(d.deleteRecording(ID, decision)).resolves.toBe("deleted")
		expect(order).toEqual(["unlink:true", "forget:true"])
		expect(passed).toBe(decision)
		expect(lines).toContainEqual([
			"info",
			{ forgotten: 1 },
			"Scanner recording deleted",
		])
		expect(JSON.stringify(lines)).not.toContain("SECRET")
	})

	it("not-found forgets nothing", async () => {
		const forget = vi.fn(() => true)
		const d = createScannerRecordingDeleter({
			evidence: { deleteRecording: async () => "not-found" },
			discovery: { forgetRecording: forget },
			logger: logs().logger,
		})
		await expect(d.deleteRecording(ID, () => true)).resolves.toBe("not-found")
		expect(forget).not.toHaveBeenCalled()
	})

	it("refusals of the evidence store propagate and forget nothing", async () => {
		const forget = vi.fn(() => true)
		const d = createScannerRecordingDeleter({
			evidence: {
				deleteRecording: () =>
					Promise.reject(new RecordingKeepError("RECORDING_BUSY", "busy")),
			},
			discovery: { forgetRecording: forget },
			logger: logs().logger,
		})
		await expect(d.deleteRecording(ID, () => true)).rejects.toMatchObject({
			code: "RECORDING_BUSY",
		})
		expect(forget).not.toHaveBeenCalled()
	})

	it("a bookkeeping failure after the unlink is still deleted, logged as a count", async () => {
		const { logger, lines } = logs()
		const d = createScannerRecordingDeleter({
			evidence: { deleteRecording: async () => "deleted" },
			discovery: {
				forgetRecording: () => {
					throw new Error(`journal failed for ${ID} at /tmp/x`)
				},
			},
			logger,
		})
		await expect(d.deleteRecording(ID, () => true)).resolves.toBe("deleted")
		const warn = lines.find(l => l[0] === "warn")
		expect(warn?.[2]).toBe(
			"Scanner recording deleted; its bookkeeping could not be updated",
		)
		expect(warn?.[1]).toMatchObject({ dangling: 1 })
		const text = JSON.stringify(lines)
		expect(text).not.toContain("SECRET")
		expect(text).not.toContain("/tmp/x")
	})

	it("no holder of the id is still deleted (forgotten 0)", async () => {
		const { logger, lines } = logs()
		const d = createScannerRecordingDeleter({
			evidence: { deleteRecording: async () => "deleted" },
			discovery: { forgetRecording: () => false },
			logger,
		})
		await expect(d.deleteRecording(ID, () => true)).resolves.toBe("deleted")
		expect(lines).toContainEqual([
			"info",
			{ forgotten: 0 },
			"Scanner recording deleted",
		])
	})
})
