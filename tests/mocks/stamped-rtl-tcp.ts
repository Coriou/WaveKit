import net from "node:net"

/**
 * In-process rtl_tcp fake on an ephemeral loopback port whose samples are stamped: each U8 IQ
 * sample is `[I, Q] = [index of the centre, index of the rate]` the fake was tuned to when it produced
 * it (indices from 1, in first-seen order). Commands take effect when the fake reads them, so bytes
 * already in flight keep the old stamps, like a real receiver behind a network.
 */
export interface StampedRtlTcp {
	port: number
	frames: [number, number][]
	/** Stamp index → centre / rate. */
	centreOf(stamp: number): number | undefined
	rateOf(stamp: number): number | undefined
	centreStamp(hz: number): number | undefined
	/** Stops reading commands (socket backpressure towards the core) until resumeReading. */
	pauseReading(): void
	resumeReading(): void
	/** Drops every connection (the receiver stays tuned, like a dongle behind rtlmux). */
	dropConnections(): void
	/**
	 * A receiver restart: drops every connection; `keepTuning` keeps the centre and rate (rtlmux
	 * replaying its cache), else the receiver is back on its default (a replug). The next
	 * connection's header carries `tunerType` (default unchanged).
	 */
	restart(opts: { keepTuning: boolean; tunerType?: number }): void
	/** Commands take effect `ms` after they are read (an upstream delay queue); 0: at once. */
	setCommandDelay(ms: number): void
	/** The centre and rate the receiver is on now. */
	tuning(): { centre: number; rate: number }
	/** Connections accepted so far. */
	connections(): number
	close(): Promise<void>
}

export async function startStampedRtlTcp(opts: {
	initialHz: number
	initialRate: number
	/** Bytes per chunk (even) and chunk interval. */
	chunkBytes?: number
	intervalMs?: number
	/** Delay before a read command takes effect (setCommandDelay). */
	commandDelayMs?: number
}): Promise<StampedRtlTcp> {
	const frames: [number, number][] = []
	const centres: number[] = []
	const rates: number[] = []
	const stampOf = (list: number[], value: number): number => {
		let i = list.indexOf(value)
		if (i < 0) {
			list.push(value)
			i = list.length - 1
		}
		return (i % 255) + 1
	}
	let centre = stampOf(centres, opts.initialHz)
	let rate = stampOf(rates, opts.initialRate)
	const sockets = new Set<net.Socket>()
	let paused = false
	let delayMs = opts.commandDelayMs ?? 0
	let tunerType = 5
	let accepted = 0
	const timers = new Set<NodeJS.Timeout>()
	const apply = (cmd: number, value: number) => {
		if (cmd === 0x01) centre = stampOf(centres, value)
		if (cmd === 0x02) rate = stampOf(rates, value)
	}
	const server = net.createServer(socket => {
		sockets.add(socket)
		accepted += 1
		socket.on("error", () => undefined)
		socket.on("close", () => sockets.delete(socket))
		const header = Buffer.alloc(12)
		header.write("RTL0", 0, "ascii")
		header.writeUInt32BE(tunerType, 4)
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
				if (delayMs <= 0) apply(cmd, value)
				else {
					// Same delay for every command: they take effect in read order.
					const t = setTimeout(() => {
						timers.delete(t)
						apply(cmd, value)
					}, delayMs)
					timers.add(t)
				}
			}
		})
		if (paused) socket.pause()
	})
	const chunkBytes = opts.chunkBytes ?? 1024
	const timer = setInterval(() => {
		const bytes = Buffer.alloc(chunkBytes)
		for (let i = 0; i < chunkBytes; i += 2) {
			bytes[i] = centre
			bytes[i + 1] = rate
		}
		for (const s of sockets) if (!s.destroyed) s.write(bytes)
	}, opts.intervalMs ?? 5)
	timer.unref()
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
	const address = server.address() as net.AddressInfo
	return {
		port: address.port,
		frames,
		centreOf: stamp => centres[stamp - 1],
		rateOf: stamp => rates[stamp - 1],
		centreStamp: hz => {
			const i = centres.indexOf(hz)
			return i < 0 ? undefined : i + 1
		},
		pauseReading: () => {
			paused = true
			for (const s of sockets) s.pause()
		},
		resumeReading: () => {
			paused = false
			for (const s of sockets) s.resume()
		},
		dropConnections: () => {
			for (const s of sockets) s.destroy()
		},
		restart: ({ keepTuning, tunerType: type }) => {
			for (const s of sockets) s.destroy()
			if (!keepTuning) {
				centre = stampOf(centres, opts.initialHz)
				rate = stampOf(rates, opts.initialRate)
			}
			if (type !== undefined) tunerType = type
		},
		setCommandDelay: ms => {
			delayMs = ms
		},
		tuning: () => ({ centre: centres[centre - 1]!, rate: rates[rate - 1]! }),
		connections: () => accepted,
		close: async () => {
			for (const t of timers) clearTimeout(t)
			clearInterval(timer)
			for (const s of sockets) s.destroy()
			await new Promise<void>(resolve => server.close(() => resolve()))
		},
	}
}
