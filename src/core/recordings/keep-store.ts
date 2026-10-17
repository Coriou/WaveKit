/**
 * WG9 lane RK: the recording keep store `<stateDir>/recording-keeps.json` (docs/specs/web-gaps-9,
 * requirements 2.3 and 2.4, design "Recording Keep and deletion", Store).
 *
 * Writes mirror src/decoders/settings/store.ts (one serialised chain that a failed write does not
 * poison; exclusive tmp create + fsync + rename + best-effort directory fsync; memory replaced only
 * after the rename; stale temporary files swept with the station bounds). Loading differs on
 * purpose: a file that cannot be read, parsed or validated, or that passes a bound, is left in
 * place (never moved aside nor rewritten) and the store is `failed` for the process lifetime, so
 * the coordinator answers "protected" for every recording (a quarantine would load empty and
 * unprotect every kept file). Logs carry fixed text, a reason and allowlisted error fields only.
 */
import { constants as fsConstants } from "node:fs"
import * as nodeFs from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import {
	RECORDING_KEEPS_FILE_MAX_BYTES,
	RECORDING_KEEPS_FILE_NAME,
	RECORDING_KEEPS_MAX_BYTES,
	RECORDING_KEEPS_MAX_ENTRIES,
} from "@wavekit/api-types"
import { safeErrorFields } from "../../decoders/safe-error-fields.js"
import { WaveKitError } from "../../utils/errors.js"
import type { Logger } from "../../utils/logger.js"
import {
	RECORDING_KEEPS_SCHEMA_VERSION,
	RECORDING_KEEP_KEY,
	RecordingKeepError,
} from "./contract.js"
import type {
	RecordingKeepEntry,
	RecordingKeepKey,
	RecordingKeepsFile,
} from "./contract.js"

/** Leftover temporary files removed per open (station bound). */
export const RECORDING_KEEPS_TMP_SWEEP_MAX = 16
/** A temporary file younger than this may belong to a live writer and is kept (station bound). */
export const RECORDING_KEEPS_TMP_STALE_MS = 60_000

const TMP_PATTERN = /^recording-keeps\.json\.(\d+)\.tmp$/
export const RECORDING_KEEPS_UNAVAILABLE_TEXT =
	"Recording keep store is unavailable"
export const RECORDING_KEEPS_LIMIT_TEXT =
	"Keeping this recording would pass the keep limits"

/** The fs/promises subset the store uses (injectable for tests). */
export interface RecordingKeepsFs {
	open: typeof nodeFs.open
	rename: typeof nodeFs.rename
	unlink: typeof nodeFs.unlink
	readdir: (path: string) => Promise<string[]>
	lstat: typeof nodeFs.lstat
	mkdir: typeof nodeFs.mkdir
}

export const nodeRecordingKeepsFs: RecordingKeepsFs = {
	open: nodeFs.open,
	rename: nodeFs.rename,
	unlink: nodeFs.unlink,
	readdir: (path: string) => nodeFs.readdir(path),
	lstat: nodeFs.lstat,
	mkdir: nodeFs.mkdir,
}

export type RecordingKeepStoreState = "ready" | "failed"

/** Why a load failed (logged; never a path or content). */
export type RecordingKeepsLoadFailure =
	| "unreadable"
	| "not-regular"
	| "oversized"
	| "invalid"

export interface RecordingKeepStore {
	state(): RecordingKeepStoreState
	/** Current committed file (frozen); empty with revision 0 when failed. */
	snapshot(): RecordingKeepsFile
	/**
	 * Serialised; memory replaced only after the rename. Failed store, closed store or IO
	 * failure → RECORDING_KEEPS_UNAVAILABLE (memory unchanged); a file the loader would refuse →
	 * RECORDING_KEEP_LIMIT. A failed write does not poison later writes.
	 */
	write(next: RecordingKeepsFile): Promise<void>
	close(): Promise<void>
}

export interface RecordingKeepStoreOptions {
	stateDir: string
	/** Already the component logger of the caller. */
	log: Logger
	fs?: RecordingKeepsFs
}

const EntrySchema = z
	.object({
		key: z
			.string()
			.max(RECORDING_KEEPS_FILE_MAX_BYTES)
			.regex(RECORDING_KEEP_KEY),
		keptAt: z.string().datetime({ offset: true }),
		bytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
	})
	.strict()

const FileSchema = z
	.object({
		schemaVersion: z.literal(RECORDING_KEEPS_SCHEMA_VERSION),
		revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
		keeps: z.array(EntrySchema).max(RECORDING_KEEPS_MAX_ENTRIES),
	})
	.strict()

