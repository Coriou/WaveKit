import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
	chmod,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
	BACKUP_EXPIRY_CLEAN_LOADS,
	BACKUP_EXPIRY_MS,
	BACKUP_MAX_KEPT,
	BACKUP_MIN_FREE_BYTES,
	BACKUP_OUTSIDE_DIR,
	BACKUP_RECEIPT_COUNT_MAX,
	BACKUP_RECEIPT_FILE,
	BACKUPS_DIR,
	CURRENT_SCANNER_STATE_FORMAT,
	backupsToPrune,
	ensurePreMigrationBackup,
	formatLabel,
	noteCleanLoad,
	STATE_FORMAT_FILE,
} from "../../../src/core/state-backup.js"
import type { StateFormat, StatFsLike } from "../../../src/core/state-backup.js"
import { ScannerPersistence } from "../../../src/core/scanner/store/persistence.js"
import { createLogger } from "../../../src/utils/logger.js"

const logger = createLogger({ level: "fatal" })
const NOW = 1_800_000_000_000
const JOBS = '{"version":1,"jobs":[]}\n'
const JOURNAL = '{"seq":1}\n'
const AUDIO = "RIFF-audio-bytes"
const CURRENT = formatLabel(CURRENT_SCANNER_STATE_FORMAT)

/** Plenty of space: 1 TiB in 4 KiB blocks. */
const roomy = (): Promise<StatFsLike> =>
	Promise.resolve({ bavail: 268_435_456n, bsize: 4096n })

let dir: string
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "wk-state-backup-"))
})
afterEach(async () => {
	await rm(dir, { recursive: true, force: true })
})

/** A small state tree: copied metadata (jobs + journal) and one hard-linked recording. */
async function seedState(): Promise<number> {
	await writeFile(join(dir, "jobs.json"), JOBS)
	await mkdir(join(dir, "journal"), { recursive: true })
	await writeFile(join(dir, "journal", "observations-20260101.jsonl"), JOURNAL)
	await mkdir(join(dir, "recordings", "d_1"), { recursive: true })
	await writeFile(join(dir, "recordings", "d_1", "a.wav"), AUDIO)
	return Buffer.byteLength(JOBS) + Buffer.byteLength(JOURNAL)
}

async function writeMarker(value: unknown): Promise<void> {
	await writeFile(join(dir, STATE_FORMAT_FILE), JSON.stringify(value))
}

const receiptOf = async (name: string): Promise<Record<string, unknown>> =>
	JSON.parse(
		await readFile(join(dir, BACKUPS_DIR, name, BACKUP_RECEIPT_FILE), "utf8"),
	) as Record<string, unknown>

async function patchReceipt(
	name: string,
	patch: Record<string, unknown>,
): Promise<void> {
	await writeFile(
		join(dir, BACKUPS_DIR, name, BACKUP_RECEIPT_FILE),
		JSON.stringify({ ...(await receiptOf(name)), ...patch }),
	)
}

const backups = async (): Promise<string[]> =>
	(await readdir(join(dir, BACKUPS_DIR)).catch(() => [] as string[])).sort()

