import net from "node:net"
import { describe, expect, it } from "vitest"
import { startSpectrumRtlTcp } from "../../../mocks/scanner/fake-rtl-tcp.js"

const OPTS = {
	fs: 256_000,
	initialHz: 446_000_000,
	emitters: [{ hz: 446_050_000, amp: 0.3 }],
	seed: 3,
}
const CHUNK = Math.round(OPTS.fs * 0.02) * 2

/**
 * Connects, switches TEST_MODE on and returns the sample bytes from the first counter chunk on
 * (`chunks` chunks). Counter bytes are deterministic (they start at 0 with the first test-mode
 * chunk), unlike the noise whose generator advances on every timer tick.
 */
async function counterStream(
	port: number,
	header: (h: Buffer) => void,
	chunks: number,
): Promise<Buffer> {
	const socket = net.connect(port, "127.0.0.1")
	let data = Buffer.alloc(0)
	try {
		return await new Promise<Buffer>((resolve, reject) => {
			socket.on("error", reject)
			socket.once("connect", () => {
				const cmd = Buffer.alloc(5)
				cmd.writeUInt8(0x07, 0)
				cmd.writeUInt32BE(1, 1)
				socket.write(cmd)
			})
			socket.on("data", (d: Buffer) => {
				data = Buffer.concat([data, d])
				if (data.length < 12) return
				// chunks are written whole after the 12-byte header: find the counter's first one
				for (let off = 12; off + chunks * CHUNK <= data.length; off += CHUNK) {
					if (data[off] === 0 && data[off + 1] === 1 && data[off + 2] === 2) {
						header(data.subarray(0, 12))
						resolve(data.subarray(off, off + chunks * CHUNK))
						return
					}
				}
			})
		})
	} finally {
		socket.destroy()
	}
}

describe("fake rtl_tcp send delay (WG9 TT.2)", () => {
	it("keeps the default byte stream and only shifts delivery when delayed", async () => {
		const servers = await Promise.all([
			startSpectrumRtlTcp(OPTS),
			startSpectrumRtlTcp({ ...OPTS, sendDelayMs: 0 }),
			startSpectrumRtlTcp({ ...OPTS, sendDelayMs: 100 }),
		])
		try {
			const headers: Buffer[] = []
			const streams = await Promise.all(
				servers.map(s => counterStream(s.port, h => headers.push(h), 3)),
			)
			for (const h of headers) {
				expect(h.subarray(0, 4).toString("ascii")).toBe("RTL0")
				expect(h.readUInt32BE(4)).toBe(5)
				expect(h.readUInt32BE(8)).toBe(29)
			}
			const expected = Buffer.from(
				Array.from({ length: 3 * CHUNK }, (_, i) => i & 255),
			)
			for (const s of streams) expect(s.equals(expected)).toBe(true)
			for (const s of servers) expect(s.frames).toEqual([[0x07, 1]])
		} finally {
			await Promise.all(servers.map(s => s.close()))
		}
	}, 60_000)
})
