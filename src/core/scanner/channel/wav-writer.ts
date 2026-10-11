import { open, unlink } from "node:fs/promises"
import { WaveKitError } from "../../../utils/errors.js"

export const WAV_HEADER_BYTES = 44
export const MAX_WAV_DURATION_SECONDS = 120

function failure(message: string, cause?: unknown): WaveKitError {
	return cause instanceof WaveKitError
		? cause
		: new WaveKitError(
				message,
				"SCANNER_WAV_IO",
				cause instanceof Error ? cause : undefined,
			)
}
function validRate(rate: number): void {
	if (
		!Number.isSafeInteger(rate) ||
		rate <= 0 ||
		rate > Math.floor((0xffffffff - 36) / (2 * MAX_WAV_DURATION_SECONDS))
	)
		throw new WaveKitError("Invalid WAV sample rate", "SCANNER_WAV_OPTIONS")
}
export function wavHeader(sampleRateHz: number, dataBytes: number): Buffer {
	validRate(sampleRateHz)
	if (
		!Number.isSafeInteger(dataBytes) ||
		dataBytes < 0 ||
		dataBytes % 2 !== 0 ||
		dataBytes > 0xffffffff - 36
	)
		throw new WaveKitError("Invalid WAV data size", "SCANNER_WAV_OPTIONS")
	const h = Buffer.alloc(WAV_HEADER_BYTES)
	h.write("RIFF", 0)
	h.writeUInt32LE(36 + dataBytes, 4)
	h.write("WAVE", 8)
	h.write("fmt ", 12)
	h.writeUInt32LE(16, 16)
	h.writeUInt16LE(1, 20)
	h.writeUInt16LE(1, 22)
	h.writeUInt32LE(sampleRateHz, 24)
	h.writeUInt32LE(sampleRateHz * 2, 28)
	h.writeUInt16LE(2, 32)
	h.writeUInt16LE(16, 34)
	h.write("data", 36)
	h.writeUInt32LE(dataBytes, 40)
	return h
}

/** Only the private staged file boundary; publication belongs to its caller. */
export interface WavHandle {
	write(
		buffer: Buffer,
		offset: number,
		length: number,
		position: number,
	): Promise<{ bytesWritten: number }>
	sync(): Promise<void>
	close(): Promise<void>
}
export interface WavIo {
	open(path: string, flags: "wx"): Promise<WavHandle>
	inspect(path: string): Promise<{ header: Buffer; fileBytes: number }>
	unlink(path: string): Promise<void>
}
const fileIo: WavIo = {
	open,
	unlink,
	async inspect(path) {
		const handle = await open(path, "r")
		try {
			const header = Buffer.alloc(WAV_HEADER_BYTES)
			let offset = 0
			while (offset < header.length) {
				const { bytesRead } = await handle.read(
					header,
					offset,
					header.length - offset,
					offset,
				)
				if (bytesRead === 0) throw failure("Short WAV header")
				offset += bytesRead
			}
			return { header, fileBytes: (await handle.stat()).size }
		} finally {
			await handle.close()
		}
	},
}
export interface WavWriterOptions {
	io?: WavIo
	maxQueuedBytes?: number
	maxQueuedChunks?: number
}
export interface WavWriteReceipt {
	/** PCM bytes, retained for the historical writer API. */
	readonly bytes: number
	readonly fileBytes: number
	readonly outputFrames: number
	readonly durationMs: number
	readonly sampleRateHz: number
	readonly fileSync: "synced"
}

export class WavFileWriter {
	private bytes = 0
	private admittedBytes = 0
	private queuedBytes = 0
	private queuedChunks = 0
	private tail: Promise<void> = Promise.resolve()
	private writeFailure: WaveKitError | null = null
	private closed = false
	private accepting = true
	private cancelled = false
	private receipt: WavWriteReceipt | null = null
	private terminal: Promise<WavWriteReceipt> | null = null
	private cleanup: Promise<void> | null = null

	private constructor(
		private readonly handle: WavHandle,
		private readonly path: string,
		private readonly sampleRateHz: number,
		private readonly io: WavIo,
		private readonly maxQueuedBytes: number,
		private readonly maxQueuedChunks: number,
	) {}

	static async open(
		path: string,
		sampleRateHz = 8000,
		opts: WavWriterOptions = {},
	): Promise<WavFileWriter> {
		validRate(sampleRateHz)
		const maxBytes = opts.maxQueuedBytes ?? 65_536
		const maxChunks = opts.maxQueuedChunks ?? 64
		if (
			![maxBytes, maxChunks].every(
				value => Number.isSafeInteger(value) && value > 0,
			)
		)
			throw new WaveKitError("Invalid WAV queue bounds", "SCANNER_WAV_OPTIONS")
		const io = opts.io ?? fileIo
		let handle: WavHandle
		try {
			handle = await io.open(path, "wx")
		} catch (cause) {
			throw failure("WAV open failed", cause)
		}
		const writer = new WavFileWriter(
			handle,
			path,
			sampleRateHz,
			io,
			maxBytes,
			maxChunks,
		)
		try {
			await writer.writeAll(wavHeader(sampleRateHz, 0), 0)
		} catch (cause) {
			try {
				await writer.close()
			} catch (closeCause) {
				throw failure("WAV initialization close failed", closeCause)
			}
			try {
				await writer.remove()
			} catch (cleanupCause) {
				throw failure("WAV initialization cleanup failed", cleanupCause)
			}
			throw failure("WAV initialization failed", cause)
		}
		return writer
	}

