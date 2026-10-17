/**
 * WG9 req 2.5-2.6 (lane RK): the scanner-side deleters consult the recording deletion
 * decision (`RecordingProtection`); every hook is optional and absent keeps today's behaviour.
 */
import { randomUUID } from "node:crypto"
import { existsSync, renameSync, symlinkSync } from "node:fs"
import {
	mkdir,
	mkdtemp,
	realpath,
	rm,
	symlink,
	utimes,
	writeFile,
} from "node:fs/promises"
import type * as FsPromises from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SCANNER_DISCOVERY_HOLDS_KEPT_CODE } from "@wavekit/api-types"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { RecordingProtection } from "../../../../src/core/recordings/contract.js"
import { ScannerApiError } from "../../../../src/core/scanner/errors.js"
import type { AnalogMetadataAdapter } from "../../../../src/core/scanner/store/analog-operations.js"
import { DiscoveryStore } from "../../../../src/core/scanner/store/discovery-store.js"
import { EvidenceStore } from "../../../../src/core/scanner/store/evidence-store.js"
import type { StorageCaps } from "../../../../src/core/scanner/store/evidence-store.js"
import type { RecordingBinding } from "../../../../src/core/scanner/store/recording-operation.js"
import type { ScannerServiceDeps } from "../../../../src/core/scanner/scanner-service.js"
import type { DiscoveryStore as DiscoveryStoreType } from "../../../../src/core/scanner/store/discovery-store.js"
import { createLogger } from "../../../../src/utils/logger.js"
import { counterIds, makeObs } from "../../../mocks/scanner/observations.js"
import { CENTRE, serviceHarness } from "../../../mocks/scanner/service-fakes.js"
import { trackOf } from "../../../mocks/scanner/identify-fakes.js"
import { classifySpectral } from "../../../../src/core/scanner/classify/classifier.js"

/**
 * Pass-through fs whose `rm` and `unlink` call `fsHook.atYield(path)` at their first async gap
 * after starting IO (rm: after its lstat, before its unlink), so a test can commit a Keep there.
 */
const fsHook = vi.hoisted(() => ({
	atYield: null as ((path: string) => void) | null,
	/** When set, `readdir` results are sorted by name so a test can order a folder's entries. */
	sortReaddir: false,
}))
vi.mock("node:fs/promises", async importOriginal => {
	const real = await importOriginal<typeof FsPromises>()
	const rmHooked: typeof real.rm = async (path, opts) => {
		await real.lstat(path).catch(() => undefined)
		fsHook.atYield?.(String(path))
		return real.rm(path, opts)
	}
	const unlinkHooked: typeof real.unlink = async path => {
		// One syscall, issued in the caller's turn: the hook runs once it has completed.
		await real.unlink(path)
		fsHook.atYield?.(String(path))
	}
	const readdirHooked = (async (...args: Parameters<typeof real.readdir>) => {
		const entries: unknown = await real.readdir(...args)
		if (!fsHook.sortReaddir || !Array.isArray(entries)) return entries
		const name = (e: unknown): string =>
			typeof e === "string" ? e : String((e as { name: unknown }).name)
		return [...(entries as unknown[])].sort((a, b) =>
			name(a) < name(b) ? -1 : name(a) > name(b) ? 1 : 0,
		)
	}) as typeof real.readdir
	return { ...real, rm: rmHooked, unlink: unlinkHooked, readdir: readdirHooked }
})

const logger = createLogger({ level: "fatal" })
const MIB = 1024 * 1024
const DAY = 86_400_000
const CAPS: StorageCaps = {
	maxRecordingsMb: 512,
	maxEvidenceMb: 64,
	maxAgeDays: 1,
	minFreeDiskMb: 1,
}
const CH = 446_006_250
const T0 = Date.UTC(2026, 9, 9, 12, 0, 0)
const dirs: string[] = []

afterEach(async () => {
	fsHook.atYield = null
	fsHook.sortReaddir = false
	await Promise.all(
		dirs.splice(0).map(d => rm(d, { recursive: true, force: true })),
	)
})

