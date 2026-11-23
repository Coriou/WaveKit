/**
 * A storage-cap admission refusal brings the next maintenance pass (retention) forward to the
 * next tick instead of up to 5 min later: at most once per EARLY_RETENTION_EVERY_MS (30 s), only
 * for storage-cap, and not while the last pass left the quota full with nothing removable.
 */
import { describe, expect, it } from "vitest"
import { EARLY_RETENTION_EVERY_MS } from "../../../../src/core/scanner/scanner-service.js"
import type {
	AnalogHandle,
	AnalogInput,
} from "../../../../src/core/scanner/store/analog-operations.js"
import type { RecordingsQuotaExceeded } from "../../../../src/core/scanner/store/evidence-store.js"
import { WaveKitError } from "../../../../src/utils/errors.js"
import { serviceHarness } from "../../../mocks/scanner/service-fakes.js"

const MAINTENANCE_EVERY_MS = 5 * 60_000

interface Internals {
	lastMaintenanceAt: number
	beginAnalogRecording(input: AnalogInput): AnalogHandle
	evidence: {
		beginAnalog(input: AnalogInput): AnalogHandle
		recordingsQuotaExceeded: RecordingsQuotaExceeded | null
	}
}

describe("early retention after a storage-cap refusal", () => {
	it("debounced to once per 30 s, storage-cap only, not while nothing is removable", async () => {
		let now = 10_000_000
		const h = serviceHarness({ now: () => now })
		const svc = h.service as unknown as Internals
		let code = "SCANNER_ANALOG_STORAGE_CAP"
		svc.evidence.beginAnalog = () => {
			const ready = Promise.reject(new WaveKitError("refused", code))
			return { ready } as unknown as AnalogHandle
		}
		let quota: RecordingsQuotaExceeded | null = null
		Object.defineProperty(svc.evidence, "recordingsQuotaExceeded", {
			get: () => quota,
		})
		const refuse = async (): Promise<boolean> => {
			svc.lastMaintenanceAt = now
			const handle = svc.beginAnalogRecording({} as AnalogInput)
			await handle.ready.catch(() => undefined)
			await new Promise(resolve => setImmediate(resolve))
			// Due at the next tick: the 5 min cadence already elapsed.
			return now - svc.lastMaintenanceAt >= MAINTENANCE_EVERY_MS
		}
		expect(await refuse()).toBe(true)
		now += EARLY_RETENTION_EVERY_MS - 1
		expect(await refuse()).toBe(false)
		now += 1
		expect(await refuse()).toBe(true)
		// Another refusal code: nothing brought forward.
		now += EARLY_RETENTION_EVERY_MS
		code = "SCANNER_ANALOG_DISK_LOW"
		expect(await refuse()).toBe(false)
		// The last pass found nothing removable: the regular cadence retries it.
		code = "SCANNER_ANALOG_STORAGE_CAP"
		quota = { capBytes: 1, usedBytes: 2, overBytes: 1 }
		expect(await refuse()).toBe(false)
		quota = null
		expect(await refuse()).toBe(true)
	})
})
