/**
 * Tmp file + fsync + rename, as in BandOverrideStore.write. Shared by ScannerPersistence (which
 * re-exports it) and the EvidenceStore (Task 17); the snapshot worker (WG11 req 3.5) uses only
 * `writeChunksSynced`, so its bundle does not pull in the persistence module.
 */
import { mkdir, open, rename, rm } from "node:fs/promises"
import { dirname } from "node:path"
import { WaveKitError } from "../../../utils/errors.js"

export async function atomicWrite(
	file: string,
	data: string | Uint8Array,
): Promise<void> {
	await atomicWriteChunks(file, [data])
}

/**
 * `atomicWrite` of the concatenation of `chunks`, written piece by piece; resolves to the bytes
 * written. `tmpTag` keeps a writer on another thread of this process (the snapshot worker) off
 * the main thread's `<file>.<pid>.tmp`, so a late worker write or rename never touches it.
 */
export async function atomicWriteChunks(
	file: string,
	chunks: Iterable<string | Uint8Array>,
	tmpTag?: string,
): Promise<number> {
	let bytes: number
	const tmp =
		tmpTag === undefined
			? `${file}.${process.pid}.tmp`
			: `${file}.${process.pid}.${tmpTag}.tmp`
	try {
		bytes = await writeChunksSynced(tmp, chunks)
		await rename(tmp, file)
		return bytes
	} catch (err) {
		await rm(tmp, { force: true }).catch(() => undefined)
		throw new WaveKitError(
			`Could not write ${file}`,
			"SCANNER_PERSIST_FAILED",
			err instanceof Error ? err : undefined,
		)
	}
}

/**
 * Writes `chunks` to `tmp` (created or truncated, parent made) and fsyncs it; resolves to the
 * bytes written. No rename: the snapshot worker writes only its own tmp file and the main thread
 * publishes it (review m3), so an abandoned worker can never replace the target. On failure the
 * tmp file is removed and the error rethrown.
 */
export async function writeChunksSynced(
	tmp: string,
	chunks: Iterable<string | Uint8Array>,
): Promise<number> {
	let bytes = 0
	try {
		await mkdir(dirname(tmp), { recursive: true })
		const handle = await open(tmp, "w")
		try {
			for (const chunk of chunks) {
				await handle.writeFile(chunk)
				bytes +=
					typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length
			}
			await handle.sync()
		} finally {
			await handle.close()
		}
		return bytes
	} catch (err) {
		await rm(tmp, { force: true }).catch(() => undefined)
		throw err
	}
}