async function tmp(): Promise<string> {
	const d = await realpath(await mkdtemp(join(tmpdir(), "wavekit-keep-del-")))
	dirs.push(d)
	return d
}

/** A fake deletion decision: kept scanner files by `<discoveryId>~<name>`. */
function fakeProtection(kept: Iterable<string>, failed = false) {
	const set = new Set(kept)
	const asked: string[] = []
	const port: RecordingProtection = {
		isProtected: () => true,
		isDsdFmeFileProtected: () => true,
		isScannerFileProtected: (d, n) => {
			asked.push(`${d}~${n}`)
			return failed || set.has(`${d}~${n}`)
		},
		discoveryHoldsKept: d =>
			failed || [...set].some(k => k.startsWith(`${d}~`)),
	}
	return { port, asked, set }
}

const throwing: RecordingProtection = {
	isProtected: () => {
		throw new Error("boom")
	},
	isDsdFmeFileProtected: () => {
		throw new Error("boom")
	},
	isScannerFileProtected: () => {
		throw new Error("boom")
	},
	discoveryHoldsKept: () => {
		throw new Error("boom")
	},
}

async function put(root: string, rel: string, ageMs: number, now: number) {
	const path = join(root, rel)
	await mkdir(join(path, ".."), { recursive: true })
	await writeFile(path, Buffer.alloc(1_000))
	const t = (now - ageMs) / 1000
	await utimes(path, t, t)
}

async function evidenceWith(protection?: RecordingProtection) {
	const root = await tmp()
	const now = Date.now()
	const store = new EvidenceStore({
		dir: root,
		caps: { ...CAPS, maxRecordingsMb: 1_500 / MIB },
		logger,
		now: () => now,
		statfs: async () => ({ freeBytes: 1e12 }),
		...(protection ? { protection } : {}),
	})
	await put(root, "recordings/dv/d_A/old.wav", 3 * DAY, now)
	await put(root, "recordings/dv/d_A/mid.wav", 5 * 3_600_000, now)
	await put(root, "recordings/dv/d_B/new.wav", 3_600_000, now)
	await put(root, "evidence/d_A/psd.json", 3 * DAY, now)
	return { root, store }
}

describe("EvidenceStore.retention with a recording protection port", () => {
	it("without a port, deletes as today (expired first, then the oldest over the cap)", async () => {
		const { root, store } = await evidenceWith()
		const { deleted } = await store.retention(new Set())
		// Equal mtimes tie-break by relative path, so the evidence file sorts first.
		expect(deleted).toEqual([
			join("evidence", "d_A", "psd.json"),
			join("recordings", "dv", "d_A", "old.wav"),
			join("recordings", "dv", "d_A", "mid.wav"),
		])
		expect(existsSync(join(root, "recordings/dv/d_B/new.wav"))).toBe(true)
	})

	it("skips a kept file (age and cap), still counting it, and asks only for recording files", async () => {
		const { port, asked } = fakeProtection(["d_A~old.wav"])
		const { root, store } = await evidenceWith(port)
		const { deleted } = await store.retention(new Set())
		// 3000 B over a 1500 B cap: old.wav kept (1000 B counted), mid.wav goes, then 2000 B > 1500 B so new.wav goes too.
		expect(deleted).toEqual([
			join("evidence", "d_A", "psd.json"),
			join("recordings", "dv", "d_A", "mid.wav"),
			join("recordings", "dv", "d_B", "new.wav"),
		])
		expect(existsSync(join(root, "recordings/dv/d_A/old.wav"))).toBe(true)
		expect(asked.every(k => !k.endsWith("psd.json"))).toBe(true)
	})

	it("a failed store (everything protected) deletes no recording", async () => {
		const { port } = fakeProtection([], true)
		const { root, store } = await evidenceWith(port)
		const { deleted } = await store.retention(new Set())
		expect(deleted).toEqual([join("evidence", "d_A", "psd.json")])
		for (const rel of ["d_A/old.wav", "d_A/mid.wav", "d_B/new.wav"])
			expect(existsSync(join(root, "recordings/dv", rel))).toBe(true)
	})

	it("a throwing port fails closed", async () => {
		const { root, store } = await evidenceWith(throwing)
		await store.retention(new Set())
		expect(existsSync(join(root, "recordings/dv/d_A/old.wav"))).toBe(true)
		expect(existsSync(join(root, "recordings/dv/d_A/mid.wav"))).toBe(true)
	})
})

