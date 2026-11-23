/**
 * Noise quarantine: a reversible discard for analog files the recording admission measured as
 * noise (`discarded:noise`, recording-verdict.ts). Instead of deleting the file's audio, the
 * analog operation (analog-operations.ts, AnalogHandle.cancel with `noise`) moves it here:
 * `<scanner storage>/quarantine/noise/<YYYY-MM-DD>/<operationId>.wav` plus a small JSON sidecar
 * `<operationId>.json` (core-made ids, measured numbers and closed codes only). The admission
 * thresholds are provisional; this keeps the evidence to calibrate them for a while.
 *
 * Outside `recordings/`, so no recordings list, serve, link, keep, retention or delete-sweep
 * walker sees it (they all walk `recordings/` or `.analog-operations/` only). Not counted in the
 * recordings cap: bounded here instead, by age AND total size AND file count.
 *
 * Bounds (arithmetic): 8 kHz 16-bit mono is 16 000 B/s, so NOISE_QUARANTINE_MAX_BYTES (500 MiB =
 * 524 288 000 B) holds 524 288 000 / 16 000 ≈ 32 768 s ≈ 9.1 h of audio, about 6 500 five-second
 * files (80 044 B each). Over 6 days a corpus had about 2 200 noise files ≈ 3 h ≈ 165 MiB, so the
 * size bound holds more than 2 weeks at that rate and NOISE_QUARANTINE_MAX_AGE_MS (7 days) bites
 * first. A measured file is at least 94 frames (about 3 s: 44 + 48 000 = 48 044 B), so 500 MiB holds
 * at most 524 288 000 / 48 044 ≈ 10 912 files: the NOISE_QUARANTINE_MAX_FILES (20 000) count bound
 * never applies before the size bound on such files; it caps one prune's work (at most twice that
 * many folder entries are examined, and one purge reads at most twice that many sidecars) and
 * guards against a flood of small foreign files.
 *
 * Pruning runs after every quarantine write (in the background, never awaited by the move) and
 * at startup: files older than the age bound go first, then the oldest until the total and count
 * are within their bounds. Every day folder is visited, oldest first (so expiry reaches folders a
 * stepped clock left far behind), until the listing cap. Orphans in a day folder (a sidecar with
 * no WAV, or any entry that is neither a quarantined WAV nor its sidecar) are removed once older
 * than ORPHAN_GRACE_MS, so an admit between its move and its sidecar is never raced. One prune
 * runs at a time; a request meanwhile reruns once after it. A discovery's removal purges its
 * quarantined files (purgeDiscovery, read from the sidecars) in the background: purges are
 * batched like prunes (one sidecar scan at a time matches every discovery asked so far; ids asked
 * meanwhile rerun it once), so a bulk removal costs one or two scans, not one per discovery. The
 * store's analog stop waits for a running purge at most PURGE_STOP_WAIT_MS; files a stopped purge
 * leaves are removed by the age bound.
 * Every error is logged (safeErrorFields, fixed text) and never fatal. A move that finds its day
 * folder gone (ENOENT: a prune removed it around midnight) recreates it and retries once; a
 * failed move leaves the caller to delete the file (today's behaviour).
 */
import { constants as fsConstants } from "node:fs"
import {
	copyFile,
	lstat,
	mkdir,
	open,
	readdir,
	readFile,
	rename,
	rmdir,
	unlink,
	writeFile,
} from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import { safeErrorFields } from "../../../decoders/safe-error-fields.js"
import { WaveKitError } from "../../../utils/errors.js"
import { createComponentLogger, type Logger } from "../../../utils/logger.js"
import { WAV_HEADER_BYTES, wavHeader } from "../channel/wav-writer.js"

/** Feature flag (Main seam, no config): false deletes noise files as before. */
export const NOISE_QUARANTINE = true
/** The top-level quarantine folder under the scanner storage root (never in state backups). */
export const QUARANTINE_ROOT_DIR = "quarantine"
/** Under the scanner storage root. */
export const NOISE_QUARANTINE_DIR = join(QUARANTINE_ROOT_DIR, "noise")
/** A file older than this (now − mtime > 7 d) is pruned; exactly 7 d is kept. */
export const NOISE_QUARANTINE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
/** Total bytes (WAV + sidecar) kept: exactly this is kept, one byte over prunes the oldest. */
export const NOISE_QUARANTINE_MAX_BYTES = 500 * 1024 * 1024
/** Files kept (and listed per prune); see the module comment. */
export const NOISE_QUARANTINE_MAX_FILES = 20_000
/** An orphan (a sidecar without its WAV, a foreign entry) younger than this is left alone. */
export const ORPHAN_GRACE_MS = 60 * 60 * 1000
/** A sidecar larger than this is not read (ours are a few hundred bytes). */
const MAX_SIDECAR_BYTES = 4096
/** The longest the store's analog stop waits for a running purge (shutdown is never held longer). */
export const PURGE_STOP_WAIT_MS = 2000
const SAMPLE_RATE_HZ = 8000
const DAY = /^\d{4}-\d{2}-\d{2}$/
const OPERATION_ID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const WAV_NAME =
	/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.wav$/
