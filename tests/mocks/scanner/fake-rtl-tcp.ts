import net from "node:net"
import { addInto, gaussianNoise, mulberry32, packCu8, tone } from "./signals.js"

export interface SpectrumRtlTcp {
	port: number
	frames: [number, number][]
	frequency(): number
	close(): Promise<void>
}

export async function startSpectrumRtlTcp(opts: {
	fs: number
	initialHz: number
	emitters: { hz: number; amp: number }[]
	seed: number
	/** Counter chunks (20 ms each) sent after every TEST_MODE 1 → 0 transition. */
	markerChunks?: number
}): Promise<SpectrumRtlTcp> {
	const frames: [number, number][] = []
	const rng = mulberry32(opts.seed)
	const chunkSamples = Math.round(opts.fs * 0.02)
	let frequency = opts.initialHz
	let testMode = false
	let counterChunksLeft = 0
	let counter = 0
	const sockets = new Set<net.Socket>()
	const server = net.createServer(socket => {
		sockets.add(socket)
		socket.on("error", () => undefined)
		socket.on("close", () => sockets.delete(socket))
		const header = Buffer.alloc(12)
		header.write("RTL0", 0, "ascii")
		header.writeUInt32BE(5, 4)
		header.writeUInt32BE(29, 8)
		socket.write(header)
		let pending = Buffer.alloc(0)
		socket.on("data", data => {
			pending = Buffer.concat([pending, Buffer.from(data)])
			while (pending.length >= 5) {
				const cmd = pending.readUInt8(0)
				const value = pending.readUInt32BE(1)
				pending = pending.subarray(5)
				frames.push([cmd, value])
				if (cmd === 0x01) frequency = value
				if (cmd === 0x07) {
					if (value === 1) testMode = true
					else if (testMode) {
						testMode = false
						counterChunksLeft = opts.markerChunks ?? 2
					}
				}
			}
		})
	})
	const timer = setInterval(() => {
		let bytes: Uint8Array
		if (testMode || counterChunksLeft > 0) {
			if (!testMode) counterChunksLeft -= 1
			bytes = new Uint8Array(chunkSamples * 2)
			for (let i = 0; i < bytes.length; i++) bytes[i] = counter++ & 255
		} else {
			const iq = gaussianNoise(rng, chunkSamples, 0.04)
			for (const e of opts.emitters) {
				const offset = e.hz - frequency
				if (Math.abs(offset) < opts.fs / 2)
					addInto(iq, tone(chunkSamples, opts.fs, offset, e.amp))
			}
			bytes = packCu8(iq.re, iq.im)
		}
		for (const s of sockets) if (!s.destroyed) s.write(Buffer.from(bytes))
	}, 20)
	timer.unref()
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
	const address = server.address() as net.AddressInfo
	return {
		port: address.port,
		frames,
		frequency: () => frequency,
		close: async () => {
			clearInterval(timer)
			for (const s of sockets) s.destroy()
			await new Promise<void>(resolve => server.close(() => resolve()))
		},
	}
}