describe("EvidenceStore.removeDiscovery with a recording protection port", () => {
	it("refuses 409 with the fixed code and text when the discovery holds a kept file", async () => {
		const { port } = fakeProtection(["d_A~old.wav"])
		const { root, store } = await evidenceWith(port)
		const err = await store.removeDiscovery("d_A").catch((e: unknown) => e)
		expect(err).toBeInstanceOf(ScannerApiError)
		expect(err).toMatchObject({
			code: SCANNER_DISCOVERY_HOLDS_KEPT_CODE,
			statusCode: 409,
			message: "Discovery holds kept recordings",
		})
		expect(existsSync(join(root, "recordings/dv/d_A/old.wav"))).toBe(true)
		expect(existsSync(join(root, "evidence/d_A/psd.json"))).toBe(true)
		// A discovery with no kept file is removed as today.
		await store.removeDiscovery("d_B")
		expect(existsSync(join(root, "recordings/dv/d_B"))).toBe(false)
	})

	it("refuses on a throwing port; removes as today without a port", async () => {
		const guarded = await evidenceWith(throwing)
		await expect(guarded.store.removeDiscovery("d_A")).rejects.toMatchObject({
			code: SCANNER_DISCOVERY_HOLDS_KEPT_CODE,
		})
		const plain = await evidenceWith()
		await plain.store.removeDiscovery("d_A")
		expect(existsSync(join(plain.root, "recordings/dv/d_A"))).toBe(false)
		expect(existsSync(join(plain.root, "evidence/d_A"))).toBe(false)
	})
})

describe("DiscoveryStore inactive prune and capacity eviction", () => {
	const build = (max: number, holds?: (id: string) => boolean) => {
		let now = T0
		const store = new DiscoveryStore({
			maxDiscoveries: max,
			now: () => now,
			newId: counterIds(),
			...(holds ? { discoveryHoldsKept: holds } : {}),
		})
		const ids = [0, 1].map(
			i =>
				store.ingest(
					makeObs({
						id: `a${i}`,
						centreHz: CH + i * 100_000,
						startedAt: T0 + i * 1000,
						blocks: 2,
					}),
				).discoveryId ?? "",
		)
		return { store, ids, setNow: (ms: number) => (now = ms) }
	}

	it("without a port, prunes every inactive discovery", () => {
		const { store, ids, setNow } = build(10)
		setNow(T0 + 200 * DAY)
		expect(store.pruneInactive(180).sort()).toEqual([...ids].sort())
	})

	it("skips a discovery holding kept recordings; a throwing port skips all", () => {
		// Ids are deterministic (counterIds), so a first build names the kept id.
		const kept = build(10).ids[0]!
		const { store, ids, setNow } = build(10, id => id === kept)
		setNow(T0 + 200 * DAY)
		expect(store.pruneInactive(180)).toEqual([ids[1]])
		expect(store.get(kept)).toBeDefined()
		const t = build(10, () => {
			throw new Error("boom")
		})
		t.setNow(T0 + 200 * DAY)
		expect(t.store.pruneInactive(180)).toEqual([])
	})

	it("eviction passes over a discovery holding kept recordings", () => {
		const plain = build(2)
		const victimToday = plain.ids[0]!
		plain.store.ingest(
			makeObs({
				id: "a9",
				centreHz: CH + 900_000,
				startedAt: T0 + 5000,
				blocks: 2,
			}),
		)
		expect(plain.store.get(victimToday)).toBeUndefined()

		const keptId = build(2).ids[0]!
		const g2 = build(2, id => id === keptId)
		g2.store.ingest(
			makeObs({
				id: "a9",
				centreHz: CH + 900_000,
				startedAt: T0 + 5000,
				blocks: 2,
			}),
		)
		expect(g2.store.get(keptId)).toBeDefined()
		expect(g2.store.get(g2.ids[1]!)).toBeUndefined()
	})

	it("refuses a new discovery when every candidate holds kept recordings", () => {
		const { store } = build(2, () => true)
		expect(
			store.ingest(
				makeObs({
					id: "a9",
					centreHz: CH + 900_000,
					startedAt: T0 + 5000,
					blocks: 2,
				}),
			).change,
		).toBe("transient")
		expect(store.snapshot().discoveries).toHaveLength(2)
	})
})

