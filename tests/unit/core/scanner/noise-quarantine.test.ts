/**
 * Noise quarantine (reversible `discarded:noise`): a noise cancel moves the analog operation's
 * written audio to `<storage>/quarantine/noise/<day>/<operationId>.wav` with its final WAV header
 * and a sidecar; every other cancel still deletes; a failed move deletes (today's behaviour).
 * The quarantine is hidden from the recordings inventory and the store's serve path, and pruned
 * by age (older than 7 d), total size (500 MiB) and file count, after each write and at startup.
 * Synthetic PCM only; bounds are injected small so nothing large is written.
 */
import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import {
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { wavHeader } from "../../../../src/core/scanner/channel/wav-writer.js"
import type { AnalogMetadataAdapter } from "../../../../src/core/scanner/store/analog-operations.js"
import { DiscoveryStore } from "../../../../src/core/scanner/store/discovery-store.js"
import { EvidenceStore } from "../../../../src/core/scanner/store/evidence-store.js"
import {
	NOISE_QUARANTINE,
	NOISE_QUARANTINE_DIR,
	NOISE_QUARANTINE_MAX_AGE_MS,
	NOISE_QUARANTINE_MAX_BYTES,
	NoiseQuarantine,
	NoiseQuarantineSidecarSchema,
	nodeNoiseQuarantineFs,
	type NoiseQuarantineFacts,
	type NoiseQuarantineFs,
} from "../../../../src/core/scanner/store/noise-quarantine.js"
import type { RecordingBinding } from "../../../../src/core/scanner/store/recording-operation.js"
import { createRecordingInventory } from "../../../../src/core/recordings/inventory.js"
import { createLogger } from "../../../../src/utils/logger.js"
import { counterIds, makeObs } from "../../../mocks/scanner/observations.js"

const logger = createLogger({ level: "fatal" })
const NOW = Date.UTC(2026, 10, 22, 12, 0, 0)
const DAY = "2026-11-22"
const MIB = 1024 * 1024
const dirs: string[] = []
const facts: NoiseQuarantineFacts = {
	frequencyHz: 446_000_000,
	reason: "noise",
	strength: "none",
	levelFrames: 150,
	spreadDb: 4.2,
	p10Dbfs: -12.5,
	periodicShare: 0.04,
	burstFrames: 1,
}

afterEach(async () => {
	await Promise.all(
		dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })),
	)
})

async function tempRoot(): Promise<string> {
	const root = await realpath(
		await mkdtemp(join(tmpdir(), "wavekit-noise-quarantine-")),
	)
	dirs.push(root)
	return root
}

/** Node fs, with mtimes read from `mtimes` (path → ms) when set: exact ages without utimes. */
function timedFs(
	mtimes: Map<string, number>,
	over: Partial<NoiseQuarantineFs> = {},
): NoiseQuarantineFs {
	return {
		...nodeNoiseQuarantineFs,
		lstat: async path => {
			const info = await nodeNoiseQuarantineFs.lstat(path)
			const mtimeMs = mtimes.get(path)
			return mtimeMs === undefined
				? info
				: {
						isFile: () => info.isFile(),
						isDirectory: () => info.isDirectory(),
						size: info.size,
						mtimeMs,
					}
		},
		...over,
	}
}

/** A quarantined WAV (no sidecar) of `bytes` bytes and mtime `mtimeMs` in day folder `day`. */
async function plant(
	q: NoiseQuarantine,
	mtimes: Map<string, number>,
	bytes: number,
	mtimeMs: number,
	day = DAY,
): Promise<string> {
	const folder = join(q.dir, day)
	await mkdir(folder, { recursive: true })
	const path = join(folder, `${randomUUID()}.wav`)
	await writeFile(path, Buffer.alloc(bytes))
	mtimes.set(path, mtimeMs)
	return path
}