const JSON_NAME =
	/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/
const DISCOVERY_ID = /^d_[0-9A-Za-z]{1,64}$/
const CODE = z
	.string()
	.regex(/^[a-z0-9:-]{1,64}$/)
	.nullable()
const finite = z.number().finite()

/**
 * The measured admission features and closed codes of one noise file (no untrusted strings).
 * `branch` (speech-content.ts admissionBranch: `noise` or `data-buzz`) and the data-buzz features
 * are optional: sidecars written before them carry none.
 */
export const NoiseQuarantineFactsSchema = z
	.object({
		frequencyHz: finite.nullable(),
		reason: CODE,
		strength: CODE,
		branch: z.enum(["noise", "data-buzz"]).optional(),
		levelFrames: finite,
		spreadDb: finite,
		p10Dbfs: finite,
		periodicShare: finite,
		burstFrames: finite,
		loudPitchShare: finite.optional(),
		topSpreadDb: finite.optional(),
		loudLevelDbfs: finite.nullable().optional(),
	})
	.strict()
export type NoiseQuarantineFacts = z.infer<typeof NoiseQuarantineFactsSchema>

export const NoiseQuarantineSidecarSchema = z
	.object({
		version: z.literal(1),
		verdict: z.literal("discarded:noise"),
		operationId: z.string().regex(OPERATION_ID),
		discoveryId: z.string().regex(DISCOVERY_ID),
		observationId: z
			.string()
			.regex(/^[0-9A-Za-z_-]{1,128}$/)
			.nullable(),
		quarantinedAt: z.string().datetime(),
		sampleRateHz: z.literal(SAMPLE_RATE_HZ),
		fileBytes: z.number().int().nonnegative(),
		facts: NoiseQuarantineFactsSchema,
	})
	.strict()
export type NoiseQuarantineSidecar = z.infer<
	typeof NoiseQuarantineSidecarSchema
>

export interface NoiseQuarantineIds {
	readonly operationId: string
	readonly discoveryId: string
	readonly observationId: string | null
}

/** The file system calls quarantine uses (a test seam). */
export interface NoiseQuarantineFs {
	rename(from: string, to: string): Promise<void>
	copyFile(from: string, to: string): Promise<void>
	unlink(path: string): Promise<void>
	mkdir(path: string): Promise<void>
	rmdir(path: string): Promise<void>
	readdir(path: string): Promise<string[]>
	lstat(path: string): Promise<{
		isFile(): boolean
		isDirectory(): boolean
		size: number
		mtimeMs: number
	}>
	/** Rewrites the 44-byte WAV header at offset 0 and syncs the file. */
	writeHeader(path: string, header: Buffer): Promise<void>
	writeFile(path: string, data: Buffer): Promise<void>
	readFile(path: string): Promise<Buffer>
}

export const nodeNoiseQuarantineFs: NoiseQuarantineFs = {
	rename,
	copyFile: (from, to) => copyFile(from, to, fsConstants.COPYFILE_EXCL),
	unlink,
	mkdir: async path => {
		await mkdir(path, { recursive: true })
	},
	rmdir,
	readdir: path => readdir(path),
	lstat,
	writeHeader: async (path, header) => {
		const handle = await open(
			path,
			fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
		)
		try {
			await handle.write(header, 0, header.length, 0)
			await handle.sync()
		} finally {
			await handle.close()
		}
	},
	writeFile: (path, data) => writeFile(path, data, { flag: "wx" }),
	readFile: path => readFile(path),
}

export interface NoiseQuarantineOptions {
	/** The scanner storage root (the quarantine lives in NOISE_QUARANTINE_DIR under it). */
	readonly root: string
	readonly logger: Logger
	readonly now: () => number
	readonly fs?: NoiseQuarantineFs
	readonly maxAgeMs?: number
	readonly maxBytes?: number
	readonly maxFiles?: number
}