function adapterOf(
	store: DiscoveryStore,
	onInverse?: () => void,
): AnalogMetadataAdapter {
	return {
		authorityHealthy: () => true,
		bindingLive: () => true,
		association: (d, o, historical) =>
			store.recordingAssociation(d, o, historical),
		prepare: async metadata => {
			store.prepareRecording(metadata)
		},
		inverse: async id => {
			onInverse?.()
			store.removePreparedRecording(id)
		},
		buildCommitPlan: id => store.buildRecordingCommitPlan(id),
		commitPlanCurrent: plan => store.recordingCommitPlanCurrent(plan),
		publishCommit: plan => store.publishRecordingCommit(plan),
	}
}

async function analogHarness(
	protection?: RecordingProtection,
	onInverse?: () => void,
) {
	const root = await tmp()
	const NOW = 1_700_000_000_000
	const store = new DiscoveryStore({
		maxDiscoveries: 100,
		now: () => NOW,
		newId: counterIds(),
	})
	const discoveryId =
		store.ingest(makeObs({ id: "o1", centreHz: 446_000_000, startedAt: NOW }))
			.discoveryId ?? ""
	const binding: RecordingBinding = {
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
	}
	const adapter = adapterOf(store, onInverse)
	const caps = {
		maxRecordingsMb: 20,
		maxEvidenceMb: 1,
		maxAgeDays: 30,
		minFreeDiskMb: 1,
	}
	const evidence = new EvidenceStore({
		dir: root,
		caps,
		logger,
		now: () => NOW,
		statfs: async () => ({ freeBytes: 1e9 }),
		isDiscoveryLive: id => !!store.get(id),
		...(protection ? { protection } : {}),
	})
	evidence.configureAnalog(adapter)
	await evidence.recoverAnalog()
	const op = evidence.beginAnalog({ discoveryId, observationId: "o1", binding })
	await op.ready
	await op.push(new Int16Array([1, -2, 3]))
	const receipt = await op.finish()
	expect(receipt.outcome).toBe("finalized")
	const artifact = receipt.artifact ?? ""
	evidence.setCaps({ ...caps, maxRecordingsMb: 0 })
	/** A restart over the same root whose metadata authority lost the recording. */
	const reopen = async (port?: RecordingProtection) => {
		await evidence.stopAnalog()
		const fresh = new DiscoveryStore({
			maxDiscoveries: 100,
			now: () => NOW,
			newId: counterIds(),
		})
		const next = new EvidenceStore({
			dir: root,
			caps,
			logger,
			now: () => NOW,
			statfs: async () => ({ freeBytes: 1e9 }),
			isDiscoveryLive: () => true,
			...(port ? { protection: port } : {}),
		})
		next.configureAnalog(adapterOf(fresh))
		return next.recoverAnalog()
	}
	return { root, evidence, discoveryId, artifact, reopen, receipt }
}

describe("analog retention with a recording protection port", () => {
	it("without a port, deletes the artifact over the cap as today", async () => {
		const h = await analogHarness()
		expect((await h.evidence.retention(new Set())).deleted).toContain(
			h.artifact,
		)
		expect(existsSync(join(h.root, h.artifact))).toBe(false)
	})

	it("skips an artifact whose scanner key is kept", async () => {
		const ref: { kept: Set<string> } = { kept: new Set() }
		const port: RecordingProtection = {
			isProtected: () => true,
			isDsdFmeFileProtected: () => true,
			isScannerFileProtected: (d, n) => ref.kept.has(`${d}~${n}`),
			discoveryHoldsKept: () => false,
		}
		const h = await analogHarness(port)
		ref.kept.add(`${h.discoveryId}~${h.artifact.split("/").at(-1) ?? ""}`)
		expect((await h.evidence.retention(new Set())).deleted).toEqual([])
		expect(existsSync(join(h.root, h.artifact))).toBe(true)
		ref.kept.clear()
		expect((await h.evidence.retention(new Set())).deleted).toContain(
			h.artifact,
		)
	})

	it("a throwing port keeps the artifact", async () => {
		const h = await analogHarness(throwing)
		expect((await h.evidence.retention(new Set())).deleted).toEqual([])
		expect(existsSync(join(h.root, h.artifact))).toBe(true)
	})
})