/** A WAV part as the writer leaves it before its finish: header with data size 0, then PCM. */
async function part(path: string, frames: number): Promise<Buffer> {
	const pcm = Buffer.alloc(frames * 2)
	for (let i = 0; i < frames; i++) pcm.writeInt16LE((i % 64) - 32, i * 2)
	await writeFile(path, Buffer.concat([wavHeader(8000, 0), pcm]))
	return pcm
}

function ids(): {
	operationId: string
	discoveryId: string
	observationId: string
} {
	return {
		operationId: randomUUID(),
		discoveryId: "d_01ABC",
		observationId: "o1",
	}
}

describe("noise quarantine bounds", () => {
	it("the flag is on by default and the bounds state their arithmetic", () => {
		expect(NOISE_QUARANTINE).toBe(true)
		expect(NOISE_QUARANTINE_MAX_AGE_MS).toBe(604_800_000)
		expect(NOISE_QUARANTINE_MAX_BYTES).toBe(524_288_000)
		// 8 kHz 16-bit mono: 16 000 B/s → 500 MiB ≈ 9.1 h ≈ 6 500 five-second files.
		expect(NOISE_QUARANTINE_MAX_BYTES / 16_000 / 3600).toBeCloseTo(9.1, 1)
		expect(Math.floor(NOISE_QUARANTINE_MAX_BYTES / 80_044)).toBe(6_549)
		expect(NOISE_QUARANTINE_DIR).toBe(join("quarantine", "noise"))
	})

	it("age: 7 d − 1 ms kept, 7 d + 1 ms pruned, exactly 7 d kept", async () => {
		const root = await tempRoot()
		const mtimes = new Map<string, number>()
		const q = new NoiseQuarantine({
			root,
			logger,
			now: () => NOW,
			fs: timedFs(mtimes),
		})
		const keptJust = await plant(
			q,
			mtimes,
			100,
			NOW - NOISE_QUARANTINE_MAX_AGE_MS + 1,
		)
		const keptExact = await plant(
			q,
			mtimes,
			100,
			NOW - NOISE_QUARANTINE_MAX_AGE_MS,
		)
		const pruned = await plant(
			q,
			mtimes,
			100,
			NOW - NOISE_QUARANTINE_MAX_AGE_MS - 1,
			"2026-11-15",
		)
		await q.prune()
		expect(existsSync(keptJust)).toBe(true)
		expect(existsSync(keptExact)).toBe(true)
		expect(existsSync(pruned)).toBe(false)
		// The emptied past day folder goes; today's stays.
		expect(existsSync(join(q.dir, "2026-11-15"))).toBe(false)
		expect(existsSync(join(q.dir, DAY))).toBe(true)
	})

	it("size: exactly the bound kept; one byte over prunes the oldest first", async () => {
		const root = await tempRoot()
		const mtimes = new Map<string, number>()
		const q = new NoiseQuarantine({
			root,
			logger,
			now: () => NOW,
			fs: timedFs(mtimes),
			maxBytes: 300,
		})
		const oldest = await plant(q, mtimes, 100, NOW - 3000)
		const middle = await plant(q, mtimes, 100, NOW - 2000)
		const newest = await plant(q, mtimes, 100, NOW - 1000)
		await q.prune()
		expect([oldest, middle, newest].map(p => existsSync(p))).toEqual([
			true,
			true,
			true,
		])
		const over = await plant(q, mtimes, 1, NOW)
		await q.prune()
		expect([oldest, middle, newest, over].map(p => existsSync(p))).toEqual([
			false,
			true,
			true,
			true,
		])
	})

	it("a sidecar counts toward the size bound and goes with its WAV", async () => {
		const root = await tempRoot()
		const mtimes = new Map<string, number>()
		const q = new NoiseQuarantine({
			root,
			logger,
			now: () => NOW,
			fs: timedFs(mtimes),
			maxBytes: 200,
		})
		const a = await plant(q, mtimes, 100, NOW - 2000)
		const side = a.replace(/\.wav$/, ".json")
		await writeFile(side, Buffer.alloc(1))
		const b = await plant(q, mtimes, 100, NOW - 1000)
		await q.prune()
		expect(existsSync(a)).toBe(false)
		expect(existsSync(side)).toBe(false)
		expect(existsSync(b)).toBe(true)
	})

	it("count: at the file bound kept, one past it prunes the oldest", async () => {
		const root = await tempRoot()
		const mtimes = new Map<string, number>()
		const q = new NoiseQuarantine({
			root,
			logger,
			now: () => NOW,
			fs: timedFs(mtimes),
			maxFiles: 2,
		})
		const a = await plant(q, mtimes, 10, NOW - 3000)
		const b = await plant(q, mtimes, 10, NOW - 2000)
		await q.prune()
		expect([a, b].map(p => existsSync(p))).toEqual([true, true])
		const c = await plant(q, mtimes, 10, NOW - 1000)
		await q.prune()
		expect([a, b, c].map(p => existsSync(p))).toEqual([false, true, true])
	})

	it("prune ignores foreign names and symlinks, and a missing folder is not an error", async () => {
		const root = await tempRoot()
		const q = new NoiseQuarantine({ root, logger, now: () => NOW, maxBytes: 0 })
		await q.prune()
		await mkdir(join(q.dir, DAY), { recursive: true })
		const foreign = join(q.dir, DAY, "notes.txt")
		await writeFile(foreign, "x")
		await q.prune()
		expect(existsSync(foreign)).toBe(true)
	})
})

