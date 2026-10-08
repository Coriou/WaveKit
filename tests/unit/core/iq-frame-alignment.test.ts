import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { createServer, type Socket } from "node:net"
import { once } from "node:events"
import pino from "pino"
import { SourceManager } from "../../../src/core/source-manager.js"

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
			const previousPeer = peer
			peer.destroy()
			await reconnected
			await vi.waitFor(() => expect(peer).not.toBe(previousPeer))
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
