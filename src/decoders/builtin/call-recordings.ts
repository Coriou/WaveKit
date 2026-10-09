/**
 * Retention for dsd-fme per-call WAV recordings (`-7 <dir> -P`).
 *
 * Only files named by dsd-fme are touched (dsd_file.c, pinned ed1d1d6):
 * close_and_rename_wav_file writes
 * `<YYYYMMDD>_<HHMMSS>_<%05d random>_<sysid>_<GROUP|PRIVATE>_TGT_<tgt>_SRC_<src>.wav`
 * and open_wav_file writes the in-progress `TEMP_<YYYYMMDD>_<HHMMSS>_<%04X>.wav`
 * (left behind if dsd-fme dies mid-call). Any other WAV in the directory
 * (a user's own files, other tools) is never deleted.
 *
 * Files older than the age limit are deleted, then the oldest remaining files
 * are deleted until the directory total fits the size limit. Files modified
 * in the last few seconds are never touched: dsd-fme may still be writing
 * the current call.
 */

import { promises as fs } from "node:fs"
import * as path from "node:path"

export interface CallRecordingRetention {
	/** Keep at most this many megabytes (MiB) of recordings. */
	maxTotalMb: number
	/** Delete recordings older than this. */
	maxAgeHours: number
}

export interface PruneResult {
	deleted: string[]
	keptFiles: number
	keptBytes: number
}

/** dsd-fme's final per-call recording name. */
export const DSD_FME_CALL_WAV = /^\d{8}_\d{6}_\d{5}_.*_TGT_.*_SRC_.*\.wav$/
/** dsd-fme's in-progress recording name. */
export const DSD_FME_TEMP_WAV = /^TEMP_\d{8}_\d{6}_[0-9A-F]{4}\.wav$/

/** True for a WAV file named by dsd-fme's per-call recorder. */
export function isDsdFmeRecording(name: string): boolean {
	return DSD_FME_CALL_WAV.test(name) || DSD_FME_TEMP_WAV.test(name)
}

/** A recording modified this recently may still be open in dsd-fme. */
export const RECORDING_IN_PROGRESS_MS = 10_000

interface RecordingFile {
	path: string
	size: number
	mtimeMs: number
}

async function listWavFiles(dir: string): Promise<RecordingFile[]> {
	let names: string[]
	try {
		names = await fs.readdir(dir)
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return []
		throw err
	}
	const files: RecordingFile[] = []
	for (const name of names) {
		if (!isDsdFmeRecording(name)) continue
		const file = path.join(dir, name)
		try {
			const stat = await fs.stat(file)
			if (stat.isFile()) {
				files.push({ path: file, size: stat.size, mtimeMs: stat.mtimeMs })
			}
		} catch {
			// Removed meanwhile.
		}
	}
	return files
}

/** Applies the retention policy to the dsd-fme recordings directly in `dirs`. */
export async function pruneCallRecordings(
	dirs: readonly string[],
	retention: CallRecordingRetention,
	nowMs: number = Date.now(),
): Promise<PruneResult> {
	const files = (await Promise.all(dirs.map(listWavFiles))).flat()
	files.sort((a, b) => a.mtimeMs - b.mtimeMs)

	const maxAgeMs = retention.maxAgeHours * 3_600_000
	const maxBytes = retention.maxTotalMb * 1024 * 1024
	const deleted: string[] = []
	const kept: RecordingFile[] = []
	let total = files.reduce((sum, file) => sum + file.size, 0)

	for (const file of files) {
		const age = nowMs - file.mtimeMs
		const inProgress = age < RECORDING_IN_PROGRESS_MS
		const expired = age > maxAgeMs
		if (!inProgress && (expired || total > maxBytes)) {
			try {
				await fs.unlink(file.path)
				deleted.push(file.path)
				total -= file.size
				continue
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code === "ENOENT") {
					total -= file.size
					continue
				}
				throw err
			}
		}
		kept.push(file)
	}

	return { deleted, keptFiles: kept.length, keptBytes: total }
}
