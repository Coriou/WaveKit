/**
 * An async WAV writer that owns one `FileHandle` (8 kHz signed 16-bit mono, the tap's format).
 *
 * The file is opened `wx` (never over an existing file) and starts with a 44-byte header holding
 * zero sizes. Samples are copied little-endian into an 8 KiB buffer that is written when it fills
 * and at finish: 8 192 B = 4 096 samples = 512 ms of voice per write, so a call costs about two
 * writes a second. Writes run one at a time, in order, on one promise chain (no sync fs, no
 * stream). `finish` patches the RIFF and data sizes through the same handle at offset 0, then
 * closes it. The first failure stops every later write and is reported once through `onError`.
 */

import { WaveKitError } from "../../utils/errors.js"
import { DV_TAP_SAMPLE_RATE_HZ } from "../dv-tap/types.js"

/** Size of the canonical PCM header. */
export const WAV_HEADER_BYTES = 44
/** Write buffer: 8 KiB = 4 096 samples = 512 ms at 8 kHz (16 000 B/s). */
export const WAV_WRITE_BUFFER_BYTES = 8192

/** The `FileHandle` calls the writer makes. */
export interface DvWavHandle {
	write(
		buffer: Uint8Array,
		offset: number,
		length: number,
		position: number,
	): Promise<{ bytesWritten: number }>
	close(): Promise<void>
}

export interface DvWavFs {
	open(path: string, flags: "wx"): Promise<DvWavHandle>
	unlink(path: string): Promise<void>
}

/** The 44-byte header of `dataBytes` of 8 kHz 16-bit mono PCM. */
export function wavHeader(dataBytes: number): Buffer {
	const h = Buffer.alloc(WAV_HEADER_BYTES)
	h.write("RIFF", 0, "ascii")
	h.writeUInt32LE(36 + dataBytes, 4)
	h.write("WAVE", 8, "ascii")
	h.write("fmt ", 12, "ascii")
	h.writeUInt32LE(16, 16)
	h.writeUInt16LE(1, 20) // PCM
	h.writeUInt16LE(1, 22) // mono
	h.writeUInt32LE(DV_TAP_SAMPLE_RATE_HZ, 24)
	h.writeUInt32LE(DV_TAP_SAMPLE_RATE_HZ * 2, 28) // 16 000 B/s
	h.writeUInt16LE(2, 32) // block align
	h.writeUInt16LE(16, 34) // bits
	h.write("data", 36, "ascii")
	h.writeUInt32LE(dataBytes, 40)
	return h
}

async function writeAll(
	handle: DvWavHandle,
	buf: Uint8Array,
	position: number,
): Promise<void> {
	let off = 0
	while (off < buf.length) {
		const { bytesWritten } = await handle.write(
			buf,
			off,
			buf.length - off,
			position + off,
		)
		if (!(bytesWritten > 0))
			throw new WaveKitError("WAV write made no progress", "DV_WAV_SHORT_WRITE")
		off += bytesWritten
	}
}

export class DvWavWriter {
	readonly path: string
	private readonly fs: DvWavFs
	private handle: DvWavHandle | null = null
	private chain: Promise<void>
	private failure: unknown = null
	private buf = Buffer.allocUnsafe(WAV_WRITE_BUFFER_BYTES)
	private fill = 0
	/** File offset of the next buffered byte once written. */
	private position = WAV_HEADER_BYTES
	private done = false
	private aborted = false
	/** True once `open` created the file (only then may abort unlink it). */
	private created = false
	/** PCM bytes accepted (header excluded). */
	dataBytes = 0
	/** Called once, with the first open or write failure. */
	onError: ((err: unknown) => void) | null = null

	constructor(fs: DvWavFs, path: string) {
		this.fs = fs
		this.path = path
		this.chain = fs.open(path, "wx").then(async handle => {
			this.handle = handle
			this.created = true
			await writeAll(handle, wavHeader(0), 0)
		})
		this.chain = this.chain.catch((err: unknown) => this.fail(err))
	}

	get failed(): boolean {
		return this.failure !== null
	}

	private fail(err: unknown): void {
		if (this.failure !== null) return
		this.failure = err
		const cb = this.onError
		if (cb !== null) {
			try {
				cb(err)
			} catch {
				// A consumer callback never breaks the chain.
			}
		}
	}

	private enqueue(op: (handle: DvWavHandle) => Promise<void>): void {
		this.chain = this.chain.then(async () => {
			if (this.failure !== null || this.aborted || this.handle === null) return
			try {
				await op(this.handle)
			} catch (err) {
				this.fail(err)
			}
		})
	}

	private flush(): void {
		if (this.fill === 0) return
		const chunk = this.buf.subarray(0, this.fill)
		const at = this.position
		this.position += this.fill
		this.buf = Buffer.allocUnsafe(WAV_WRITE_BUFFER_BYTES)
		this.fill = 0
		this.enqueue(h => writeAll(h, chunk, at))
	}

	/**
	 * Appends `pcm[from, to)` and returns how many of those samples are non-zero (every sample is
	 * scanned). Ignored after a failure or finish.
	 */
	append(pcm: Int16Array, from = 0, to = pcm.length): number {
		if (this.done || this.failure !== null) return 0
		let nonZero = 0
		for (let i = from; i < to; i++) {
			const s = pcm[i] ?? 0
			if (s !== 0) nonZero++
			if (this.fill + 2 > WAV_WRITE_BUFFER_BYTES) this.flush()
			this.buf.writeInt16LE(s, this.fill)
			this.fill += 2
		}
		this.dataBytes += 2 * Math.max(0, to - from)
		if (this.fill >= WAV_WRITE_BUFFER_BYTES) this.flush()
		return nonZero
	}

	/**
	 * Writes what is buffered, patches the header sizes through the same handle and closes it.
	 * Resolves the PCM byte count; rejects with the first failure (the handle is closed then too).
	 */
	async finish(): Promise<number> {
		if (!this.done) {
			this.done = true
			this.flush()
			const bytes = this.dataBytes
			this.enqueue(h => writeAll(h, wavHeader(bytes), 0))
		}
		await this.chain
		await this.closeHandle()
		if (this.failure !== null) throw this.failure
		return this.dataBytes
	}

	/**
	 * Stops writing, closes the handle and unlinks the file (errors ignored). A file this writer
	 * did not create (the `wx` open failed) is never unlinked.
	 */
	async abort(): Promise<void> {
		this.done = true
		this.aborted = true
		this.fill = 0
		await this.chain
		await this.closeHandle()
		if (this.created) await this.fs.unlink(this.path).catch(() => undefined)
	}

	private async closeHandle(): Promise<void> {
		const h = this.handle
		this.handle = null
		if (h === null) return
		try {
			await h.close()
		} catch (err) {
			this.fail(err)
		}
	}
}