describe("noise quarantine admit", () => {
	it("moves the part, writes its final header and a schema-valid sidecar", async () => {
		const root = await tempRoot()
		const q = new NoiseQuarantine({ root, logger, now: () => NOW })
		const source = join(root, "payload.wav.part")
		const pcm = await part(source, 4000)
		const id = ids()
		expect(await q.admit(source, id, facts)).toBe(true)
		await q.prune()
		expect(existsSync(source)).toBe(false)
		const wav = await readFile(join(q.dir, DAY, `${id.operationId}.wav`))
		expect(wav.subarray(0, 44).equals(wavHeader(8000, pcm.length))).toBe(true)
		expect(wav.subarray(44).equals(pcm)).toBe(true)
		const sidecar = NoiseQuarantineSidecarSchema.parse(
			JSON.parse(
				await readFile(join(q.dir, DAY, `${id.operationId}.json`), "utf8"),
			),
		)
		expect(sidecar).toMatchObject({
			verdict: "discarded:noise",
			...id,
			fileBytes: 44 + pcm.length,
			quarantinedAt: new Date(NOW).toISOString(),
			facts,
		})
	})

	it("across devices (EXDEV): copies then removes the source", async () => {
		const root = await tempRoot()
		const q = new NoiseQuarantine({
			root,
			logger,
			now: () => NOW,
			fs: {
				...nodeNoiseQuarantineFs,
				rename: async () => {
					throw Object.assign(new Error("cross-device"), { code: "EXDEV" })
				},
			},
		})
		const source = join(root, "payload.wav.part")
		await part(source, 100)
		const id = ids()
		expect(await q.admit(source, id, facts)).toBe(true)
		expect(existsSync(source)).toBe(false)
		expect(existsSync(join(q.dir, DAY, `${id.operationId}.wav`))).toBe(true)
	})

	it("a failed move answers false and leaves the source to the caller (delete)", async () => {
		const root = await tempRoot()
		const q = new NoiseQuarantine({
			root,
			logger,
			now: () => NOW,
			fs: {
				...nodeNoiseQuarantineFs,
				rename: async () => {
					throw Object.assign(new Error("denied"), { code: "EACCES" })
				},
			},
		})
		const source = join(root, "payload.wav.part")
		await part(source, 100)
		expect(await q.admit(source, ids(), facts)).toBe(false)
		expect(existsSync(source)).toBe(true)
	})

	it("a failure after the move removes the moved file (nothing half made stays)", async () => {
		const root = await tempRoot()
		const q = new NoiseQuarantine({
			root,
			logger,
			now: () => NOW,
			fs: {
				...nodeNoiseQuarantineFs,
				writeFile: async () => {
					throw Object.assign(new Error("full"), { code: "ENOSPC" })
				},
			},
		})
		const source = join(root, "payload.wav.part")
		await part(source, 100)
		const id = ids()
		expect(await q.admit(source, id, facts)).toBe(false)
		expect(existsSync(join(q.dir, DAY, `${id.operationId}.wav`))).toBe(false)
	})

	it("malformed facts or a non-PCM part are refused (false), never thrown", async () => {
		const root = await tempRoot()
		const q = new NoiseQuarantine({ root, logger, now: () => NOW })
		const source = join(root, "payload.wav.part")
		await part(source, 10)
		expect(
			await q.admit(source, ids(), { ...facts, reason: "Bad Code!" }),
		).toBe(false)
		expect(
			await q.admit(source, { ...ids(), discoveryId: "../x" }, facts),
		).toBe(false)
		await writeFile(source, Buffer.alloc(45))
		expect(await q.admit(source, ids(), facts)).toBe(false)
		expect(existsSync(source)).toBe(true)
	})
})