interface Entry {
	readonly day: string
	readonly id: string
	readonly mtimeMs: number
	readonly bytes: number
}

function codeOf(err: unknown): unknown {
	return err instanceof Error && "code" in err ? err.code : null
}

export class NoiseQuarantine {
	readonly dir: string
	private readonly fs: NoiseQuarantineFs
	private readonly log: Logger
	private readonly maxAgeMs: number
	private readonly maxBytes: number
	private readonly maxFiles: number
	private pruning: Promise<void> | null = null
	private rerun = false
	private purging: Promise<void> | null = null
	private readonly pendingPurge = new Set<string>()

	constructor(private readonly opts: NoiseQuarantineOptions) {
		this.dir = join(opts.root, NOISE_QUARANTINE_DIR)
		this.fs = opts.fs ?? nodeNoiseQuarantineFs
		this.log = createComponentLogger(opts.logger, "NoiseQuarantine")
		this.maxAgeMs = opts.maxAgeMs ?? NOISE_QUARANTINE_MAX_AGE_MS
		this.maxBytes = opts.maxBytes ?? NOISE_QUARANTINE_MAX_BYTES
		this.maxFiles = opts.maxFiles ?? NOISE_QUARANTINE_MAX_FILES
	}

	/**
	 * Moves the WAV at `source` (written PCM, header not finalized) into today's folder, writes
	 * its final header and its sidecar, and schedules a prune. True when the WAV is in the
	 * quarantine (`source` is gone); false when it is not (`source` may remain: the caller deletes
	 * it). Never throws.
	 */
	async admit(
		source: string,
		ids: NoiseQuarantineIds,
		facts: NoiseQuarantineFacts,
	): Promise<boolean> {
		let moved: string | null = null
		try {
			const now = this.opts.now()
			const day = new Date(now).toISOString().slice(0, 10)
			const sidecar = NoiseQuarantineSidecarSchema.parse({
				version: 1,
				verdict: "discarded:noise",
				operationId: ids.operationId,
				discoveryId: ids.discoveryId,
				observationId: ids.observationId,
				quarantinedAt: new Date(now).toISOString(),
				sampleRateHz: SAMPLE_RATE_HZ,
				fileBytes: 0,
				facts,
			})
			const info = await this.fs.lstat(source)
			const dataBytes = info.size - WAV_HEADER_BYTES
			if (!info.isFile() || dataBytes < 0 || dataBytes % 2 !== 0)
				throw new WaveKitError("Not a PCM WAV part", "SCANNER_NOISE_QUARANTINE")
			const folder = join(this.dir, day)
			await this.fs.mkdir(folder)
			const target = join(folder, `${ids.operationId}.wav`)
			try {
				await this.fs.lstat(target)
				throw new WaveKitError(
					"Quarantine target exists",
					"SCANNER_NOISE_QUARANTINE",
				)
			} catch (cause) {
				if (codeOf(cause) !== "ENOENT") throw cause
			}
			const move = async (): Promise<void> => {
				try {
					await this.fs.rename(source, target)
					moved = target
				} catch (cause) {
					if (codeOf(cause) !== "EXDEV") throw cause
					// Another device: copy (exclusive create), then remove the source.
					await this.fs.copyFile(source, target)
					moved = target
					await this.fs.unlink(source)
				}
			}
			try {
				await move()
			} catch (cause) {
				if (codeOf(cause) !== "ENOENT" || moved !== null) throw cause
				// Around midnight a prune may remove this (then empty, already past) day folder
				// between the mkdir and the move: recreate it and retry the move once.
				await this.fs.mkdir(folder)
				await move()
			}
			await this.fs.writeHeader(target, wavHeader(SAMPLE_RATE_HZ, dataBytes))
			const body = Buffer.from(
				JSON.stringify({ ...sidecar, fileBytes: info.size }),
			)
			await this.fs.writeFile(join(folder, `${ids.operationId}.json`), body)
			this.schedulePrune()
			return true
		} catch (err) {
			this.log.warn(
				safeErrorFields(err),
				"Noise quarantine failed; the file is deleted instead",
			)
			// A partly moved file is removed, so nothing half made stays (the source goes too).
			if (moved !== null)
				await this.fs.unlink(moved).catch((cause: unknown) => {
					this.log.warn(
						safeErrorFields(cause),
						"Removing a partly quarantined file failed",
					)
				})
			return false
		}
	}

	/** Starts a prune in the background (never awaited by a writer); errors are logged. */
	schedulePrune(): void {
		void this.prune()
	}

