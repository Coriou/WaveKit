import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { createServer, type Socket } from "node:net"
import { once } from "node:events"
import * as fc from "fast-check"
import pino from "pino"
import {
	SourceManager,
	alignIqChunk,
	iqFrameBytes,
} from "../../../src/core/source-manager.js"

describe("IQ source frame boundaries", () => {
	it("emits complete CU8 pairs across odd TCP chunks and suppresses unchanged caps", async () => {
		let peer!: Socket
		const server = createServer(socket => {
			peer = socket
		})
		server.listen(0, "127.0.0.1")
		await once(server, "listening")
		const address = server.address()
		if (!address || typeof address === "string")
			throw new Error("Missing address")
		const manager = new SourceManager(pino({ level: "silent" }))
		try {
			const accepted = once(server, "connection")
			const stream = await manager.connect({
				id: "iq",
				type: "rtl_tcp",
				host: "127.0.0.1",
				port: address.port,
				loop: false,
				playbackSpeed: 1,
				caps: {
					kind: "iq",
					format: "U8_IQ",
					sampleRate: 2048000,
					centerFreq: 446000000,
					exclusive: false,
				},
			})
			await accepted
			const chunks: Buffer[] = []
			stream.on("data", chunk => chunks.push(Buffer.from(chunk)))
			const changed = vi.fn()
			manager.on("caps-changed", changed)
			manager.updateSourceCaps("iq", {
				sampleRate: 2048000,
				centerFreq: 446000000,
			})
			expect(changed).not.toHaveBeenCalled()
			manager.updateSourceCaps("iq", { centerFreq: 446100000 })
			expect(changed).toHaveBeenCalledOnce()
			const header = Buffer.alloc(12)
			header.write("RTL0")
			header.writeUInt32BE(6, 4)
			header.writeUInt32BE(29, 8)
			peer.write(header)
			const payload = Buffer.from(
				Array.from({ length: 20 }, (_, n) => (n % 2 ? 0x20 : 0x10)),
			)
			let offset = 0
			for (const length of [1, 3, 5, 11]) {
				peer.write(payload.subarray(offset, offset + length))
				offset += length
				await new Promise(resolve => setTimeout(resolve, 20))
			}
			await vi.waitFor(() => expect(Buffer.concat(chunks)).toEqual(payload))
			expect(chunks.every(chunk => chunk.length % 2 === 0)).toBe(true)
			expect(chunks.every(chunk => chunk[0] === 0x10)).toBe(true)
			peer.write(Buffer.from([0xff]))
			await new Promise(resolve => setTimeout(resolve, 20))
			const reconnected = once(manager, "connected")
			const acceptedReconnect = once(server, "connection")
			const previousPeer = peer
			peer.destroy()
			await Promise.all([reconnected, acceptedReconnect])
			expect(peer).not.toBe(previousPeer)
			peer.write(Buffer.concat([header, Buffer.from([0x10, 0x20])]))
			await vi.waitFor(() =>
				expect(Buffer.concat(chunks)).toEqual(
					Buffer.concat([payload, Buffer.from([0x10, 0x20])]),
				),
			)
		} finally {
			await manager.disconnectAll()
			peer?.destroy()
			await new Promise<void>(resolve => server.close(() => resolve()))
		}
	}, 10000)
	it("drops an unmatched final byte at each recording loop boundary", async () => {
		const directory = mkdtempSync(join(tmpdir(), "wavekit-iq-"))
		const path = join(directory, "odd.cu8")
		writeFileSync(path, Buffer.from([0x10, 0x20, 0x10, 0x20, 0xff]))
		const manager = new SourceManager(pino({ level: "silent" }))
		try {
			const stream = await manager.connect({
				id: "loop",
				type: "recording",
				filePath: path,
				loop: true,
				playbackSpeed: 1,
				caps: {
					kind: "iq",
					format: "U8_IQ",
					sampleRate: 2048000,
					exclusive: false,
				},
			})
			const chunks: Buffer[] = []
			stream.on("data", chunk => chunks.push(Buffer.from(chunk)))
			await vi.waitFor(() => expect(chunks.length).toBeGreaterThanOrEqual(3))
			expect(
				chunks.every(chunk =>
					chunk.equals(Buffer.from([0x10, 0x20, 0x10, 0x20])),
				),
			).toBe(true)
		} finally {
			await manager.disconnectAll()
			rmSync(directory, { recursive: true, force: true })
		}
	})
})

