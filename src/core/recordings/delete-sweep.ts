/**
 * WG10 req 1.9: the startup sweep of private delete directories left by an interrupted delete.
 *
 * Acts only on a directory that is provably ours: a name matching RECORDING_DELETE_PRIVATE_DIR,
 * a real directory with no symbolic link from the configured root down, owned by this process,
 * mode exactly 0700, in a parent not writable by group or other unless sticky. Inside one: only
 * `verified` (a regular file) is unlinked, a single entry named like a recording is hard-linked
 * back under its name (never replacing) and unlinked, an empty directory is removed; anything
 * else is left and counted. While the keep store is not
 * `ready` nothing is deleted or restored. Logs counts only, never a name or path. Never rejects.
 */
import { link, lstat, opendir, rmdir, unlink } from "node:fs/promises"
import { join } from "node:path"
import type { Logger } from "../../utils/logger.js"
import { safeErrorFields } from "../../decoders/safe-error-fields.js"
import {
	RECORDING_DELETE_PRIVATE_DIR,
	RECORDING_DELETE_SWEEP_MAX_DIRS,
	RECORDING_DELETE_VERIFIED_NAME,
} from "./contract.js"
import type {
	RecordingDeleteSweepResult,
	RecordingProtection,
} from "./contract.js"

/** Discovery folders listed under the scanner recordings directory (the inventory bound). */
export const DELETE_SWEEP_MAX_DISCOVERY_FOLDERS = 2000
/** Directory entries read per listed directory. */
export const DELETE_SWEEP_MAX_LIST_ENTRIES = 4096
/** Entries of a private directory that are considered; more is "unexpected content". */
export const DELETE_SWEEP_MAX_PRIVATE_ENTRIES = 4

const DISCOVERY_FOLDER = /^d_[0-9A-Za-z]+$/
const RECORDING_FILE = /^[A-Za-z0-9_.-]{1,200}\.wav$/

export interface SweepStat {
	isDirectory(): boolean
	isFile(): boolean
	isSymbolicLink(): boolean
	uid: number
	mode: number
	dev?: number
	ino?: number
}

export interface SweepFs {
	lstat(path: string): Promise<SweepStat>
	/** At most `limit` names. */
	readdir(path: string, limit: number): Promise<string[]>
	link(existing: string, created: string): Promise<void>
	unlink(path: string): Promise<void>
	rmdir(path: string): Promise<void>
}

export const nodeSweepFs: SweepFs = {
	lstat: path => lstat(path),
	async readdir(path, limit) {
		const dir = await opendir(path)
		const out: string[] = []
		try {
			for (let e = await dir.read(); e !== null; e = await dir.read()) {
				out.push(e.name)
				if (out.length >= limit) break
			}
		} finally {
			await dir.close().catch(() => undefined)
		}
		return out
	},
	link: (a, b) => link(a, b),
	unlink: p => unlink(p),
	rmdir: p => rmdir(p),
}

export interface RecordingDeleteSweepOptions {
	dsdFmeDirs: readonly string[]
	/** The directory holding the `<discovery>` folders; null when the scanner has none. */
	scannerRecordingsDir: string | null
	/** `state` (the keep service has it) is the readiness signal; without it a probe decides. */
	protection: RecordingProtection & {
		state?: () => "loading" | "ready" | "failed"
	}
	logger: Logger
	fs?: SweepFs
	getuid?: (() => number) | undefined
}

function storeReady(p: RecordingDeleteSweepOptions["protection"]): boolean {
	try {
		if (p.state && p.state() !== "ready") return false
		// A key nobody can have kept is protected only while the store state is unknown.
		return !p.isScannerFileProtected("d_sweepprobe", "wavekit-sweep-probe.wav")
	} catch {
		return false
	}
}

function same(a: SweepStat, b: SweepStat): boolean {
	return a.dev === b.dev && a.ino === b.ino
}