	/** Prunes to the bounds; resolves when the prune (and one rerun asked meanwhile) is done. */
	prune(): Promise<void> {
		if (this.pruning) {
			this.rerun = true
			return this.pruning
		}
		const run = async (): Promise<void> => {
			try {
				for (;;) {
					this.rerun = false
					try {
						await this.pruneOnce()
					} catch (err) {
						this.log.warn(safeErrorFields(err), "Noise quarantine prune failed")
					}
					// Checked and cleared in one synchronous step: a request after this starts a new
					// prune instead of joining one that is already settling.
					if (!this.rerun) {
						this.pruning = null
						return
					}
				}
			} catch {
				// Anything else that throws (a failing logger): the prune ends and the next one runs.
				this.pruning = null
			}
		}
		this.pruning = run()
		return this.pruning
	}

	private async list(path: string): Promise<string[]> {
		try {
			return await this.fs.readdir(path)
		} catch (cause) {
			if (codeOf(cause) === "ENOENT") return []
			throw cause
		}
	}

	/** The valid day folder names, oldest first. */
	private async days(): Promise<string[]> {
		return (await this.list(this.dir)).filter(name => DAY.test(name)).sort()
	}

	private async pruneOnce(): Promise<void> {
		const now = this.opts.now()
		const days = await this.days()
		const visited: string[] = []
		const entries: Entry[] = []
		// Folder entries examined per prune (each costs at most two lstat calls: a WAV and its
		// sidecar), so a flooded folder stays bounded.
		const budget = this.maxFiles * 2
		let scanned = 0
		let orphans = 0
		let exhausted = false
		for (const day of days) {
			// The budget spent: no further day folder is listed.
			if (scanned >= budget) {
				exhausted = true
				break
			}
			visited.push(day)
			const folder = join(this.dir, day)
			const names = await this.list(folder)
			const wavs = new Set<string>()
			for (const name of names) {
				const match = WAV_NAME.exec(name)
				if (match) wavs.add(match[1]!)
			}
			for (const name of names) {
				if (scanned >= budget) {
					exhausted = true
					break
				}
				scanned++
				const path = join(folder, name)
				const wav = WAV_NAME.exec(name)
				const side = JSON_NAME.exec(name)
				// A sidecar beside its WAV is counted with the WAV below.
				if (side && wavs.has(side[1]!)) continue
				try {
					const info = await this.fs.lstat(path)
					if (wav && info.isFile()) {
						let bytes = info.size
						try {
							const sidecar = await this.fs.lstat(
								join(folder, `${wav[1]!}.json`),
							)
							if (sidecar.isFile()) bytes += sidecar.size
						} catch {
							/* no sidecar: the WAV alone counts */
						}
						entries.push({ day, id: wav[1]!, mtimeMs: info.mtimeMs, bytes })
						continue
					}
					// An orphan: a sidecar without its WAV, a foreign file or symlink. A folder is
					// left alone (nothing here makes one; never removed recursively).
					if (info.isDirectory()) continue
					if (now - info.mtimeMs <= ORPHAN_GRACE_MS) continue
					await this.fs.unlink(path)
					orphans++
				} catch (err) {
					if (codeOf(err) !== "ENOENT")
						this.log.debug(safeErrorFields(err), "Quarantined entry unreadable")
				}
			}
		}
		if (exhausted)
			this.log.warn(
				{ scanned, budget, days: days.length, visited: visited.length },
				"Noise quarantine prune stopped at its entry budget",
			)
		entries.sort((a, b) => a.mtimeMs - b.mtimeMs || (a.id < b.id ? -1 : 1))
		let total = entries.reduce((sum, e) => sum + e.bytes, 0)
		let count = entries.length
		let pruned = 0
		for (const e of entries) {
			const expired = now - e.mtimeMs > this.maxAgeMs
			if (!expired && total <= this.maxBytes && count <= this.maxFiles) break
			// A file that could not be removed still occupies its space: the bounds keep it.
			if (!(await this.remove(e))) continue
			pruned++
			total -= e.bytes
			count--
		}
		// Empty past day folders go; today's stays (an admit may be between its mkdir and move).
		const today = new Date(now).toISOString().slice(0, 10)
		for (const day of visited.filter(d => d !== today))
			await this.fs.rmdir(join(this.dir, day)).catch(() => undefined)
		if (pruned > 0 || orphans > 0)
			this.log.info(
				{ pruned, orphans, files: count },
				"Noise quarantine pruned",
			)
	}