describe("IQ frame alignment for every IQ format", () => {
	it("frame sizes: U8 pair 2, S16 pair 4, F32 pair 8; audio and auto are not aligned", () => {
		expect(iqFrameBytes({ kind: "iq", format: "U8_IQ" })).toBe(2)
		expect(iqFrameBytes({ kind: "iq", format: "S16_IQ" })).toBe(4)
		expect(iqFrameBytes({ kind: "iq", format: "FLOAT32LE" })).toBe(8)
		expect(iqFrameBytes({ kind: "audio_pcm", format: "FLOAT32LE" })).toBeNull()
		expect(iqFrameBytes({ kind: "audio_pcm", format: "S16LE" })).toBeNull()
		expect(iqFrameBytes({ kind: "iq", format: "auto" })).toBeNull()
	})

	// Feature: signal-discovery-scanner (§ 4.1 alignment; no numbered property)
	it("any split of a stream yields whole frames, in order, losing only the unfinished tail", () => {
		fc.assert(
			fc.property(
				fc.constantFrom(2, 4, 8),
				fc.uint8Array({ minLength: 0, maxLength: 400 }),
				fc.array(fc.integer({ min: 1, max: 37 }), {
					minLength: 1,
					maxLength: 40,
				}),
				(frame, bytes, cuts) => {
					const data = Buffer.from(bytes)
					let remainder: Buffer = Buffer.alloc(0)
					const out: Buffer[] = []
					let offset = 0
					let i = 0
					while (offset < data.length) {
						const length = cuts[i++ % cuts.length]!
						const result = alignIqChunk(
							remainder,
							data.subarray(offset, offset + length),
							frame,
						)
						offset += length
						expect(result.aligned.length % frame).toBe(0)
						expect(result.remainder.length).toBeLessThan(frame)
						out.push(result.aligned)
						remainder = result.remainder
					}
					const whole = data.length - (data.length % frame)
					expect(Buffer.concat(out)).toEqual(data.subarray(0, whole))
					expect(remainder).toEqual(data.subarray(whole))
				},
			),
			{ numRuns: 100 },
		)
	})

	it.each([
		["S16_IQ", 4],
		["FLOAT32LE", 8],
	] as const)(
		"drops the unmatched tail of a %s recording at each loop boundary",
		async (format, frame) => {
			const directory = mkdtempSync(join(tmpdir(), "wavekit-iq-"))
			const path = join(directory, `odd-${format}.bin`)
			const whole = Buffer.from(
				Array.from({ length: 2 * frame }, (_, n) => n + 1),
			)
			writeFileSync(
				path,
				Buffer.concat([whole, Buffer.from([0xee, 0xee, 0xee])]),
			)
			const manager = new SourceManager(pino({ level: "silent" }))
			try {
				const stream = await manager.connect({
					id: `loop-${format}`,
					type: "recording",
					filePath: path,
					loop: true,
					playbackSpeed: 1,
					caps: { kind: "iq", format, sampleRate: 2048000, exclusive: false },
				})
				const chunks: Buffer[] = []
				stream.on("data", chunk => chunks.push(Buffer.from(chunk)))
				await vi.waitFor(() => expect(chunks.length).toBeGreaterThanOrEqual(3))
				expect(chunks.every(chunk => chunk.equals(whole))).toBe(true)
			} finally {
				await manager.disconnectAll()
				rmSync(directory, { recursive: true, force: true })
			}
		},
	)
})