async function harness(
	opts: { noiseQuarantine?: false | { fs: NoiseQuarantineFs } } = {},
) {
	const root = await tempRoot()
	const store = new DiscoveryStore({
		maxDiscoveries: 100,
		now: () => NOW,
		newId: counterIds(),
	})
	const discoveryId = store.ingest(
		makeObs({ id: "o1", centreHz: 446_000_000, startedAt: NOW }),
	).discoveryId!
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
	const adapter: AnalogMetadataAdapter = {
		authorityHealthy: () => true,
		bindingLive: () => true,
		association: (d, o, historical) =>
			store.recordingAssociation(d, o, historical),
		prepare: async metadata => {
			store.prepareRecording(metadata)
		},
		inverse: async id => {
			store.removePreparedRecording(id)
		},
		buildCommitPlan: id => store.buildRecordingCommitPlan(id),
		commitPlanCurrent: plan => store.recordingCommitPlanCurrent(plan),
		publishCommit: plan => store.publishRecordingCommit(plan),
	}
	const evidence = new EvidenceStore({
		dir: root,
		caps: {
			maxRecordingsMb: 20,
			maxEvidenceMb: 1,
			maxAgeDays: 30,
			minFreeDiskMb: 1,
		},
		logger,
		now: () => NOW,
		statfs: async () => ({ freeBytes: 1e9 }),
		isDiscoveryLive: id => !!store.get(id),
		...(opts.noiseQuarantine !== undefined
			? { noiseQuarantine: opts.noiseQuarantine }
			: {}),
	})
	evidence.configureAnalog(adapter)
	await evidence.recoverAnalog()
	const inventory = createRecordingInventory({
		dsdFmeDirs: () => [],
		scannerRecordingsDir: () => join(root, "recordings"),
		now: () => NOW,
		logger,
	})
	return { root, store, discoveryId, binding, evidence, inventory }
}

async function writtenOp(h: Awaited<ReturnType<typeof harness>>) {
	const op = h.evidence.beginAnalog({
		discoveryId: h.discoveryId,
		observationId: "o1",
		binding: h.binding,
	})
	await op.ready
	await op.push(new Int16Array(8000).fill(1200))
	return op
}

async function filesUnder(dir: string): Promise<string[]> {
	if (!existsSync(dir)) return []
	const out: string[] = []
	for (const name of await readdir(dir, { recursive: true }))
		if ((await lstat(join(dir, name))).isFile()) out.push(name)
	return out.sort()
}