type Internals = { store: DiscoveryStoreType }
describe("ScannerService.deleteDiscovery with a recording protection port", () => {
	async function service(protection?: RecordingProtection) {
		const h = serviceHarness({
			patch: s => {
				s.passive.enabled = false
			},
		})
		if (protection)
			(
				h.service as unknown as {
					deps: {
						-readonly [K in keyof ScannerServiceDeps]: ScannerServiceDeps[K]
					}
				}
			).deps.recordingProtection = protection
		await h.service.start()
		const job = await h.service.createJob({
			sourceId: "rtl",
			mode: "in-window",
		})
		const epoch = h.service.spectrum.engine("rtl")!.currentEpoch()
		const track = trackOf({
			trackId: "t1",
			stream: epoch.stream,
			epoch: epoch.epoch,
			centreHz: CENTRE + 100_000,
			peakDbfs: -40,
		})
		const { discoveryId } = (h.service as unknown as Internals).store.ingest({
			id: "t1",
			sourceId: "rtl",
			jobIds: [job.id],
			track,
			classification: classifySpectral(track, { priors: {}, protocols: [] }),
			startedAt: Date.now(),
			singleBlockSurfacingAllowed: false,
		})
		return { h, id: discoveryId ?? "" }
	}

	it("refuses 409 SCANNER_DISCOVERY_HOLDS_KEPT_RECORDINGS before any mutation", async () => {
		const { h, id } = await service({
			isProtected: () => true,
			isDsdFmeFileProtected: () => true,
			isScannerFileProtected: () => true,
			discoveryHoldsKept: d => d === id || d.length === 0,
		})
		try {
			await expect(h.service.deleteDiscovery(id)).rejects.toMatchObject({
				code: SCANNER_DISCOVERY_HOLDS_KEPT_CODE,
				statusCode: 409,
				message: "Discovery holds kept recordings",
			})
			expect(h.service.listDiscoveries({}).items.map(d => d.id)).toEqual([id])
		} finally {
			await h.service.stop()
		}
	})

	it("a throwing port refuses; without a port the delete proceeds as today", async () => {
		const guarded = await service(throwing)
		try {
			await expect(
				guarded.h.service.deleteDiscovery(guarded.id),
			).rejects.toMatchObject({
				statusCode: 409,
			})
		} finally {
			await guarded.h.service.stop()
		}
		const plain = await service()
		try {
			expect(await plain.h.service.deleteDiscovery(plain.id)).toBe(true)
			expect(plain.h.service.listDiscoveries({}).items).toEqual([])
		} finally {
			await plain.h.service.stop()
		}
	})
})

/** A mutable deletion decision: a Keep can commit at any await point a test chooses. */
function mutableProtection() {
	const kept = new Set<string>()
	const port: RecordingProtection = {
		isProtected: () => false,
		isDsdFmeFileProtected: () => false,
		isScannerFileProtected: (d, n) => kept.has(`${d}~${n}`),
		discoveryHoldsKept: d => [...kept].some(k => k.startsWith(`${d}~`)),
	}
	return { port, kept }
}

