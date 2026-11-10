import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
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
	BACKUP_MIN_FREE_BYTES,
	BACKUP_RECEIPT_FILE,
	BACKUPS_DIR,
	CURRENT_SCANNER_STATE_FORMAT,
	ensurePreMigrationBackup,
	formatLabel,
	STATE_FORMAT_FILE,
} from "../../../src/core/state-backup.js"
import type { StatFsLike } from "../../../src/core/state-backup.js"
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
			path: join(BACKUPS_DIR, "pre-unmarked"),
			files: 3,
			copiedBytes: copied,
			linkedFiles: 1,
			replaced: 0,
		})
		const root = join(dir, BACKUPS_DIR, "pre-unmarked")
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
		expect(await backups()).toEqual(["pre-unmarked"])
	})

	it("a version change backs up under the old format, and a second change replaces that single backup", async () => {
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
		expect(await backups()).toEqual(["pre-f1-h2-r1"])
		// The backup never contains the backups directory itself.
		expect(await readdir(join(dir, BACKUPS_DIR, "pre-f1-h2-r1"))).not.toContain(
			BACKUPS_DIR,
		)

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
			replaced: 1,
		})
		expect(await backups()).toEqual([`pre-${CURRENT}`])
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
		expect(out2).toMatchObject({
			kind: "taken",
			fromFormat: "unknown",
			replaced: 1,
		})
		expect(await backups()).toEqual(["pre-unknown"])
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
		const root = join(dir, BACKUPS_DIR, "pre-unmarked", "captures")
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
			"pre-unmarked",
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
})
