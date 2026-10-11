import { describe, it, expect, vi } from "vitest"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
	wavHeader,
	WavFileWriter,
	type WavIo,
} from "../../../../src/core/scanner/channel/wav-writer.js"

function fake() {
	let file = Buffer.alloc(0)
	let fileLength = 0
	let step = Infinity
	let writeError = false
	let syncError = false
	let closeError = false
	let corrupt = false
	let sizeDelta = 0
	let blocker: Promise<void> | null = null
	const close = vi.fn(async () => {
		if (closeError) throw new Error("close")
	})
	const sync = vi.fn(async () => {
		if (blocker) await blocker
		if (syncError) throw new Error("sync")
	})
	const unlink = vi.fn(async () => {
		file = Buffer.alloc(0)
		fileLength = 0
	})
	const write = vi.fn(
		async (
			buffer: Buffer,
			offset: number,
			length: number,
			position: number,
		) => {
			if (blocker) await blocker
			if (writeError) throw new Error("write")
			const bytesWritten = Math.min(step, length)
			if (position + bytesWritten > file.length) {
				const next = Buffer.alloc(
					Math.max(position + bytesWritten, file.length * 2),
				)
				file.copy(next)
				file = next
			}
			buffer.copy(file, position, offset, offset + bytesWritten)
			fileLength = Math.max(fileLength, position + bytesWritten)
			return { bytesWritten }
		},
	)
	const io: WavIo = {
		open: vi.fn(async () => ({ write, sync, close })),
		unlink,
		inspect: vi.fn(async () => ({
			header: corrupt ? Buffer.alloc(44) : Buffer.from(file.subarray(0, 44)),
			fileBytes: fileLength + sizeDelta,
		})),
	}
	return {
		io,
		close,
		sync,
		unlink,
		write,
		get file() {
			return file.subarray(0, fileLength)
		},
		set step(value: number) {
			step = value
		},
		set writeError(value: boolean) {
			writeError = value
		},
		set syncError(value: boolean) {
			syncError = value
		},
		set closeError(value: boolean) {
			closeError = value
		},
		set corrupt(value: boolean) {
			corrupt = value
		},
		set sizeDelta(value: number) {
			sizeDelta = value
		},
		set blocker(value: Promise<void> | null) {
			blocker = value
		},
	}
}
function deferred() {
	let resolve!: () => void
	const promise = new Promise<void>(done => {
		resolve = done
	})
	return { promise, resolve }
}