describe("review fixes: the deletion decision runs in the same turn as each unlink", () => {
	it("removeDiscovery: a Keep committed after the pre-check (during the drain) survives with a 409", async () => {
		const { port, kept } = mutableProtection()
		const { root, store } = await evidenceWith(port)
		const pending = store.removeDiscovery("d_A").catch((e: unknown) => e)
		// The pre-check has passed synchronously; the Keep commits before the drain settles.
		kept.add("d_A~old.wav")
		const err = await pending
		expect(err).toBeInstanceOf(ScannerApiError)
		expect(err).toMatchObject({
			code: SCANNER_DISCOVERY_HOLDS_KEPT_CODE,
			statusCode: 409,
		})
		expect(existsSync(join(root, "recordings/dv/d_A/old.wav"))).toBe(true)
		expect(existsSync(join(root, "evidence/d_A/psd.json"))).toBe(true)
		// Unkept, the same removal completes.
		kept.clear()
		await store.removeDiscovery("d_A")
		expect(existsSync(join(root, "recordings/dv/d_A"))).toBe(false)
		expect(existsSync(join(root, "evidence/d_A"))).toBe(false)
	})

	it("analog retention: a Keep committed during the metadata inverse leaves the artifact", async () => {
		const { port, kept } = mutableProtection()
		const ref: { key: string } = { key: "" }
		const h = await analogHarness(port, () => kept.add(ref.key))
		ref.key = `${h.discoveryId}~${h.artifact.split("/").at(-1) ?? ""}`
		const { deleted } = await h.evidence.retention(new Set())
		expect(deleted).not.toContain(h.artifact)
		expect(existsSync(join(h.root, h.artifact))).toBe(true)
	})

	it("analog recovery: a kept artifact whose receipt and metadata are missing is left in place", async () => {
		const { port, kept } = mutableProtection()
		const h = await analogHarness(port)
		const opId = h.receipt.operationId
		await rm(join(h.root, ".analog-operations", opId, "receipt.json"))
		kept.add(`${h.discoveryId}~${h.artifact.split("/").at(-1) ?? ""}`)
		const results = await h.reopen(port)
		expect(results.find(r => r.operationId === opId)?.status).toBe(
			"quarantined",
		)
		expect(existsSync(join(h.root, h.artifact))).toBe(true)
	})

	it("analog recovery without a port cleans the same artifact as today", async () => {
		const h = await analogHarness()
		const opId = h.receipt.operationId
		await rm(join(h.root, ".analog-operations", opId, "receipt.json"))
		const results = await h.reopen()
		expect(results.find(r => r.operationId === opId)?.status).toBe("cleaned")
		expect(existsSync(join(h.root, h.artifact))).toBe(false)
	})
})

describe("round-2 review fixes: deleter IO gaps and symlinked discovery folders", () => {
	it("retention: a Keep verifying the file at the deleter's IO yield never loses it", async () => {
		const { port, kept } = mutableProtection()
		const { root, store } = await evidenceWith(port)
		const path = join(root, "recordings/dv/d_A/old.wav")
		// The Keep verifies the file is present, then commits; it lands at the deleter's first yield.
		fsHook.atYield = p => {
			if (p === path && existsSync(path)) kept.add("d_A~old.wav")
		}
		const { deleted } = await store.retention(new Set())
		// Either the Keep committed and the file survives, or the file was gone before the Keep could verify it.
		if (kept.has("d_A~old.wav")) {
			expect(existsSync(path)).toBe(true)
			expect(deleted).not.toContain(join("recordings", "dv", "d_A", "old.wav"))
		} else expect(existsSync(path)).toBe(false)
		expect(existsSync(join(root, "recordings/dv/d_A/mid.wav"))).toBe(false)
	})

	it("removeDiscovery: a symlinked discovery folder loses only the link; the outside call.wav survives", async () => {
		const { port } = fakeProtection([])
		const { root, store } = await evidenceWith(port)
		const outside = await tmp()
		await writeFile(join(outside, "call.wav"), Buffer.alloc(10))
		await mkdir(join(root, "recordings/analog"), { recursive: true })
		await symlink(outside, join(root, "recordings/analog/d_A"))
		await store.removeDiscovery("d_A")
		expect(existsSync(join(outside, "call.wav"))).toBe(true)
		expect(existsSync(join(root, "recordings/analog/d_A"))).toBe(false)
		expect(existsSync(join(root, "recordings/dv/d_A"))).toBe(false)
	})

	it("removeDiscovery: a symlink entry is unlinked as a link, never followed", async () => {
		const { port, asked } = fakeProtection([])
		const { root, store } = await evidenceWith(port)
		const outside = await tmp()
		const target = join(outside, "call.wav")
		await writeFile(target, Buffer.alloc(10))
		await symlink(target, join(root, "recordings/dv/d_A/link.wav"))
		await store.removeDiscovery("d_A")
		expect(existsSync(target)).toBe(true)
		expect(existsSync(join(root, "recordings/dv/d_A"))).toBe(false)
		// The link name was put to the deletion decision like any recording.
		expect(asked).toContain("d_A~link.wav")
	})

	it("removeDiscovery: a kept symlink entry refuses the removal", async () => {
		const { port } = fakeProtection(["d_A~link.wav"])
		const { root, store } = await evidenceWith(port)
		const outside = await tmp()
		await writeFile(join(outside, "call.wav"), Buffer.alloc(10))
		await symlink(
			join(outside, "call.wav"),
			join(root, "recordings/dv/d_A/link.wav"),
		)
		await expect(store.removeDiscovery("d_A")).rejects.toMatchObject({
			code: SCANNER_DISCOVERY_HOLDS_KEPT_CODE,
		})
		expect(existsSync(join(root, "recordings/dv/d_A/link.wav"))).toBe(true)
	})
})