describe("pre-migration backup of scanner state", () => {
	it("a fresh directory needs no backup and gets this build's marker", async () => {
		const out = await ensurePreMigrationBackup({
			dir,
			logger,
			now: () => NOW,
			statfs: roomy,
		})
		expect(out).toEqual({ kind: "none", reason: "fresh", toFormat: CURRENT })
		const marker: unknown = JSON.parse(
			await readFile(join(dir, STATE_FORMAT_FILE), "utf8"),
		)
		expect(marker).toEqual(CURRENT_SCANNER_STATE_FORMAT)
		expect(await backups()).toEqual([])
	})

	it("state without a marker is backed up once; the same format later is not", async () => {
		const copied = await seedState()
		const first = await ensurePreMigrationBackup({
			dir,
			logger,
			now: () => NOW,
			statfs: roomy,
		})
		expect(first).toMatchObject({
			kind: "taken",
			fromFormat: "unmarked",
			toFormat: CURRENT,
			path: join(BACKUPS_DIR, `pre-unmarked.${NOW}`),
			files: 3,
			copiedBytes: copied,
			linkedFiles: 1,
			keepsCopied: false,
			replaced: 0,
		})
		const root = join(dir, BACKUPS_DIR, `pre-unmarked.${NOW}`)
		// Unmarked state: the backup carries no marker (restoring it means deleting the live one).
		expect(await readdir(root)).not.toContain(STATE_FORMAT_FILE)
		expect(await readFile(join(root, "jobs.json"), "utf8")).toBe(JOBS)
		// The journal is appended in place, so it never shares an inode with the backup.
		const liveJournal = await stat(
			join(dir, "journal", "observations-20260101.jsonl"),
		)
		const savedJournal = await stat(
			join(root, "journal", "observations-20260101.jsonl"),
		)
		expect(savedJournal.ino).not.toBe(liveJournal.ino)
		// A recording is written once, so it is a hard link.
		const liveRec = await stat(join(dir, "recordings", "d_1", "a.wav"))
		const savedRec = await stat(join(root, "recordings", "d_1", "a.wav"))
		expect(savedRec.ino).toBe(liveRec.ino)
		const receipt: unknown = JSON.parse(
			await readFile(join(root, BACKUP_RECEIPT_FILE), "utf8"),
		)
		expect(receipt).toMatchObject({
			fromFormat: "unmarked",
			toFormat: CURRENT,
			files: 3,
		})

		const second = await ensurePreMigrationBackup({
			dir,
			logger,
			now: () => NOW + 1,
			statfs: roomy,
		})
		expect(second).toEqual({
			kind: "none",
			reason: "same-format",
			toFormat: CURRENT,
		})
		expect(await backups()).toEqual([`pre-unmarked.${NOW}`])
	})

	it("a version change backs up under the old format with its marker; the next change keeps both (the cap)", async () => {
		await seedState()
		await writeMarker({ fileVersion: 1, heldJournalFormat: 2, revision: 1 })
		const first = await ensurePreMigrationBackup({
			dir,
			logger,
			now: () => NOW,
			statfs: roomy,
		})
		expect(first).toMatchObject({
			kind: "taken",
			fromFormat: "f1-h2-r1",
			replaced: 0,
		})
		expect(await backups()).toEqual([`pre-f1-h2-r1.${NOW}`])
		const firstRoot = join(dir, BACKUPS_DIR, `pre-f1-h2-r1.${NOW}`)
		// The backup never contains the backups directory itself...
		expect(await readdir(firstRoot)).not.toContain(BACKUPS_DIR)
		// ...and carries the marker it was taken under.
		expect(
			JSON.parse(await readFile(join(firstRoot, STATE_FORMAT_FILE), "utf8")),
		).toEqual({ fileVersion: 1, heldJournalFormat: 2, revision: 1 })

		const next = { fileVersion: 2, heldJournalFormat: 9, revision: 1 }
		const second = await ensurePreMigrationBackup({
			dir,
			logger,
			now: () => NOW + 1,
			statfs: roomy,
			format: next,
		})
		expect(second).toMatchObject({
			kind: "taken",
			fromFormat: CURRENT,
			toFormat: "f2-h9-r1",
			replaced: 0,
		})
		expect(await backups()).toEqual(
			[`pre-${CURRENT}.${NOW + 1}`, `pre-f1-h2-r1.${NOW}`].sort(),
		)
	})

	it("a malformed marker is an unknown format and is backed up (safe answer)", async () => {
		await seedState()
		await writeFile(join(dir, STATE_FORMAT_FILE), "{not json")
		const out = await ensurePreMigrationBackup({
			dir,
			logger,
			now: () => NOW,
			statfs: roomy,
		})
		expect(out).toMatchObject({ kind: "taken", fromFormat: "unknown" })
		await writeMarker({
			fileVersion: "1; rm -rf",
			heldJournalFormat: 3,
			revision: 1,
		})
		const out2 = await ensurePreMigrationBackup({
			dir,
			logger,
			now: () => NOW + 1,
			statfs: roomy,
		})
		// One backup per source format: the second unknown-format backup replaces the first.
		expect(out2).toMatchObject({
			kind: "taken",
			fromFormat: "unknown",
			replaced: 1,
		})
		expect(await backups()).toEqual([`pre-unknown.${NOW + 1}`])
	})

	it("is skipped when it would leave less than the free-space margin, taken at exactly the margin", async () => {
		const old = { fileVersion: 1, heldJournalFormat: 2, revision: 1 }
		await seedState()
		await writeMarker(old)
		// Everything outside recordings/ is counted as copied: jobs, journal and the marker.
		const copied =
			Buffer.byteLength(JOBS) +
			Buffer.byteLength(JOURNAL) +
			Buffer.byteLength(JSON.stringify(old))
		const space = (bytes: number) => (): Promise<StatFsLike> =>
			Promise.resolve({ bavail: bytes, bsize: 1 })
		const low = await ensurePreMigrationBackup({
			dir,
			logger,
			now: () => NOW,
			statfs: space(copied + BACKUP_MIN_FREE_BYTES - 1),
		})
		expect(low).toEqual({
			kind: "skipped",
			reason: "low-disk",
			fromFormat: "f1-h2-r1",
			toFormat: CURRENT,
			neededBytes: copied,
			freeBytes: copied + BACKUP_MIN_FREE_BYTES - 1,
		})
		expect(await backups()).toEqual([])
		// The marker is still written: the state is migrated this run, so a later backup would be mislabelled.
		await writeMarker(old)
		const exact = await ensurePreMigrationBackup({
			dir,
			logger,
			now: () => NOW,
			statfs: space(copied + BACKUP_MIN_FREE_BYTES),
		})
		expect(exact).toMatchObject({ kind: "taken", fromFormat: "f1-h2-r1" })
	})

	it("unknown free space skips the backup", async () => {
		await seedState()
		const out = await ensurePreMigrationBackup({
			dir,
			logger,
			now: () => NOW,
			statfs: () => Promise.reject(new Error("statfs unsupported")),
		})
		expect(out).toMatchObject({ kind: "skipped", reason: "disk-unknown" })
		const marker: unknown = JSON.parse(
			await readFile(join(dir, STATE_FORMAT_FILE), "utf8"),
		)
		expect(marker).toEqual(CURRENT_SCANNER_STATE_FORMAT)
	})

	it("a tree past the file bound is skipped; one at the bound is taken", async () => {
		await seedState()
		const at = await ensurePreMigrationBackup({
			dir,
			logger,
			now: () => NOW,
			statfs: roomy,
			maxFiles: 3,
		})
		expect(at).toMatchObject({ kind: "taken", files: 3 })
		await writeMarker({ fileVersion: 1, heldJournalFormat: 2, revision: 1 })
		await writeFile(join(dir, "settings.json"), "{}")
		const past = await ensurePreMigrationBackup({
			dir,
			logger,
			now: () => NOW,
			statfs: roomy,
			maxFiles: 3,
		})
		expect(past).toMatchObject({ kind: "skipped", reason: "too-many-files" })
	})

	it("links finished captures but copies their staging files", async () => {
		await mkdir(join(dir, "captures", ".tmp"), { recursive: true })
		await writeFile(join(dir, "captures", "c1.cu8"), "iq")
		await writeFile(join(dir, "captures", ".tmp", "c2.cu8"), "iq")
		const out = await ensurePreMigrationBackup({
			dir,
			logger,
			now: () => NOW,
			statfs: roomy,
		})
		expect(out).toMatchObject({ kind: "taken", files: 2, linkedFiles: 1 })
		const root = join(dir, BACKUPS_DIR, `pre-unmarked.${NOW}`, "captures")
		expect((await stat(join(root, "c1.cu8"))).ino).toBe(
			(await stat(join(dir, "captures", "c1.cu8"))).ino,
		)
		expect((await stat(join(root, ".tmp", "c2.cu8"))).ino).not.toBe(
			(await stat(join(dir, "captures", ".tmp", "c2.cu8"))).ino,
		)
	})

	it("falls back to a copy when a hard link is refused", async () => {
		await seedState()
		const out = await ensurePreMigrationBackup({
			dir,
			logger,
			now: () => NOW,
			statfs: roomy,
			link: () =>
				Promise.reject(
					Object.assign(new Error("cross-device"), { code: "EXDEV" }),
				),
		})
		expect(out).toMatchObject({ kind: "taken", linkedFiles: 0 })
		const saved = join(
			dir,
			BACKUPS_DIR,
			`pre-unmarked.${NOW}`,
			"recordings",
			"d_1",
			"a.wav",
		)
		expect(await readFile(saved, "utf8")).toBe(AUDIO)
	})

	it("ScannerPersistence.load backs up before reading, once per instance", async () => {
		await seedState()
		const p = new ScannerPersistence({
			dir,
			logger,
			now: () => NOW,
			backup: { statfs: roomy },
		})
		expect(p.preMigrationBackup()).toBeNull()
		await p.load()
		expect(p.preMigrationBackup()).toMatchObject({
			kind: "taken",
			fromFormat: "unmarked",
		})
		await p.load()
		expect(p.preMigrationBackup()).toMatchObject({
			kind: "taken",
			fromFormat: "unmarked",
		})
		const again = new ScannerPersistence({
			dir,
			logger,
			now: () => NOW,
			backup: { statfs: roomy },
		})
		await again.load()
		expect(again.preMigrationBackup()).toMatchObject({
			kind: "none",
			reason: "same-format",
		})
	})

	it("an upgrade, a downgrade and the next upgrade each keep the copy that undoes them", async () => {
		const A: StateFormat = { fileVersion: 1, heldJournalFormat: 2, revision: 1 }
		const B: StateFormat = { fileVersion: 2, heldJournalFormat: 2, revision: 1 }
		const a = formatLabel(A)
		const b = formatLabel(B)
		await seedState()
		await writeMarker(A)
		const step = (format: StateFormat, at: number) =>
			ensurePreMigrationBackup({
				dir,
				logger,
				now: () => at,
				statfs: roomy,
				format,
			})
		// Upgrade A -> B: the A state is kept.
		expect(await step(B, NOW)).toMatchObject({ kind: "taken", fromFormat: a })
		// An older build (A) starts on B state: B's own state is kept beside the A copy (2 = cap).
		expect(await step(A, NOW + 1)).toMatchObject({
			kind: "taken",
			fromFormat: b,
			replaced: 0,
		})
		expect(await backups()).toEqual([`pre-${a}.${NOW}`, `pre-${b}.${NOW + 1}`])
		// B again: one per source format, so the newer A copy replaces the older; B's is untouched.
		expect(await step(B, NOW + 2)).toMatchObject({
			kind: "taken",
			fromFormat: a,
			replaced: 1,
		})
		expect(await backups()).toEqual([
			`pre-${a}.${NOW + 2}`,
			`pre-${b}.${NOW + 1}`,
		])
		// A again: the B copy (what A must not lose to undo the downgrade) is the newest one kept.
		expect(await step(A, NOW + 3)).toMatchObject({
			kind: "taken",
			fromFormat: b,
			replaced: 1,
		})
		expect(await backups()).toEqual([
			`pre-${a}.${NOW + 2}`,
			`pre-${b}.${NOW + 3}`,
		])
	})

	it("retention keeps one per format, at most the cap, and never this build's own format", () => {
		expect(BACKUP_MAX_KEPT).toBe(2)
		const kept = (
			list: Array<[string, string | null, number]>,
			own: string,
			keep: string | null,
		) =>
			backupsToPrune(
				list.map(([name, fromFormat, at]) => ({ name, fromFormat, at })),
				own,
				keep,
			).sort()
		// At the cap: nothing goes.
		expect(
			kept(
				[
					["x", "f1", 1],
					["y", "f2", 2],
				],
				"f3",
				"y",
			),
		).toEqual([])
		// One past the cap: the oldest goes...
		expect(
			kept(
				[
					["x", "f1", 1],
					["y", "f2", 2],
					["z", "f3", 3],
				],
				"f9",
				"z",
			),
		).toEqual(["x"])
		// ...unless it is this build's own format: then the next oldest.
		expect(
			kept(
				[
					["x", "f1", 1],
					["y", "f2", 2],
					["z", "f3", 3],
				],
				"f1",
				"z",
			),
		).toEqual(["y"])
		// The just-taken backup is never deleted, even with an older receipt time.
		expect(
			kept(
				[
					["x", "f1", 5],
					["y", "f2", 6],
					["z", "f3", 1],
				],
				"f9",
				"z",
			),
		).toEqual(["x"])
		// Same source format: only the newest stays; the just-taken one wins.
		expect(
			kept(
				[
					["x", "f1", 9],
					["z", "f1", 1],
				],
				"f9",
				"z",
			),
		).toEqual(["x"])
		// Backups without a receipt are each their own format and the oldest.
		expect(
			kept(
				[
					["x", null, 0],
					["w", null, 0],
					["z", "f3", 3],
				],
				"f9",
				"z",
			),
		).toEqual(["w"])
	})

	it("a crash between the new backup's rename and the old one's delete leaves both complete; the next start prunes", async () => {
		await seedState()
		await writeMarker({ fileVersion: 9, heldJournalFormat: 9, revision: 9 })
		await ensurePreMigrationBackup({
			dir,
			logger,
			now: () => NOW,
			statfs: roomy,
		})
		await writeMarker({ fileVersion: 9, heldJournalFormat: 9, revision: 9 })
		const crashed = await ensurePreMigrationBackup({
			dir,
			logger,
			now: () => NOW + 1,
			statfs: roomy,
			remove: () => Promise.reject(new Error("killed")),
		})
		expect(crashed).toMatchObject({ kind: "taken", replaced: 0 })
		const names = await backups()
		expect(names).toEqual(["pre-f9-h9-r9." + NOW, `pre-f9-h9-r9.${NOW + 1}`])
		for (const n of names)
			expect(
				JSON.parse(
					await readFile(
						join(dir, BACKUPS_DIR, n, BACKUP_RECEIPT_FILE),
						"utf8",
					),
				),
			).toMatchObject({ fromFormat: "f9-h9-r9" })
		// The next start (same format) finishes the retention: the newer one stays.
		const next = await ensurePreMigrationBackup({
			dir,
			logger,
			now: () => NOW + 2,
			statfs: roomy,
		})
		expect(next).toMatchObject({ kind: "none", reason: "same-format" })
		expect(await backups()).toEqual([`pre-f9-h9-r9.${NOW + 1}`])
	})

	it("a failed copy keeps the earlier backup and leaves no partial one", async () => {
		await seedState()
		await writeMarker({ fileVersion: 9, heldJournalFormat: 9, revision: 9 })
		await ensurePreMigrationBackup({
			dir,
			logger,
			now: () => NOW,
			statfs: roomy,
		})
		await writeMarker({ fileVersion: 9, heldJournalFormat: 9, revision: 9 })
		// The recording vanishes mid-backup: its link and then its fallback copy fail.
		const out = await ensurePreMigrationBackup({
			dir,
			logger,
			now: () => NOW + 1,
			statfs: roomy,
			link: async src => {
				await rm(src)
				throw new Error("no links")
			},
		})
		expect(out).toMatchObject({ kind: "skipped", reason: "copy-failed" })
		expect(await backups()).toEqual([`pre-f9-h9-r9.${NOW}`])
	})

	it("the snapshot and the journal in the backup never share an inode with the live files", async () => {
		await seedState()
		await writeFile(join(dir, "discoveries.json"), '{"version":1}\n')
		await ensurePreMigrationBackup({
			dir,
			logger,
			now: () => NOW,
			statfs: roomy,
		})
		const root = join(dir, BACKUPS_DIR, `pre-unmarked.${NOW}`)
		for (const rel of [
			"discoveries.json",
			join("journal", "observations-20260101.jsonl"),
		]) {
			const live = await stat(join(dir, rel))
			const saved = await stat(join(root, rel))
			expect(saved.ino).not.toBe(live.ino)
			expect(saved.nlink).toBe(1)
		}
	})

	it("copies the keep store from outside the directory into the backup's outside folder", async () => {
		await seedState()
		const outside = await mkdtemp(join(tmpdir(), "wk-state-keeps-"))
		try {
			const keeps = join(outside, "recording-keeps.json")
			await writeFile(keeps, '{"schemaVersion":1,"keeps":[]}\n')
			const out = await ensurePreMigrationBackup({
				dir,
				logger,
				now: () => NOW,
				statfs: roomy,
				keepsFile: keeps,
			})
			expect(out).toMatchObject({ kind: "taken", keepsCopied: true })
			const saved = join(
				dir,
				BACKUPS_DIR,
				`pre-unmarked.${NOW}`,
				BACKUP_OUTSIDE_DIR,
				"recording-keeps.json",
			)
			expect(await readFile(saved, "utf8")).toBe(
				'{"schemaVersion":1,"keeps":[]}\n',
			)
			expect((await stat(saved)).ino).not.toBe((await stat(keeps)).ino)
			// A missing keep store is no failure.
			await writeMarker({ fileVersion: 9, heldJournalFormat: 9, revision: 9 })
			const none = await ensurePreMigrationBackup({
				dir,
				logger,
				now: () => NOW + 1,
				statfs: roomy,
				keepsFile: join(outside, "missing.json"),
			})
			expect(none).toMatchObject({ kind: "taken", keepsCopied: false })
		} finally {
			await rm(outside, { recursive: true, force: true })
		}
	})

	it.skipIf(process.getuid?.() === 0)(
		"an unreadable directory is skipped and its marker is not written",
		async () => {
			await seedState()
			// Write and search, no read: readdir fails (EACCES) while a marker write would succeed.
			await chmod(dir, 0o300)
			try {
				const out = await ensurePreMigrationBackup({
					dir,
					logger,
					now: () => NOW,
					statfs: roomy,
				})
				expect(out).toEqual({
					kind: "skipped",
					reason: "unreadable",
					fromFormat: "unknown",
					toFormat: CURRENT,
				})
			} finally {
				await chmod(dir, 0o700)
			}
			expect(await readdir(dir)).not.toContain(STATE_FORMAT_FILE)
			expect(await readdir(dir)).not.toContain(BACKUPS_DIR)
		},
	)

	it("a backup expires at 14 days with 3 clean loads, not before either bound", async () => {
		expect(BACKUP_EXPIRY_MS).toBe(1_209_600_000)
		expect(BACKUP_EXPIRY_CLEAN_LOADS).toBe(3)
		await seedState()
		await ensurePreMigrationBackup({
			dir,
			logger,
			now: () => NOW,
			statfs: roomy,
		})
		const name = `pre-unmarked.${NOW}`
		const receipt = async (): Promise<unknown> =>
			JSON.parse(
				await readFile(
					join(dir, BACKUPS_DIR, name, BACKUP_RECEIPT_FILE),
					"utf8",
				),
			)
		const load = (at: number) => noteCleanLoad({ dir, logger, now: () => at })
		// Old enough, but only 1 and then 2 clean loads: kept.
		expect(await load(NOW + BACKUP_EXPIRY_MS)).toEqual([])
		expect(await load(NOW + BACKUP_EXPIRY_MS)).toEqual([])
		expect(await receipt()).toMatchObject({
			cleanLoads: 2,
			fromFormat: "unmarked",
		})
		// The third clean load one millisecond short of 14 days: still kept.
		expect(await load(NOW + BACKUP_EXPIRY_MS - 1)).toEqual([])
		expect(await receipt()).toMatchObject({ cleanLoads: 3 })
		// At 14 days with 3 or more clean loads: deleted.
		expect(await load(NOW + BACKUP_EXPIRY_MS)).toEqual([name])
		expect(await backups()).toEqual([])
	})

	it("only backups taken on the way to this build's format count clean loads", async () => {
		await seedState()
		const other: StateFormat = {
			fileVersion: 7,
			heldJournalFormat: 7,
			revision: 7,
		}
		await ensurePreMigrationBackup({
			dir,
			logger,
			now: () => NOW,
			statfs: roomy,
			format: other,
		})
		for (let i = 0; i < 5; i++)
			expect(
				await noteCleanLoad({
					dir,
					logger,
					now: () => NOW + 2 * BACKUP_EXPIRY_MS,
				}),
			).toEqual([])
		expect(await backups()).toEqual([`pre-unmarked.${NOW}`])
	})

	it("after upgrade, downgrade, upgrade the newer build's own-format copy expires at 14 days and 3 own clean loads", async () => {
		const A: StateFormat = { fileVersion: 1, heldJournalFormat: 2, revision: 1 }
		const B: StateFormat = { fileVersion: 2, heldJournalFormat: 2, revision: 1 }
		const a = formatLabel(A)
		const b = formatLabel(B)
		await seedState()
		await writeMarker(A)
		const step = (format: StateFormat, at: number) =>
			ensurePreMigrationBackup({
				dir,
				logger,
				now: () => at,
				statfs: roomy,
				format,
			})
		await step(B, NOW)
		await step(A, NOW + 1)
		await step(B, NOW + 2)
		const preA = `pre-${a}.${NOW + 2}`
		const preB = `pre-${b}.${NOW + 1}`
		expect(await backups()).toEqual([preA, preB])
		const load = (at: number) =>
			noteCleanLoad({ dir, logger, now: () => at, format: B })
		// Old enough but 1, then 2 own clean loads: both kept.
		expect(await load(NOW + 2 + BACKUP_EXPIRY_MS)).toEqual([])
		expect(await load(NOW + 2 + BACKUP_EXPIRY_MS)).toEqual([])
		expect(await receiptOf(preB)).toMatchObject({ ownFormatCleanLoads: 2 })
		expect(await receiptOf(preA)).toMatchObject({ cleanLoads: 2 })
		// The third load 1 ms short of 14 days for the own-format copy: kept.
		expect(await load(NOW + BACKUP_EXPIRY_MS)).toEqual([])
		expect(await receiptOf(preB)).toMatchObject({ ownFormatCleanLoads: 3 })
		// Exactly 14 days for pre-B (pre-A 1 ms short): only pre-B goes.
		expect(await load(NOW + 1 + BACKUP_EXPIRY_MS)).toEqual([preB])
		expect(await backups()).toEqual([preA])
		// Past both bounds for pre-A: it goes too.
		expect(await load(NOW + 3 + BACKUP_EXPIRY_MS)).toEqual([preA])
		expect(await backups()).toEqual([])
	})

	it("retention protects this build's own-format copy until it has lapsed", () => {
		const list = [
			{ name: "x", fromFormat: "own", at: 1, seq: 1 },
			{ name: "y", fromFormat: "f2", at: 2, seq: 2 },
			{ name: "z", fromFormat: "f3", at: 3, seq: 3 },
		]
		expect(backupsToPrune(list, "own", "z")).toEqual(["y"])
		expect(
			backupsToPrune(
				list.map(b => (b.name === "x" ? { ...b, ownLapsed: true } : b)),
				"own",
				"z",
			),
		).toEqual(["x"])
	})

	it("crash recovery keeps the latest-taken backup of a format by sequence, even after a clock step back", async () => {
		await seedState()
		await writeMarker({ fileVersion: 9, heldJournalFormat: 9, revision: 9 })
		await ensurePreMigrationBackup({
			dir,
			logger,
			now: () => NOW + 10_000,
			statfs: roomy,
		})
		await writeMarker({ fileVersion: 9, heldJournalFormat: 9, revision: 9 })
		// The wall clock stepped back 10 s; the second start dies before its deletes.
		await ensurePreMigrationBackup({
			dir,
			logger,
			now: () => NOW,
			statfs: roomy,
			remove: () => Promise.reject(new Error("killed")),
		})
		const older = `pre-f9-h9-r9.${NOW + 10_000}`
		const newer = `pre-f9-h9-r9.${NOW}`
		expect(await receiptOf(older)).toMatchObject({ seq: 1 })
		expect(await receiptOf(newer)).toMatchObject({ seq: 2 })
		await ensurePreMigrationBackup({
			dir,
			logger,
			now: () => NOW + 1,
			statfs: roomy,
		})
		expect(await backups()).toEqual([newer])
	})

	it("receipt counters stop at the schema bound and the receipt stays valid", async () => {
		expect(BACKUP_RECEIPT_COUNT_MAX).toBe(1_000_000)
		await seedState()
		await ensurePreMigrationBackup({
			dir,
			logger,
			now: () => NOW,
			statfs: roomy,
		})
		const name = `pre-unmarked.${NOW}`
		await patchReceipt(name, { cleanLoads: BACKUP_RECEIPT_COUNT_MAX - 1 })
		const load = (at: number) => noteCleanLoad({ dir, logger, now: () => at })
		// One short of the bound, then at it, then past it: stays at the bound.
		expect(await load(NOW + 1)).toEqual([])
		expect(await receiptOf(name)).toMatchObject({
			cleanLoads: BACKUP_RECEIPT_COUNT_MAX,
		})
		expect(await load(NOW + 1)).toEqual([])
		expect(await receiptOf(name)).toMatchObject({
			cleanLoads: BACKUP_RECEIPT_COUNT_MAX,
		})
		// Still a valid receipt: it expires at 14 days instead of being read as unreadable.
		expect(await load(NOW + BACKUP_EXPIRY_MS)).toEqual([name])
	})

	it("the own-format counter and the sequence stop at the bound too", async () => {
		await seedState()
		await writeMarker(CURRENT_SCANNER_STATE_FORMAT)
		const other: StateFormat = {
			fileVersion: 7,
			heldJournalFormat: 7,
			revision: 7,
		}
		// An older build (other) starts on this build's state: the copy's source is this build's.
		await ensurePreMigrationBackup({
			dir,
			logger,
			now: () => NOW,
			statfs: roomy,
			format: other,
		})
		const own = `pre-${CURRENT}.${NOW}`
		await patchReceipt(own, {
			ownFormatCleanLoads: BACKUP_RECEIPT_COUNT_MAX,
			seq: BACKUP_RECEIPT_COUNT_MAX,
		})
		expect(await noteCleanLoad({ dir, logger, now: () => NOW + 1 })).toEqual([])
		expect(await receiptOf(own)).toMatchObject({
			ownFormatCleanLoads: BACKUP_RECEIPT_COUNT_MAX,
		})
		// The next backup's sequence is clamped, not one past the schema.
		const taken = await ensurePreMigrationBackup({
			dir,
			logger,
			now: () => NOW + 2,
			statfs: roomy,
		})
		expect(taken).toMatchObject({
			kind: "taken",
			fromFormat: formatLabel(other),
		})
		expect(
			await receiptOf(`pre-${formatLabel(other)}.${NOW + 2}`),
		).toMatchObject({ seq: BACKUP_RECEIPT_COUNT_MAX })
		expect(
			await noteCleanLoad({
				dir,
				logger,
				now: () => NOW + 2 + BACKUP_EXPIRY_MS,
			}),
		).toEqual([own])
	})

	it("ScannerPersistence.load counts one clean load per instance", async () => {
		// State that loads healthy: jobs and a recording, no journal lines to reject.
		await writeFile(join(dir, "jobs.json"), JOBS)
		await mkdir(join(dir, "recordings", "d_1"), { recursive: true })
		await writeFile(join(dir, "recordings", "d_1", "a.wav"), AUDIO)
		const make = () =>
			new ScannerPersistence({
				dir,
				logger,
				now: () => NOW,
				backup: { statfs: roomy },
			})
		const p = make()
		await p.load()
		expect(p.recoveryHealth()).toBe("healthy")
		await p.load()
		const receipt: unknown = JSON.parse(
			await readFile(
				join(dir, BACKUPS_DIR, `pre-unmarked.${NOW}`, BACKUP_RECEIPT_FILE),
				"utf8",
			),
		)
		expect(receipt).toMatchObject({ cleanLoads: 1 })
		await make().load()
		expect(
			JSON.parse(
				await readFile(
					join(dir, BACKUPS_DIR, `pre-unmarked.${NOW}`, BACKUP_RECEIPT_FILE),
					"utf8",
				),
			),
		).toMatchObject({ cleanLoads: 2 })
	})
})