/** True when the entries are within the entry and kept-byte bounds and keys are unique. */
export function withinKeepBounds(
	keeps: readonly RecordingKeepEntry[],
): boolean {
	if (keeps.length > RECORDING_KEEPS_MAX_ENTRIES) return false
	const seen = new Set<string>()
	let bytes = 0
	for (const entry of keeps) {
		if (seen.has(entry.key)) return false
		seen.add(entry.key)
		bytes += entry.bytes
		if (bytes > RECORDING_KEEPS_MAX_BYTES) return false
	}
	return true
}

function freeze(file: RecordingKeepsFile): RecordingKeepsFile {
	for (const entry of file.keeps) Object.freeze(entry)
	Object.freeze(file.keeps)
	return Object.freeze(file)
}

export function emptyRecordingKeepsFile(): RecordingKeepsFile {
	return freeze({
		schemaVersion: RECORDING_KEEPS_SCHEMA_VERSION,
		revision: 0,
		keeps: [],
	})
}

/**
 * Pure parse of the file text: the byte length first, then JSON, Zod strict, unique keys and the
 * bounds. Any fault anywhere → null (no partial trust).
 */
export function parseRecordingKeepsFile(
	text: string,
): RecordingKeepsFile | null {
	if (Buffer.byteLength(text, "utf8") > RECORDING_KEEPS_FILE_MAX_BYTES)
		return null
	let raw: unknown
	try {
		raw = JSON.parse(text)
	} catch {
		return null
	}
	const parsed = FileSchema.safeParse(raw)
	if (!parsed.success) return null
	const keeps: RecordingKeepEntry[] = parsed.data.keeps.map(entry => ({
		key: entry.key as RecordingKeepKey,
		keptAt: entry.keptAt,
		bytes: entry.bytes,
	}))
	if (!withinKeepBounds(keeps)) return null
	return freeze({
		schemaVersion: RECORDING_KEEPS_SCHEMA_VERSION,
		revision: parsed.data.revision,
		keeps,
	})
}

export function serializeRecordingKeepsFile(file: RecordingKeepsFile): string {
	return `${JSON.stringify(
		{
			schemaVersion: file.schemaVersion,
			revision: file.revision,
			keeps: file.keeps.map(e => ({
				key: e.key,
				keptAt: e.keptAt,
				bytes: e.bytes,
			})),
		},
		null,
		"\t",
	)}\n`
}

const READ_FLAGS =
	fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | fsConstants.O_NOFOLLOW

type ReadResult = string | null | "oversized" | "not-regular"

async function readBounded(
	fs: RecordingKeepsFs,
	path: string,
): Promise<ReadResult> {
	let handle
	try {
		// Non-blocking, no symlink following: a FIFO, device or link can neither hang startup nor
		// redirect the read.
		handle = await fs.open(path, READ_FLAGS)
	} catch (error: unknown) {
		const code = (error as NodeJS.ErrnoException | null)?.code
		if (code === "ENOENT") return null
		throw error
	}
	try {
		const stat = await handle.stat()
		if (!stat.isFile()) return "not-regular"
		if (stat.size > RECORDING_KEEPS_FILE_MAX_BYTES) return "oversized"
		const buffer = Buffer.alloc(RECORDING_KEEPS_FILE_MAX_BYTES + 1)
		let length = 0
		for (;;) {
			const { bytesRead } = await handle.read(
				buffer,
				length,
				buffer.length - length,
				length,
			)
			if (bytesRead === 0) break
			length += bytesRead
			if (length > RECORDING_KEEPS_FILE_MAX_BYTES) return "oversized"
		}
		return buffer.subarray(0, length).toString("utf8")
	} finally {
		await handle.close()
	}
}

async function sweepTmp(
	fs: RecordingKeepsFs,
	stateDir: string,
	log: Logger,
): Promise<void> {
	let entries: string[]
	try {
		entries = await fs.readdir(stateDir)
	} catch {
		return
	}
	let removed = 0
	let failed = 0
	const nowMs = Date.now()
	for (const name of entries) {
		if (removed >= RECORDING_KEEPS_TMP_SWEEP_MAX) break
		const match = TMP_PATTERN.exec(name)
		if (match === null || Number(match[1]) === process.pid) continue
		const path = join(stateDir, name)
		try {
			const stat = await fs.lstat(path)
			if (!stat.isFile() || nowMs - stat.mtimeMs < RECORDING_KEEPS_TMP_STALE_MS)
				continue
			await fs.unlink(path)
			removed += 1
		} catch {
			failed += 1
		}
	}
	if (failed > 0)
		log.debug({ failed }, "Could not remove stale recording keep tmp files")
}