describe("round-3 review fixes: retention and guarded removal never follow directory aliases", () => {
	it("retention: a symlinked discovery alias never unlinks another discovery's kept file", async () => {
		const { port } = fakeProtection(["d_B~new.wav"])
		const { root, store } = await evidenceWith(port)
		await symlink(
			join(root, "recordings/dv/d_B"),
			join(root, "recordings/dv/d_C"),
		)
		const { deleted } = await store.retention(new Set())
		expect(existsSync(join(root, "recordings/dv/d_B/new.wav"))).toBe(true)
		expect(deleted.some(rel => rel.includes("d_C"))).toBe(false)
	})

	it("retention: an evidence alias to a recordings folder never deletes recordings as evidence", async () => {
		const { port } = fakeProtection([], true)
		const { root, store } = await evidenceWith(port)
		await symlink(join(root, "recordings/dv/d_A"), join(root, "evidence/d_C"))
		const { deleted } = await store.retention(new Set())
		expect(deleted).toEqual([join("evidence", "d_A", "psd.json")])
		expect(existsSync(join(root, "recordings/dv/d_A/old.wav"))).toBe(true)
		expect(existsSync(join(root, "recordings/dv/d_A/mid.wav"))).toBe(true)
	})

	it("retention: a symlinked candidate file is never unlinked", async () => {
		const { port } = fakeProtection([])
		const { root, store } = await evidenceWith(port)
		const outside = await tmp()
		await writeFile(join(outside, "x.wav"), Buffer.alloc(10))
		const old = (Date.now() - 3 * DAY) / 1000
		await utimes(join(outside, "x.wav"), old, old)
		await symlink(join(outside, "x.wav"), join(root, "recordings/dv/d_A/x.wav"))
		const { deleted } = await store.retention(new Set())
		expect(deleted).not.toContain(join("recordings", "dv", "d_A", "x.wav"))
		expect(existsSync(join(root, "recordings/dv/d_A/x.wav"))).toBe(true)
	})

	it("removeDiscovery: a symlinked recordings/analog ancestor is refused as cleanup pending, untouched", async () => {
		const { port } = fakeProtection([])
		const { root, store } = await evidenceWith(port)
		const outside = await tmp()
		await mkdir(join(outside, "d_A"))
		await writeFile(join(outside, "d_A", "call.wav"), "FOREIGN")
		await symlink(outside, join(root, "recordings", "analog"))
		await expect(store.removeDiscovery("d_A")).rejects.toMatchObject({
			code: "SCANNER_EVIDENCE_CLEANUP_PENDING",
		})
		expect(existsSync(join(outside, "d_A", "call.wav"))).toBe(true)
		// The discovery's evidence stays for a later retry.
		expect(existsSync(join(root, "evidence/d_A/psd.json"))).toBe(true)
	})

	it("without a port, an aliased discovery folder is followed exactly as the frozen code did", async () => {
		const { root, store } = await evidenceWith()
		await symlink(
			join(root, "recordings/dv/d_B"),
			join(root, "recordings/dv/d_C"),
		)
		await symlink(join(root, "recordings/dv/d_A"), join(root, "evidence/d_C"))
		const { deleted } = await store.retention(new Set())
		// Recorded from the frozen code: the evidence alias deletes through to recordings.
		expect(deleted).toEqual([
			join("evidence", "d_A", "psd.json"),
			join("evidence", "d_C", "old.wav"),
			join("recordings", "dv", "d_A", "old.wav"),
			join("recordings", "dv", "d_A", "mid.wav"),
			join("recordings", "dv", "d_B", "new.wav"),
		])
		expect(existsSync(join(root, "recordings/dv/d_B/new.wav"))).toBe(false)
	})
})