	private async remove(e: Entry): Promise<boolean> {
		const folder = join(this.dir, e.day)
		try {
			await this.fs.unlink(join(folder, `${e.id}.wav`))
		} catch (err) {
			if (codeOf(err) !== "ENOENT") {
				this.log.warn(
					safeErrorFields(err),
					"Removing a quarantined file failed",
				)
				return false
			}
		}
		await this.fs.unlink(join(folder, `${e.id}.json`)).catch(() => undefined)
		return true
	}

	/**
	 * Removes every quarantined file of a removed discovery: reads each sidecar (at most twice
	 * the file bound) and deletes the matching WAV, then its sidecar (a crash in between leaves an
	 * orphan sidecar, which the prune removes). One scan runs at a time and matches every id
	 * queued when it starts; ids queued meanwhile rerun it once. Never throws; errors are logged.
	 * Runs in the background of the removal; resolves when a scan covering this id is done
	 * (track every purge with `settled`).
	 */
	purgeDiscovery(discoveryId: string): Promise<void> {
		if (!DISCOVERY_ID.test(discoveryId))
			return this.purging ?? Promise.resolve()
		this.pendingPurge.add(discoveryId)
		if (this.purging) return this.purging
		const run = async (): Promise<void> => {
			try {
				for (;;) {
					// Checked and cleared in one synchronous step: an id queued after this starts a new
					// scan (and gets its promise) instead of joining one that is already settling.
					if (this.pendingPurge.size === 0) {
						this.purging = null
						return
					}
					const ids = new Set(this.pendingPurge)
					this.pendingPurge.clear()
					try {
						await this.purgeOnce(ids)
					} catch (err) {
						this.log.warn(safeErrorFields(err), "Noise quarantine purge failed")
					}
				}
			} catch {
				// Anything else that throws (a failing logger): the scan ends, so `settled` resolves and
				// the next purge runs (ids still queued go with it).
				this.purging = null
			}
		}
		this.purging = run()
		return this.purging
	}

	/** Resolves when every purge asked so far is done (tests, shutdown). */
	async settled(): Promise<void> {
		while (this.purging) await this.purging
	}

	/**
	 * Waits for `settled` at most `ms` (the store's analog stop); true when every purge is done.
	 * A purge still running carries on in the background.
	 */
	async settledWithin(ms: number = PURGE_STOP_WAIT_MS): Promise<boolean> {
		let timer: NodeJS.Timeout | undefined
		const timeout = new Promise<false>(resolve => {
			timer = setTimeout(() => resolve(false), ms)
			timer.unref()
		})
		try {
			return await Promise.race([this.settled().then(() => true), timeout])
		} finally {
			clearTimeout(timer)
		}
	}

	private async purgeOnce(discoveryIds: ReadonlySet<string>): Promise<void> {
		const budget = this.maxFiles * 2
		let read = 0
		let purged = 0
		let exhausted = false
		for (const day of await this.days()) {
			// The budget spent: no further day folder is listed.
			if (read >= budget) {
				exhausted = true
				break
			}
			const folder = join(this.dir, day)
			for (const name of await this.list(folder)) {
				const side = JSON_NAME.exec(name)
				if (!side) continue
				if (read >= budget) {
					exhausted = true
					break
				}
				read++
				const path = join(folder, name)
				try {
					const info = await this.fs.lstat(path)
					if (!info.isFile() || info.size > MAX_SIDECAR_BYTES) continue
					const parsed = NoiseQuarantineSidecarSchema.safeParse(
						JSON.parse((await this.fs.readFile(path)).toString("utf8")),
					)
					if (!parsed.success || !discoveryIds.has(parsed.data.discoveryId))
						continue
					await this.fs
						.unlink(join(folder, `${side[1]!}.wav`))
						.catch((err: unknown) => {
							if (codeOf(err) !== "ENOENT") throw err
						})
					await this.fs.unlink(path).catch((err: unknown) => {
						if (codeOf(err) !== "ENOENT") throw err
					})
					purged++
				} catch (err) {
					if (codeOf(err) !== "ENOENT")
						this.log.warn(
							safeErrorFields(err),
							"Purging a quarantined file failed",
						)
				}
			}
		}
		if (exhausted)
			this.log.warn(
				{ read, budget, discoveries: discoveryIds.size },
				"Noise quarantine purge stopped at its sidecar budget",
			)
		if (purged > 0)
			this.log.info(
				{ purged, discoveries: discoveryIds.size },
				"Noise quarantine purged removed discoveries",
			)
	}
}
