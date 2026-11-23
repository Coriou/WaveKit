/**
 * A storage-cap admission refusal brings the next maintenance pass (retention) forward to the
 * next tick instead of up to 5 min later: at most once per EARLY_RETENTION_EVERY_MS (30 s), only
 * for the byte refusal (not the operation inventory limit or the metadata bounds, which share its
 * code), and not while the last pass left the quota full with nothing removable.
 */
import { describe, expect, it } from "vitest"
import { EARLY_RETENTION_EVERY_MS } from "../../../../src/core/scanner/scanner-service.js"
import {
	AnalogStorageBytesError,
	type AnalogHandle,
	type AnalogInput,
} from "../../../../src/core/scanner/store/analog-operations.js"
import type { RecordingsQuotaExceeded } from "../../../../src/core/scanner/store/evidence-store.js"
import { WaveKitError } from "../../../../src/utils/errors.js"
import { serviceHarness } from "../../../mocks/scanner/service-fakes.js"

const MAINTENANCE_EVERY_MS = 5 * 60_000

interface Internals {
	lastMaintenanceAt: number
	maintenanceInFlight: boolean
	tick(): void
	maintenance(): Promise<void>
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
		// "bytes": the byte refusal; any other value: a plain coded error with that code.
		let code = "bytes"
		svc.evidence.beginAnalog = () => {
			const ready = Promise.reject(
				code === "bytes"
					? new AnalogStorageBytesError("Recording storage cap")
					: new WaveKitError("refused", code),
			)
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
		// The operation inventory limit and the metadata bounds share the storage-cap code
		// (a plain coded error): retention cannot clear the metadata ones, nothing brought forward.
		code = "SCANNER_ANALOG_STORAGE_CAP"
		expect(await refuse()).toBe(false)
		// The last pass found nothing removable: the regular cadence retries it.
		code = "bytes"
		quota = { capBytes: 1, usedBytes: 2, overBytes: 1 }
		expect(await refuse()).toBe(false)
		quota = null
		expect(await refuse()).toBe(true)
	})

	it("through the tick: a request while a pass is in flight runs exactly one extra pass after it", async () => {
		let now = 20_000_000
		const h = serviceHarness({ now: () => now })
		const svc = h.service as unknown as Internals
		svc.evidence.beginAnalog = () =>
			({
				ready: Promise.reject(
					new AnalogStorageBytesError("Recording storage cap"),
				),
			}) as unknown as AnalogHandle
		Object.defineProperty(svc.evidence, "recordingsQuotaExceeded", {
			get: () => null,
		})
		let passes = 0
		let release: () => void = () => undefined
		svc.maintenance = () => {
			passes++
			return new Promise<void>(done => {
				release = done
			})
		}
		const settle = () => new Promise(resolve => setImmediate(resolve))
		svc.lastMaintenanceAt = now - MAINTENANCE_EVERY_MS
		svc.tick()
		expect(passes).toBe(1)
		expect(svc.maintenanceInFlight).toBe(true)
		// A refusal while that pass is in flight: the next tick may not start a second one.
		now += 1_000
		await svc
			.beginAnalogRecording({} as AnalogInput)
			.ready.catch(() => undefined)
		await settle()
		svc.tick()
		expect(passes).toBe(1)
		release()
		await settle()
		expect(svc.maintenanceInFlight).toBe(false)
		// The pass ended: the request runs one extra pass at the next tick, and only one.
		now += 1_000
		svc.tick()
		expect(passes).toBe(2)
		release()
		await settle()
		for (let i = 0; i < 5; i++) {
			now += 1_000
			svc.tick()
			await settle()
		}
		expect(passes).toBe(2)
	})
})
