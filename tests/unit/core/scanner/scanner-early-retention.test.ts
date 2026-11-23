/**
 * A storage-cap admission refusal brings the next maintenance pass (retention) forward to the
 * next tick instead of up to 5 min later: at most once per EARLY_RETENTION_EVERY_MS (30 s), for
 * the byte refusal and the operation inventory limit (not the metadata bounds, which share their
 * code), and not while the last pass left that shortage with nothing removable. An admission that
 * succeeds but leaves less than one more recording's room (roomShort) asks the same way.
 */
import { randomUUID } from "node:crypto"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import pino from "pino"
import { afterEach, describe, expect, it } from "vitest"
import { EARLY_RETENTION_EVERY_MS } from "../../../../src/core/scanner/scanner-service.js"
import {
	AnalogStorageBytesError,
	AnalogStorageCountError,
	MAX_ANALOG_FILE_BYTES,
	type AnalogHandle,
	type AnalogInput,
	type AnalogMetadataAdapter,
	type AnalogRoomShort,
} from "../../../../src/core/scanner/store/analog-operations.js"
import { DiscoveryStore } from "../../../../src/core/scanner/store/discovery-store.js"
import {
	EvidenceStore,
	type RecordingsQuotaExceeded,
} from "../../../../src/core/scanner/store/evidence-store.js"
import { MAX_OPERATION_METADATA_BYTES } from "../../../../src/core/scanner/store/recording-operation.js"
import type { RecordingBinding } from "../../../../src/core/scanner/store/recording-operation.js"
import type { Logger } from "../../../../src/utils/logger.js"
import { counterIds, makeObs } from "../../../mocks/scanner/observations.js"
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
		operationsHeldFull: boolean
	}
}

const settle = () => new Promise(resolve => setImmediate(resolve))

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

describe("early retention after an admission that left the store short, or a count refusal", () => {
	function setup() {
		let now = 30_000_000
		const h = serviceHarness({ now: () => now })
		const svc = h.service as unknown as Internals
		let quota: RecordingsQuotaExceeded | null = null
		let heldFull = false
		Object.defineProperty(svc.evidence, "recordingsQuotaExceeded", {
			get: () => quota,
		})
		Object.defineProperty(svc.evidence, "operationsHeldFull", {
			get: () => heldFull,
		})
		/** The next admissions succeed and report `short`; `refuse` rejects with it instead. */
		let short: AnalogRoomShort | null = null
		let refuse: unknown = null
		svc.evidence.beginAnalog = () => {
			const ready = refuse === null ? Promise.resolve() : Promise.reject(refuse)
			return { ready, roomShort: short } as unknown as AnalogHandle
		}
		/** Whether `count` concurrent admissions brought maintenance forward to the next tick. */
		const requested = async (count = 1): Promise<boolean> => {
			svc.lastMaintenanceAt = now
			const handles = Array.from({ length: count }, () =>
				svc.beginAnalogRecording({} as AnalogInput),
			)
			await Promise.all(handles.map(x => x.ready.catch(() => undefined)))
			await settle()
			return now - svc.lastMaintenanceAt >= MAINTENANCE_EVERY_MS
		}
		return {
			svc,
			requested,
			advance: (ms: number) => {
				now += ms
			},
			set: (o: {
				short?: AnalogRoomShort | null
				refuse?: unknown
				quota?: RecordingsQuotaExceeded | null
				heldFull?: boolean
			}) => {
				if (o.short !== undefined) short = o.short
				if (o.refuse !== undefined) refuse = o.refuse
				if (o.quota !== undefined) quota = o.quota
				if (o.heldFull !== undefined) heldFull = o.heldFull
			},
		}
	}

	it("an admission leaving < one reservation of room asks; one leaving room does not", async () => {
		const t = setup()
		t.set({ short: null })
		expect(await t.requested()).toBe(false)
		t.set({ short: { bytes: true, count: false } })
		expect(await t.requested()).toBe(true)
		// Debounced like a refusal.
		t.advance(EARLY_RETENTION_EVERY_MS - 1)
		expect(await t.requested()).toBe(false)
		t.advance(1)
		expect(await t.requested()).toBe(true)
		// Bytes short while the last pass found nothing removable: the regular cadence retries it.
		t.advance(EARLY_RETENTION_EVERY_MS)
		t.set({ quota: { capBytes: 1, usedBytes: 2, overBytes: 1 } })
		expect(await t.requested()).toBe(false)
		// Count short is another shortage: still asked.
		t.set({ short: { bytes: true, count: true } })
		expect(await t.requested()).toBe(true)
	})

	it("an admission leaving fewer than the operation headroom asks, unless the held operations fill it", async () => {
		const t = setup()
		t.set({ short: { bytes: false, count: true } })
		expect(await t.requested()).toBe(true)
		t.advance(EARLY_RETENTION_EVERY_MS)
		t.set({ heldFull: true })
		expect(await t.requested()).toBe(false)
		t.set({ heldFull: false })
		expect(await t.requested()).toBe(true)
	})

	it("the operation inventory refusal (AnalogStorageCountError) asks too, unless the held operations fill it", async () => {
		const t = setup()
		t.set({ refuse: new AnalogStorageCountError("Operation inventory limit") })
		expect(await t.requested()).toBe(true)
		t.advance(EARLY_RETENTION_EVERY_MS)
		t.set({ heldFull: true })
		expect(await t.requested()).toBe(false)
		// The byte quota state does not block the count refusal.
		t.set({
			heldFull: false,
			quota: { capBytes: 1, usedBytes: 2, overBytes: 1 },
		})
		expect(await t.requested()).toBe(true)
	})

	it("two concurrent short admissions: one extra pass", async () => {
		const t = setup()
		t.set({ short: { bytes: true, count: false } })
		let passes = 0
		t.svc.maintenance = async () => {
			passes++
		}
		expect(await t.requested(2)).toBe(true)
		t.svc.tick()
		await settle()
		expect(passes).toBe(1)
		for (let i = 0; i < 5; i++) {
			t.advance(1_000)
			t.svc.tick()
			await settle()
		}
		expect(passes).toBe(1)
	})
})