export async function sweepRecordingDeleteLeftovers(
	options: RecordingDeleteSweepOptions,
): Promise<RecordingDeleteSweepResult> {
	const result: RecordingDeleteSweepResult = {
		found: 0,
		deleted: 0,
		restored: 0,
		removedEmpty: 0,
		left: 0,
	}
	const log = options.logger.child({ component: "RecordingDeleteSweep" })
	let errors = 0
	try {
		const fs = options.fs ?? nodeSweepFs
		const getuid =
			options.getuid ??
			(typeof process.getuid === "function"
				? process.getuid.bind(process)
				: undefined)
		const uid = getuid ? safeUid(getuid) : null
		if (uid === null) {
			log.info(result, "Recording delete leftovers not swept")
			return result
		}
		const ready = storeReady(options.protection)

		/**
		 * The last level's stat when every level from the root to `dir` is a real directory (root
		 * included); null otherwise.
		 */
		const intactStat = async (
			root: string,
			parts: string[],
		): Promise<SweepStat | null> => {
			let cur = root
			let st: SweepStat | null = null
			for (let i = 0; i <= parts.length; i++) {
				if (i > 0) cur = join(cur, parts[i - 1] ?? "")
				st = await fs.lstat(cur)
				if (st.isSymbolicLink() || !st.isDirectory()) return null
			}
			return st
		}
		const intact = async (root: string, parts: string[]): Promise<boolean> =>
			(await intactStat(root, parts)) !== null
		/** Directories already listed (by identity): `WAV` and `wav` on a case-insensitive disk are one. */
		const listed = new Set<string>()

		const act = async (parent: string, name: string): Promise<void> => {
			const dir = join(parent, name)
			const st = await fs.lstat(dir)
			if (
				st.isSymbolicLink() ||
				!st.isDirectory() ||
				st.uid !== uid ||
				(st.mode & 0o7777) !== 0o700 ||
				!ready
			) {
				result.left += 1
				return
			}
			// Another uid able to write the parent (group or other write without the sticky bit)
			// could rebind the private directory's name: touch nothing (as verified-unlink does).
			const ps = await fs.lstat(parent)
			if ((ps.mode & 0o022) !== 0 && (ps.mode & 0o1000) === 0) {
				result.left += 1
				return
			}
			const entries = await fs.readdir(
				dir,
				DELETE_SWEEP_MAX_PRIVATE_ENTRIES + 1,
			)
			// The directory must still be the one that was checked.
			const again = await fs.lstat(dir)
			if (
				!same(st, again) ||
				again.uid !== uid ||
				again.isSymbolicLink() ||
				!again.isDirectory() ||
				(again.mode & 0o7777) !== 0o700
			) {
				result.left += 1
				return
			}
			if (entries.length === 0) {
				await fs.rmdir(dir)
				result.removedEmpty += 1
				return
			}
			const only = entries.length === 1 ? entries[0] : undefined
			if (only === undefined) {
				result.left += 1
				return
			}
			const entry = join(dir, only)
			const es = await fs.lstat(entry)
			if (es.isSymbolicLink() || !es.isFile()) {
				result.left += 1
				return
			}
			if (only === RECORDING_DELETE_VERIFIED_NAME) {
				await fs.unlink(entry)
				result.deleted += 1
				await fs.rmdir(dir).catch(() => undefined)
				return
			}
			if (!RECORDING_FILE.test(only)) {
				result.left += 1
				return
			}
			try {
				await fs.link(entry, join(parent, only))
			} catch (err) {
				if ((err as NodeJS.ErrnoException | null)?.code === "EEXIST") {
					result.left += 1
					return
				}
				throw err
			}
			await fs.unlink(entry)
			result.restored += 1
			await fs.rmdir(dir).catch(() => undefined)
		}

		const queue: Array<{ parent: string; name: string }> = []
		const list = async (root: string, parts: string[]): Promise<void> => {
			let parent = root
			for (const p of parts) parent = join(parent, p)
			let names: string[]
			try {
				const st = await intactStat(root, parts)
				if (st === null) return
				if (st.dev !== undefined && st.ino !== undefined) {
					const key = `${st.dev}:${st.ino}`
					if (listed.has(key)) return
					listed.add(key)
				}
				names = await fs.readdir(parent, DELETE_SWEEP_MAX_LIST_ENTRIES)
			} catch (err) {
				// A missing folder (no WAV subfolder yet) is normal, not an error.
				if ((err as NodeJS.ErrnoException | null)?.code !== "ENOENT") {
					errors += 1
					log.debug(
						safeErrorFields(err),
						"Listing a recording directory failed",
					)
				}
				return
			}
			for (const n of names)
				if (RECORDING_DELETE_PRIVATE_DIR.test(n)) {
					result.found += 1
					if (queue.length < RECORDING_DELETE_SWEEP_MAX_DIRS)
						queue.push({ parent, name: n })
					else result.left += 1
				}
		}

		for (const d of options.dsdFmeDirs) {
			await list(d, [])
			// dsd-fme writes `WAV`; a lowercase `wav` folder is swept too (Main, rk2 review minor 4).
			await list(d, ["WAV"])
			await list(d, ["wav"])
		}
		if (options.scannerRecordingsDir !== null) {
			const root = options.scannerRecordingsDir
			await list(root, [])
			let folders: string[] = []
			try {
				if (await intact(root, []))
					folders = (
						await fs.readdir(root, DELETE_SWEEP_MAX_LIST_ENTRIES)
					).filter(n => DISCOVERY_FOLDER.test(n))
			} catch (err) {
				errors += 1
				log.debug(safeErrorFields(err), "Listing a recording directory failed")
			}
			for (const f of folders.slice(0, DELETE_SWEEP_MAX_DISCOVERY_FOLDERS))
				await list(root, [f])
		}

		// The chain was checked when each parent was listed; act re-checks the directory itself.
		for (const q of queue) {
			try {
				await act(q.parent, q.name)
			} catch (err) {
				errors += 1
				result.left += 1
				log.debug(safeErrorFields(err), "Sweeping a delete leftover failed")
			}
		}
	} catch (err) {
		errors += 1
		log.warn(safeErrorFields(err), "Recording delete sweep failed")
	}
	log.info({ ...result, errors }, "Recording delete leftovers swept")
	return result
}

function safeUid(getuid: () => number): number | null {
	try {
		const u = getuid()
		return Number.isInteger(u) && u >= 0 ? u : null
	} catch {
		return null
	}
}