type Loaded =
	| { ok: true; file: RecordingKeepsFile }
	| { ok: false; reason: RecordingKeepsLoadFailure; error: unknown }

async function load(fs: RecordingKeepsFs, stateDir: string): Promise<Loaded> {
	let text: ReadResult
	try {
		text = await readBounded(fs, join(stateDir, RECORDING_KEEPS_FILE_NAME))
	} catch (error: unknown) {
		return { ok: false, reason: "unreadable", error }
	}
	if (text === null) return { ok: true, file: emptyRecordingKeepsFile() }
	if (text === "oversized" || text === "not-regular")
		return { ok: false, reason: text, error: undefined }
	const file = parseRecordingKeepsFile(text)
	if (file === null) return { ok: false, reason: "invalid", error: undefined }
	return { ok: true, file }
}

function unavailable(): RecordingKeepError {
	return new RecordingKeepError(
		"RECORDING_KEEPS_UNAVAILABLE",
		RECORDING_KEEPS_UNAVAILABLE_TEXT,
	)
}

/** Opens the store; never rejects (any load fault is state `failed`). */
export async function openRecordingKeepStore(
	opts: RecordingKeepStoreOptions,
): Promise<RecordingKeepStore> {
	const { stateDir, log } = opts
	const fs = opts.fs ?? nodeRecordingKeepsFs
	let loaded: Loaded
	try {
		await sweepTmp(fs, stateDir, log)
		loaded = await load(fs, stateDir)
	} catch (error: unknown) {
		loaded = { ok: false, reason: "unreadable", error }
	}
	const state: RecordingKeepStoreState = loaded.ok ? "ready" : "failed"
	let current = loaded.ok ? loaded.file : emptyRecordingKeepsFile()
	if (!loaded.ok) {
		log.warn(
			{
				reason: loaded.reason,
				count: 1,
				err: safeErrorFields(
					loaded.error ??
						new WaveKitError(
							"Recording keep file refused",
							"RECORDING_KEEPS_FILE_REFUSED",
						),
				),
			},
			"Recording keep file cannot be used; every recording is protected and Keep and delete are unavailable until it is repaired or removed and WaveKit restarts",
		)
	}
	let chain: Promise<void> = Promise.resolve()
	let closed = false

	const persist = async (next: RecordingKeepsFile): Promise<void> => {
		if (closed || state !== "ready") throw unavailable()
		const body = serializeRecordingKeepsFile(next)
		// Memory must equal what a reload yields: a file the loader refuses is never written.
		const parsed = parseRecordingKeepsFile(body)
		if (parsed === null)
			throw new RecordingKeepError(
				"RECORDING_KEEP_LIMIT",
				RECORDING_KEEPS_LIMIT_TEXT,
			)
		const tmp = join(
			stateDir,
			`${RECORDING_KEEPS_FILE_NAME}.${process.pid}.tmp`,
		)
		try {
			await fs.mkdir(stateDir, { recursive: true })
			let created = false
			try {
				// Exclusive create: never open (and so never truncate) an existing entry, a planted
				// symlink included. A leftover of ours is unlinked and the create retried once.
				const exclusive = () => fs.open(tmp, "wx", 0o644)
				let handle
				try {
					handle = await exclusive()
				} catch (error: unknown) {
					if ((error as { code?: unknown } | null)?.code !== "EEXIST")
						throw error
					await fs.unlink(tmp)
					handle = await exclusive()
				}
				created = true
				try {
					await handle.writeFile(body, "utf8")
					await handle.sync()
				} finally {
					await handle.close()
				}
				await fs.rename(tmp, join(stateDir, RECORDING_KEEPS_FILE_NAME))
			} catch (error: unknown) {
				if (created) await fs.unlink(tmp).catch(() => undefined)
				throw error
			}
		} catch (error: unknown) {
			log.warn(
				{ err: safeErrorFields(error) },
				"Could not write the recording keep file",
			)
			throw unavailable()
		}
		current = parsed
		try {
			const dir = await fs.open(stateDir, "r")
			try {
				await dir.sync()
			} finally {
				await dir.close()
			}
		} catch {
			// Directory fsync is best effort (unsupported on some platforms).
		}
	}

	return {
		state: () => state,
		snapshot: () => current,
		write(next) {
			const result = chain.then(() => persist(next))
			chain = result.catch(() => undefined)
			return result
		},
		async close() {
			closed = true
			await chain
		},
	}
}