describe("private staged WAV writer", () => {
	it("writes and independently verifies a real no-clobber PCM file", async () => {
		const dir = await mkdtemp(join(tmpdir(), "wavekit-wav-"))
		try {
			const path = join(dir, "stage.wav.part")
			const writer = await WavFileWriter.open(path)
			await expect(WavFileWriter.open(path)).rejects.toThrow()
			await writer.write(new Int16Array([-32768, -1, 0, 32767]))
			const receipt = await writer.finish()
			expect(receipt).toMatchObject({
				bytes: 8,
				fileBytes: 52,
				outputFrames: 4,
				durationMs: 0.5,
				sampleRateHz: 8000,
				fileSync: "synced",
			})
			const data = await readFile(path)
			expect(data.toString("ascii", 0, 4)).toBe("RIFF")
			expect(data.readUInt32LE(4)).toBe(44)
			expect(data.readUInt32LE(24)).toBe(8000)
			expect(data.readUInt16LE(22)).toBe(1)
			expect(data.readUInt16LE(34)).toBe(16)
			expect(data.readUInt32LE(40)).toBe(8)
			expect([...data.subarray(44)]).toEqual([0, 128, 255, 255, 0, 0, 255, 127])
			expect((await stat(path)).size).toBe(receipt.fileBytes)
			await writer.abort()
			expect(await writer.finish()).toBe(receipt)
			expect(Object.isFrozen(receipt)).toBe(true)
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})
	it("loops over short header and PCM writes, preserving admission order and copied input", async () => {
		const f = fake()
		f.step = 3
		const writer = await WavFileWriter.open("stage", 8000, { io: f.io })
		const input = new Int16Array([12, 34])
		const one = writer.write(input)
		input.fill(99)
		const two = writer.write(new Int16Array([56]))
		await Promise.all([one, two])
		expect((await writer.finish()).outputFrames).toBe(3)
		expect([
			f.file.readInt16LE(44),
			f.file.readInt16LE(46),
			f.file.readInt16LE(48),
		]).toEqual([12, 34, 56])
		expect(f.close).toHaveBeenCalledTimes(1)
	})
	it("rejects zero-progress initialization and cleans the owned path", async () => {
		const f = fake()
		f.step = 0
		await expect(
			WavFileWriter.open("stage", 8000, { io: f.io }),
		).rejects.toThrow("invalid progress")
		expect(f.close).toHaveBeenCalledTimes(1)
		expect(f.unlink).toHaveBeenCalledTimes(1)
	})
	it.each(["zero", "write", "sync", "close", "header", "size"])(
		"does not return a receipt after %s failure",
		async mode => {
			const f = fake()
			const writer = await WavFileWriter.open("stage", 8000, { io: f.io })
			if (mode === "zero") f.step = 0
			if (mode === "write") f.writeError = true
			if (mode === "sync") f.syncError = true
			if (mode === "close") f.closeError = true
			if (mode === "header") f.corrupt = true
			if (mode === "size") f.sizeDelta = 1
			if (mode === "zero" || mode === "write")
				await expect(writer.write(new Int16Array([1]))).rejects.toThrow()
			else await writer.write(new Int16Array([1]))
			const finish = writer.finish()
			expect(writer.finish()).toBe(finish)
			await expect(finish).rejects.toThrow()
			await expect(writer.write(new Int16Array())).rejects.toThrow()
			expect(f.close).toHaveBeenCalledTimes(1)
		},
	)
	it("bounds queued bytes and chunks before copying, and releases capacity after drain", async () => {
		const f = fake()
		const writer = await WavFileWriter.open("stage", 8000, {
			io: f.io,
			maxQueuedBytes: 8,
			maxQueuedChunks: 2,
		})
		const gate = deferred()
		f.blocker = gate.promise
		const one = writer.write(new Int16Array([1, 2]))
		const two = writer.write(new Int16Array([3, 4]))
		expect(writer.pendingBytes).toBe(8)
		expect(writer.pendingChunks).toBe(2)
		await expect(writer.write(new Int16Array([5]))).rejects.toMatchObject({
			code: "SCANNER_WAV_BACKPRESSURE",
		})
		gate.resolve()
		await Promise.all([one, two])
		expect(writer.pendingBytes).toBe(0)
		expect(writer.pendingChunks).toBe(0)
		await writer.write(new Int16Array([5]))
		expect((await writer.finish()).outputFrames).toBe(5)
	})
	it("bounds chunk count independently of byte capacity", async () => {
		const f = fake()
		const writer = await WavFileWriter.open("stage", 8000, {
			io: f.io,
			maxQueuedBytes: 100,
			maxQueuedChunks: 1,
		})
		const gate = deferred()
		f.blocker = gate.promise
		const first = writer.write(new Int16Array([1]))
		await expect(writer.write(new Int16Array([2]))).rejects.toMatchObject({
			code: "SCANNER_WAV_BACKPRESSURE",
		})
		gate.resolve()
		await first
		await writer.finish()
	})
	it("truncates to the frame-aligned 120 second hard cap", async () => {
		const f = fake()
		const writer = await WavFileWriter.open("stage", 8000, {
			io: f.io,
			maxQueuedBytes: 2_000_000,
		})
		await writer.write(new Int16Array(960_003).fill(123))
		await writer.write(new Int16Array([99]))
		expect(await writer.finish()).toMatchObject({
			durationMs: 120_000,
			outputFrames: 960_000,
			fileBytes: 1_920_044,
		})
		expect(f.file.readInt16LE(f.file.length - 2)).toBe(123)
	})
	it("abort fences intake synchronously, drains accepted writes and is idempotent", async () => {
		const f = fake()
		const writer = await WavFileWriter.open("stage", 8000, { io: f.io })
		const gate = deferred()
		f.blocker = gate.promise
		const write = writer.write(new Int16Array([1, 2]))
		const writeAssertion = expect(write).rejects.toMatchObject({
			code: "SCANNER_WAV_CANCELLED",
		})
		const first = writer.abort()
		const second = writer.abort()
		await expect(writer.write(new Int16Array([3]))).rejects.toMatchObject({
			code: "SCANNER_WAV_CLOSED",
		})
		gate.resolve()
		await Promise.all([writeAssertion, first, second])
		await expect(writer.finish()).rejects.toMatchObject({
			code: "SCANNER_WAV_CANCELLED",
		})
		expect(f.close).toHaveBeenCalledTimes(1)
		expect(f.unlink).toHaveBeenCalledTimes(1)
	})
	it("stops a large admitted buffer and queued jobs after the in-flight 10 ms PCM write", async () => {
		const f = fake()
		const writer = await WavFileWriter.open("stage", 8000, { io: f.io })
		const gate = deferred()
		const entered = deferred()
		f.blocker = gate.promise
		const original = f.write.getMockImplementation()!
		f.write.mockImplementationOnce(async (buffer, offset, length, position) => {
			entered.resolve()
			return original(buffer, offset, length, position)
		})
		const active = writer.write(new Int16Array(30_000).fill(42))
		const queued = writer.write(new Int16Array([99]))
		const activeAssertion = expect(active).rejects.toMatchObject({
			code: "SCANNER_WAV_CANCELLED",
		})
		const queuedAssertion = expect(queued).rejects.toMatchObject({
			code: "SCANNER_WAV_CANCELLED",
		})
		await entered.promise
		expect(f.write.mock.calls[1]?.[2]).toBe(160)
		const abort = writer.abort()
		gate.resolve()
		await Promise.all([activeAssertion, queuedAssertion, abort])
		expect(f.write).toHaveBeenCalledTimes(2) // Initial header and one in-flight PCM write only.
		expect(writer.pendingBytes).toBe(0)
		expect(writer.pendingChunks).toBe(0)
		expect(f.close).toHaveBeenCalledTimes(1)
		expect(f.unlink).toHaveBeenCalledTimes(1)
		await expect(writer.finish()).rejects.toMatchObject({
			code: "SCANNER_WAV_CANCELLED",
		})
	})
	it("cancellation during finishing defeats success until the final synchronous decision", async () => {
		const f = fake()
		const writer = await WavFileWriter.open("stage", 8000, { io: f.io })
		const gate = deferred()
		const entered = deferred()
		f.sync.mockImplementationOnce(async () => {
			entered.resolve()
			await gate.promise
		})
		const finish = writer.finish()
		const assertion = expect(finish).rejects.toMatchObject({
			code: "SCANNER_WAV_CANCELLED",
		})
		await entered.promise
		const abort = writer.abort()
		gate.resolve()
		await Promise.all([assertion, abort])
		expect(f.unlink).toHaveBeenCalledTimes(1)
	})
	it.each(["close", "inspect"])(
		"cancels while %s is pending without publishing a receipt",
		async phase => {
			const f = fake()
			const writer = await WavFileWriter.open("stage", 8000, { io: f.io })
			const gate = deferred()
			const entered = deferred()
			if (phase === "close")
				f.close.mockImplementationOnce(async () => {
					entered.resolve()
					await gate.promise
				})
			else
				f.io.inspect = async () => {
					entered.resolve()
					await gate.promise
					return {
						header: Buffer.from(f.file.subarray(0, 44)),
						fileBytes: f.file.length,
					}
				}
			const finish = writer.finish()
			const assertion = expect(finish).rejects.toMatchObject({
				code: "SCANNER_WAV_CANCELLED",
			})
			await entered.promise
			const abort = writer.abort()
			gate.resolve()
			await Promise.all([assertion, abort])
			expect(f.close).toHaveBeenCalledTimes(1)
			expect(f.unlink).toHaveBeenCalledTimes(1)
		},
	)
	it("fences intake immediately on finish and rejects zero-progress header patch", async () => {
		const f = fake()
		const writer = await WavFileWriter.open("stage", 8000, { io: f.io })
		await writer.write(new Int16Array([1]))
		f.step = 0
		const finish = writer.finish()
		await expect(writer.write(new Int16Array([2]))).rejects.toMatchObject({
			code: "SCANNER_WAV_CLOSED",
		})
		await expect(finish).rejects.toThrow("invalid progress")
		expect(f.close).toHaveBeenCalledTimes(1)
	})
	it("surfaces abort close and cleanup failures", async () => {
		const f = fake()
		const writer = await WavFileWriter.open("stage", 8000, { io: f.io })
		f.closeError = true
		await expect(writer.abort()).rejects.toThrow("close")
		const g = fake()
		const other = await WavFileWriter.open("stage", 8000, { io: g.io })
		g.unlink.mockRejectedValue(new Error("unlink"))
		await expect(other.abort()).rejects.toThrow("unlink")
	})
	it("validates header/options before opening", async () => {
		const f = fake()
		for (const rate of [0, -1, 1.5, NaN, 20_000_000])
			await expect(
				WavFileWriter.open("stage", rate, { io: f.io }),
			).rejects.toThrow()
		for (const size of [-1, 1, NaN, 0xffffffff])
			expect(() => wavHeader(8000, size)).toThrow()
		await expect(
			WavFileWriter.open("stage", 8000, { io: f.io, maxQueuedBytes: 0 }),
		).rejects.toThrow()
		expect(f.io.open).not.toHaveBeenCalled()
	})
})