describe("pre-migration backup: read-only copies", () => {
	it("the default fsync opens a copy read-only, so a read-only state file is still backed up", async () => {
		await seedState()
		await writeMarker({ fileVersion: 1, heldJournalFormat: 2, revision: 1 })
		// copyFile keeps the mode: the copy is read-only too, which an "r+" open refuses.
		await chmod(join(dir, "jobs.json"), 0o444)
		try {
			const result = await ensurePreMigrationBackup({
				dir,
				logger,
				now: () => NOW,
				statfs: roomy,
			})
			expect(result).toMatchObject({ kind: "taken" })
		} finally {
			await chmod(join(dir, "jobs.json"), 0o644)
		}
	})
})

describe("pre-migration backup: link fallbacks and durability", () => {
	const refuseLinks = () =>
		Promise.reject(Object.assign(new Error("not permitted"), { code: "EPERM" }))
	const space = (bytes: number) => (): Promise<StatFsLike> =>
		Promise.resolve({ bavail: bytes, bsize: 1 })

	it("a link fallback copy counts against the margin: skipped one byte short, taken at exactly the margin", async () => {
		const old = { fileVersion: 1, heldJournalFormat: 2, revision: 1 }
		await seedState()
		await writeMarker(old)
		const copied =
			Buffer.byteLength(JOBS) +
			Buffer.byteLength(JOURNAL) +
			Buffer.byteLength(JSON.stringify(old))
		const audio = Buffer.byteLength(AUDIO)
		const short = await ensurePreMigrationBackup({
			dir,
			logger,
			now: () => NOW,
			statfs: space(copied + audio + BACKUP_MIN_FREE_BYTES - 1),
			link: refuseLinks,
		})
		// The needed bytes include the fallback copy that tripped the check (never reserved).
		expect(short).toMatchObject({
			kind: "skipped",
			reason: "low-disk",
			neededBytes: copied + audio,
			freeBytes: copied + audio + BACKUP_MIN_FREE_BYTES - 1,
		})
		expect(await backups()).toEqual([])
		await writeMarker(old)
		const exact = await ensurePreMigrationBackup({
			dir,
			logger,
			now: () => NOW,
			statfs: space(copied + audio + BACKUP_MIN_FREE_BYTES),
			link: refuseLinks,
		})
		expect(exact).toMatchObject({
			kind: "taken",
			linkedFiles: 0,
			copiedBytes: copied + audio,
		})
		// Links that work cost nothing: the same space takes the backup with one byte less.
		await writeMarker(old)
		const linked = await ensurePreMigrationBackup({
			dir,
			logger,
			now: () => NOW + 1,
			statfs: space(copied + BACKUP_MIN_FREE_BYTES),
		})
		expect(linked).toMatchObject({ kind: "taken", linkedFiles: 1 })
	})

	it("flushes every copied file and directory before the rename, and the backups directory after it", async () => {
		await seedState()
		const keeps = await mkdtemp(join(tmpdir(), "wk-state-keeps-"))
		try {
			const keepsFile = join(keeps, "recording-keeps.json")
			await writeFile(keepsFile, '{"version":1}\n')
			const synced: Array<{ path: string; kind: string; renamed: boolean }> = []
			const backupsDir = join(dir, BACKUPS_DIR)
			const out = await ensurePreMigrationBackup({
				dir,
				logger,
				now: () => NOW,
				statfs: roomy,
				keepsFile,
				fsync: async (path, kind) => {
					const names = await readdir(backupsDir)
					synced.push({
						path,
						kind,
						renamed: names.includes(`pre-unmarked.${NOW}`),
					})
				},
			})
			expect(out).toMatchObject({ kind: "taken" })
			const partial = join(backupsDir, `.pre-unmarked.partial-${NOW}`)
			const before = synced.filter(s => !s.renamed)
			const after = synced.filter(s => s.renamed)
			expect(before.filter(s => s.kind === "file").map(s => s.path)).toEqual(
				expect.arrayContaining([
					join(partial, "jobs.json"),
					join(partial, "journal", "observations-20260101.jsonl"),
					join(partial, BACKUP_OUTSIDE_DIR, "recording-keeps.json"),
					join(partial, BACKUP_RECEIPT_FILE),
				]),
			)
			// The hard-linked recording is not rewritten; its directory entry is flushed.
			expect(before.map(s => s.path)).not.toContain(
				join(partial, "recordings", "d_1", "a.wav"),
			)
			expect(before.filter(s => s.kind === "dir").map(s => s.path)).toEqual(
				expect.arrayContaining([
					partial,
					join(partial, "recordings"),
					join(partial, "recordings", "d_1"),
					join(partial, "journal"),
				]),
			)
			expect(after).toEqual([{ path: backupsDir, kind: "dir", renamed: true }])
		} finally {
			await rm(keeps, { recursive: true, force: true })
		}
	})

	it("a failed file flush fails the backup and leaves no partial one; a refused directory flush does not", async () => {
		await seedState()
		const failed = await ensurePreMigrationBackup({
			dir,
			logger,
			now: () => NOW,
			statfs: roomy,
			fsync: (_path, kind) =>
				kind === "file" ? Promise.reject(new Error("EIO")) : Promise.resolve(),
		})
		expect(failed).toMatchObject({ kind: "skipped", reason: "copy-failed" })
		expect(await backups()).toEqual([])
		await rm(join(dir, STATE_FORMAT_FILE))
		const dirRefused = await ensurePreMigrationBackup({
			dir,
			logger,
			now: () => NOW,
			statfs: roomy,
			fsync: (_path, kind) =>
				kind === "dir"
					? Promise.reject(new Error("EINVAL"))
					: Promise.resolve(),
		})
		expect(dirRefused).toMatchObject({ kind: "taken" })
	})

	it("the default flush works on the real file system", async () => {
		await seedState()
		const out = await ensurePreMigrationBackup({
			dir,
			logger,
			now: () => NOW,
			statfs: roomy,
		})
		expect(out).toMatchObject({ kind: "taken" })
	})
})