/**
 * Not mocked: a real EvidenceStore with real analog operations on a temporary directory. The
 * store is filled to within one reservation of its cap, a real admission refuses with the byte
 * refusal, the service brings retention forward, the next tick's pass (the store's own retention)
 * evicts the oldest, and the next admission is admitted. Synthetic ids and audio only.
 */
describe("a real byte refusal flows through a real retention pass", () => {
	const RESERVATION = MAX_ANALOG_FILE_BYTES + MAX_OPERATION_METADATA_BYTES
	const MIB = 1024 * 1024
	const dirs: string[] = []
	afterEach(async () => {
		await Promise.all(
			dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })),
		)
	})

	it("refused, retention runs at the next tick, the next admission succeeds", async () => {
		const root = await realpath(
			await mkdtemp(join(tmpdir(), "wavekit-early-retention-")),
		)
		dirs.push(root)
		const wall = Date.now()
		const discoveries = new DiscoveryStore({
			maxDiscoveries: 100,
			now: () => wall,
			newId: counterIds(),
		})
		const { discoveryId } = discoveries.ingest(
			makeObs({ id: "o1", centreHz: 446_000_000, startedAt: wall }),
		)
		if (!discoveryId) throw new Error("Missing test discovery")
		const adapter: AnalogMetadataAdapter = {
			authorityHealthy: () => true,
			bindingLive: () => true,
			association: (d, o, historical) =>
				discoveries.recordingAssociation(d, o, historical),
			prepare: async metadata => {
				discoveries.prepareRecording(metadata)
			},
			inverse: async id => {
				discoveries.removePreparedRecording(id)
			},
			buildCommitPlan: id => discoveries.buildRecordingCommitPlan(id),
			commitPlanCurrent: plan => discoveries.recordingCommitPlanCurrent(plan),
			publishCommit: plan => discoveries.publishRecordingCommit(plan),
		}
		const caps = {
			maxRecordingsMb: 1024,
			maxEvidenceMb: 20,
			maxAgeDays: 30,
			minFreeDiskMb: 0,
		}
		const ev = new EvidenceStore({
			dir: root,
			caps,
			logger: pino({ level: "silent" }) as unknown as Logger,
			now: () => Date.now(),
			statfs: async () => ({ freeBytes: 1e12 }),
			isDiscoveryLive: id => discoveries.get(id) !== undefined,
		})
		ev.configureAnalog(adapter)
		await ev.recoverAnalog()
		const binding = (): RecordingBinding => ({
			sourceId: "src-1",
			engineInstanceId: randomUUID(),
			stream: 1,
			epoch: 1,
			channelId: "opaque-native-grant",
			channelGeneration: 1,
			inputFormat: "cf32",
			inputSampleRateHz: 48000,
			groupDelayInputSamples: null,
			targetHz: 446_000_000,
			captureCentreHz: null,
			tuningTrust: "unverified",
		})
		const input = (): AnalogInput => ({
			discoveryId,
			observationId: "o1",
			binding: binding(),
		})
		// Two finalized files: 1 600 044 B each, under one reservation.
		const artifacts: string[] = []
		for (let i = 0; i < 2; i++) {
			const op = ev.beginAnalog(input())
			await op.ready
			for (let n = 0; n < 800_000; n += 16_000)
				await op.push(new Int16Array(16_000))
			const receipt = await op.finish()
			expect(receipt.outcome).toBe("finalized")
			artifacts.push(receipt.artifact!)
			// The first is the older.
			await new Promise(resolve => setTimeout(resolve, 20))
		}
		const analog = (
			ev as unknown as { analog: { managedBytes: number | null } }
		).analog
		const used = analog.managedBytes ?? Number.NaN
		// Within one reservation of the cap: the next admission refuses.
		ev.setCaps({ ...caps, maxRecordingsMb: (used + RESERVATION - 1) / MIB })

		let now = 40_000_000
		const h = serviceHarness({ now: () => now })
		const svc = h.service as unknown as Internals
		;(svc as unknown as { evidence: EvidenceStore }).evidence = ev
		let passes = 0
		const deleted: string[] = []
		svc.maintenance = async () => {
			passes++
			deleted.push(...(await ev.retention(new Set())).deleted)
		}
		svc.lastMaintenanceAt = now
		const refused = svc.beginAnalogRecording(input())
		const err = await refused.ready.then(
			() => null,
			(e: unknown) => e,
		)
		await refused.settled
		expect(err).toBeInstanceOf(AnalogStorageBytesError)
		await settle()
		// Brought forward: the next tick runs the pass.
		now += 100
		svc.tick()
		expect(passes).toBe(1)
		for (let i = 0; i < 20 && svc.maintenanceInFlight; i++)
			await new Promise(resolve => setTimeout(resolve, 10))
		expect(svc.maintenanceInFlight).toBe(false)
		// Oldest first until used + 2R fits: the shortfall (R + 1 B) is more than one 1.6 MB file.
		expect(deleted).toEqual([artifacts[0], artifacts[1]])
		expect(ev.recordingsQuotaExceeded).toBeNull()
		const admitted = svc.beginAnalogRecording(input())
		await admitted.ready
		admitted.cancel()
		await admitted.settled
		await ev.stopAnalog()
	}, 60_000)
})
