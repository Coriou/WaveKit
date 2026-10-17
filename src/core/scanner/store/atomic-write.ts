/**
 * Tmp file + fsync + rename, as in BandOverrideStore.write. Shared by ScannerPersistence (which
 * re-exports it), the EvidenceStore (Task 17) and the snapshot worker (WG11 req 3.5), so the
 * worker bundle does not pull in the persistence module.
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
	let bytes = 0
	const tmp =
		tmpTag === undefined
			? `${file}.${process.pid}.tmp`
			: `${file}.${process.pid}.${tmpTag}.tmp`
	try {
		await mkdir(dirname(file), { recursive: true })
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