describe("round-4 review fixes: a directory swapped during the deleter's awaits is never followed", () => {
	it("retention: a discovery folder swapped for an alias after collect() never unlinks the kept target", async () => {
		const { port } = fakeProtection(["d_B~new.wav"])
		const { root, store } = await evidenceWith(port)
		const now = Date.now()
		await put(root, "recordings/dv/d_C/new.wav", 2 * DAY, now)
		const first = join(root, "recordings/dv/d_A/old.wav")
		const dC = join(root, "recordings/dv/d_C")
		// After the earlier unlink completes, d_C becomes an alias of d_B.
		fsHook.atYield = p => {
			if (p !== first) return
			fsHook.atYield = null
			renameSync(dC, `${dC}.moved`)
			symlinkSync(join(root, "recordings/dv/d_B"), dC)
		}
		const { deleted } = await store.retention(new Set())
		expect(existsSync(first)).toBe(false)
		expect(existsSync(join(root, "recordings/dv/d_B/new.wav"))).toBe(true)
		expect(deleted).not.toContain(join("recordings", "dv", "d_C", "new.wav"))
	})

	it("removeDiscovery: a discovery folder swapped for an alias mid-drain never unlinks the target's files", async () => {
		const { port } = fakeProtection(["d_B~old.wav", "d_B~mid.wav"])
		const { root, store } = await evidenceWith(port)
		const now = Date.now()
		await put(root, "recordings/dv/d_B/old.wav", DAY, now)
		await put(root, "recordings/dv/d_B/mid.wav", DAY, now)
		const dA = join(root, "recordings/dv/d_A")
		fsHook.atYield = p => {
			if (!p.startsWith(`${dA}/`)) return
			fsHook.atYield = null
			renameSync(dA, `${dA}.moved`)
			symlinkSync(join(root, "recordings/dv/d_B"), dA)
		}
		await expect(store.removeDiscovery("d_A")).rejects.toMatchObject({
			code: "SCANNER_EVIDENCE_CLEANUP_PENDING",
		})
		expect(existsSync(join(root, "recordings/dv/d_B/old.wav"))).toBe(true)
		expect(existsSync(join(root, "recordings/dv/d_B/mid.wav"))).toBe(true)
		expect(existsSync(join(root, "recordings/dv/d_B/new.wav"))).toBe(true)
	})

	it("removeDiscovery: a folder swapped for an alias before a nested-folder rm never recurses into the target", async () => {
		const { port } = fakeProtection([])
		const { root, store } = await evidenceWith(port)
		const now = Date.now()
		await put(root, "recordings/dv/d_A/z/inner.bin", DAY, now)
		await put(root, "recordings/dv/d_X/z/inner.bin", DAY, now)
		const dA = join(root, "recordings/dv/d_A")
		const last = join(dA, "old.wav")
		// Entries in name order: mid.wav, old.wav, z. The swap lands after the last file unlink.
		fsHook.sortReaddir = true
		fsHook.atYield = p => {
			if (p !== last) return
			fsHook.atYield = null
			renameSync(dA, `${dA}.moved`)
			symlinkSync(join(root, "recordings/dv/d_X"), dA)
		}
		await expect(store.removeDiscovery("d_A")).rejects.toMatchObject({
			code: "SCANNER_EVIDENCE_CLEANUP_PENDING",
		})
		expect(existsSync(join(root, "recordings/dv/d_X/z/inner.bin"))).toBe(true)
	})
})