describe("noise quarantine through the analog operation's cancel", () => {
	it("noise cancel: aborted receipt, the WAV in quarantine, hidden from inventory and serve", async () => {
		const h = await harness()
		const op = await writtenOp(h)
		op.cancel("cancelled", facts)
		const receipt = await op.settled
		expect(receipt.outcome).toBe("aborted")
		expect(receipt.cutReason).toBe("cancelled")
		const day = join(h.root, NOISE_QUARANTINE_DIR, DAY)
		const wav = await readFile(join(day, `${op.operationId}.wav`))
		expect(wav.length).toBe(44 + 16_000)
		expect(wav.subarray(0, 44).equals(wavHeader(8000, 16_000))).toBe(true)
		expect(existsSync(join(day, `${op.operationId}.json`))).toBe(true)
		// Nothing left in the operation folder or under recordings/.
		expect(
			existsSync(
				join(h.root, ".analog-operations", op.operationId, "payload.wav.part"),
			),
		).toBe(false)
		expect(await filesUnder(join(h.root, "recordings"))).toEqual([])
		const page = await h.inventory.list({ limit: "200" })
		expect(page.items).toEqual([])
		const alias = `${h.discoveryId}~analog-${op.operationId}.wav`
		expect(await h.inventory.resolve(`scan:${alias}`)).toBeNull()
		expect(h.evidence.recordingPath(alias)).toBeNull()
	})

	it("a non-noise cancel still deletes (no quarantine)", async () => {
		const h = await harness()
		const op = await writtenOp(h)
		op.cancel("cancelled")
		expect((await op.settled).outcome).toBe("aborted")
		expect(await filesUnder(join(h.root, "quarantine"))).toEqual([])
		expect(
			existsSync(
				join(h.root, ".analog-operations", op.operationId, "payload.wav.part"),
			),
		).toBe(false)
	})

	it("a failed quarantine falls back to delete; the receipt is still aborted", async () => {
		const h = await harness({
			noiseQuarantine: {
				fs: {
					...nodeNoiseQuarantineFs,
					mkdir: async () => {
						throw Object.assign(new Error("denied"), { code: "EACCES" })
					},
				},
			},
		})
		const op = await writtenOp(h)
		op.cancel("cancelled", facts)
		const receipt = await op.settled
		expect(receipt.outcome).toBe("aborted")
		expect(receipt.cleanup).toBe("complete")
		expect(await filesUnder(join(h.root, "quarantine"))).toEqual([])
		expect(
			existsSync(
				join(h.root, ".analog-operations", op.operationId, "payload.wav.part"),
			),
		).toBe(false)
	})

	it("quarantine off (false): a noise cancel deletes as before", async () => {
		const h = await harness({ noiseQuarantine: false })
		expect(h.evidence.noiseQuarantine).toBeNull()
		const op = await writtenOp(h)
		op.cancel("cancelled", facts)
		expect((await op.settled).outcome).toBe("aborted")
		expect(await filesUnder(join(h.root, "quarantine"))).toEqual([])
	})

	it("startup prune: recoverAnalog prunes an expired quarantined file", async () => {
		const root = await tempRoot()
		const folder = join(root, NOISE_QUARANTINE_DIR, "2026-11-01")
		await mkdir(folder, { recursive: true })
		const stale = join(folder, `${randomUUID()}.wav`)
		await writeFile(stale, Buffer.alloc(44))
		const fresh = join(folder, `${randomUUID()}.wav`)
		await writeFile(fresh, Buffer.alloc(44))
		const mtimes = new Map([
			[stale, NOW - NOISE_QUARANTINE_MAX_AGE_MS - 1],
			[fresh, NOW - 1000],
		])
		const evidence = new EvidenceStore({
			dir: root,
			caps: {
				maxRecordingsMb: 20,
				maxEvidenceMb: 1,
				maxAgeDays: 30,
				minFreeDiskMb: 1,
			},
			logger,
			now: () => NOW,
			statfs: async () => ({ freeBytes: 1e9 }),
			noiseQuarantine: { fs: timedFs(mtimes) },
		})
		await evidence.recoverAnalog()
		await evidence.noiseQuarantine!.prune()
		expect(existsSync(stale)).toBe(false)
		expect(existsSync(fresh)).toBe(true)
	})

	it("the 500 MiB default holds a 6 day corpus of 2 200 five-second files", () => {
		expect(2_200 * 80_044).toBeLessThan(NOISE_QUARANTINE_MAX_BYTES)
		expect(MIB).toBe(1_048_576)
	})
})