	get durationMs(): number {
		return (this.bytes / 2 / this.sampleRateHz) * 1000
	}
	get pendingBytes(): number {
		return this.queuedBytes
	}
	get pendingChunks(): number {
		return this.queuedChunks
	}

	/** Rejects admission before copying; caller awaits writes to apply backpressure. */
	write(pcm: Int16Array): Promise<void> {
		if (!this.accepting || this.writeFailure)
			return Promise.reject(
				this.writeFailure ??
					new WaveKitError("WAV intake is closed", "SCANNER_WAV_CLOSED"),
			)
		const bytes = Math.min(
			pcm.byteLength,
			this.sampleRateHz * MAX_WAV_DURATION_SECONDS * 2 - this.admittedBytes,
		)
		if (bytes === 0) return Promise.resolve()
		if (
			bytes > this.maxQueuedBytes - this.queuedBytes ||
			this.queuedChunks >= this.maxQueuedChunks
		)
			return Promise.reject(
				new WaveKitError("WAV queue is full", "SCANNER_WAV_BACKPRESSURE"),
			)
		// Encode explicitly: WAV PCM is little endian independently of host endianness.
		const buffer = Buffer.allocUnsafe(bytes)
		for (let i = 0; i < bytes / 2; i++) buffer.writeInt16LE(pcm[i]!, i * 2)
		this.admittedBytes += bytes
		this.queuedBytes += bytes
		this.queuedChunks++
		const job = this.tail
			.then(async () => {
				if (this.writeFailure) throw this.writeFailure
				try {
					await this.writeAll(buffer, WAV_HEADER_BYTES + this.bytes, true)
					this.bytes += bytes
				} catch (cause) {
					this.writeFailure = failure("WAV PCM write failed", cause)
					this.accepting = false
					throw this.writeFailure
				}
			})
			.finally(() => {
				this.queuedBytes -= bytes
				this.queuedChunks--
			})
		this.tail = job.catch(() => undefined)
		return job
	}

	finish(): Promise<WavWriteReceipt> {
		this.accepting = false
		this.terminal ??= this.settle()
		return this.terminal
	}

	/** Synchronously fences intake, including while finish is awaiting I/O. */
	cancel(): void {
		if (this.receipt) return
		this.cancelled = true
		this.accepting = false
	}
	abort(): Promise<void> {
		if (this.receipt) return Promise.resolve()
		this.cancel()
		return this.finish().then(
			() => undefined,
			async (cause: unknown) => {
				await this.remove()
				if (
					!(
						cause instanceof WaveKitError &&
						cause.code === "SCANNER_WAV_CANCELLED"
					)
				)
					throw cause
			},
		)
	}

	private async settle(): Promise<WavWriteReceipt> {
		try {
			await this.tail
			if (this.writeFailure) throw this.writeFailure
			this.checkCancellation()
			const expected = wavHeader(this.sampleRateHz, this.bytes)
			await this.writeAll(expected, 0)
			this.checkCancellation()
			await this.handle.sync()
			this.checkCancellation()
			await this.close()
			this.checkCancellation()
			const actual = await this.io.inspect(this.path)
			if (
				!actual.header.equals(expected) ||
				actual.fileBytes !== WAV_HEADER_BYTES + this.bytes
			)
				throw new WaveKitError(
					"WAV header or file size is invalid",
					"SCANNER_WAV_INVALID",
				)
			this.checkCancellation()
			this.receipt = Object.freeze({
				bytes: this.bytes,
				fileBytes: actual.fileBytes,
				outputFrames: this.bytes / 2,
				durationMs: this.durationMs,
				sampleRateHz: this.sampleRateHz,
				fileSync: "synced" as const,
			})
			return this.receipt
		} catch (cause) {
			let error = failure("WAV finish failed", cause)
			try {
				await this.close()
			} catch (closeCause) {
				error = failure("WAV close failed", closeCause)
			}
			if (this.cancelled) {
				try {
					await this.remove()
				} catch (cleanupCause) {
					throw failure("WAV cleanup failed", cleanupCause)
				}
			}
			throw error
		}
	}
	private checkCancellation(): void {
		if (this.cancelled)
			throw new WaveKitError("WAV cancelled", "SCANNER_WAV_CANCELLED")
	}
	private async close(): Promise<void> {
		if (this.closed) return
		this.closed = true // A failed close is never reported as a successful receipt.
		await this.handle.close()
	}
	private remove(): Promise<void> {
		this.cleanup ??= this.io.unlink(this.path).catch((cause: unknown) => {
			if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
				return
			throw failure("WAV unlink failed", cause)
		})
		return this.cleanup
	}
	private async writeAll(
		buffer: Buffer,
		position: number,
		pcm = false,
	): Promise<void> {
		let offset = 0
		while (offset < buffer.length) {
			if (pcm) this.checkCancellation()
			// One PCM await covers at most 10 ms at the fixed 8 kHz rate.
			const length = Math.min(
				buffer.length - offset,
				pcm
					? Math.max(1, Math.floor(this.sampleRateHz / 100)) * 2
					: WAV_HEADER_BYTES,
			)
			const { bytesWritten } = await this.handle.write(
				buffer,
				offset,
				length,
				position + offset,
			)
			if (
				!Number.isSafeInteger(bytesWritten) ||
				bytesWritten <= 0 ||
				bytesWritten > length
			)
				throw failure("WAV write made invalid progress")
			offset += bytesWritten
			if (pcm) this.checkCancellation()
		}
	}
}
