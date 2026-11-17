#!/usr/bin/env node
// budget-fake-rtltcp.mjs PORT PLAYLIST [LOG]
//
// A paced rtl_tcp stand-in for the main-thread budget harness (standalone, Node 24, no
// dependencies; tier B mounts it into a scratch container). It listens on 127.0.0.1:PORT
// (0 = ephemeral; the shared ports are refused), sends the 12-byte rtl_tcp header ("RTL0",
// tuner type 5, 29 gains), reads and counts 5-byte commands without acting on them, and streams
// the playlist's CU8 files in 32 KiB chunks, looping the playlist.
//
// Playlist lines: `<file> <rateHz> [seconds]` (a relative file resolves against the playlist's
// directory; `seconds` plays that long, looping or cutting the file; default the whole file
// once). `#` starts a comment line.
//
// Pacing is a monotonic schedule that does not drift: after a late timer the due bytes go out
// at once, never more than 250 ms of signal per write. A consumer more than 2 s behind skips
// the rest of the backlog (counted), as a real dongle's queue would drop it.
//
// LOG gets one JSON line per listen, client, file start, mark and close, and a final summary
// (bytes sent, seconds of IQ). SIGUSR2 appends a `mark` line with the cumulative counters.
// SIGTERM or SIGINT write the summary and exit. The first stdout line is {"port":N}.
import { appendFileSync, readFileSync } from "node:fs"
import net from "node:net"
import { dirname, isAbsolute, resolve } from "node:path"
import { performance } from "node:perf_hooks"
import process from "node:process"

const BANNED_PORTS = new Set([
	1234, 4713, 5555, 5556, 5173, 8080, 8081, 8082, 9000, 15555, 15556, 18080,
])
const CHUNK = 32 * 1024
const MAX_WRITE_S = 0.25
const MAX_BEHIND_S = 2

const [portArg, playlistPath, logPath] = process.argv.slice(2)
if (portArg === undefined || playlistPath === undefined) {
	process.stderr.write("usage: budget-fake-rtltcp.mjs PORT PLAYLIST [LOG]\n")
	process.exit(1)
}
const wantPort = Number(portArg)
if (
	!Number.isInteger(wantPort) ||
	wantPort < 0 ||
	wantPort > 65535 ||
	BANNED_PORTS.has(wantPort)
) {
	process.stderr.write(`refused port ${portArg}\n`)
	process.exit(1)
}

const log = obj => {
	if (!logPath) return
	try {
		appendFileSync(
			logPath,
			`${JSON.stringify({ t: new Date().toISOString(), ...obj })}\n`,
		)
	} catch {
		// the log is best effort
	}
}

/** @type {{ path: string, rateHz: number, seconds: number | null }[]} */
const items = []
const base = dirname(resolve(playlistPath))
for (const raw of readFileSync(playlistPath, "utf8").split("\n")) {
	const line = raw.trim()
	if (line === "" || line.startsWith("#")) continue
	const [file, rate, secs] = line.split(/\s+/)
	const rateHz = Number(rate)
	const seconds = secs === undefined ? null : Number(secs)
	if (
		!file ||
		!Number.isFinite(rateHz) ||
		rateHz <= 0 ||
		(seconds !== null && !(seconds > 0))
	) {
		process.stderr.write(`bad playlist line: ${line}\n`)
		process.exit(1)
	}
	items.push({
		path: isAbsolute(file) ? file : resolve(base, file),
		rateHz,
		seconds,
	})
}
if (items.length === 0) {
	process.stderr.write("empty playlist\n")
	process.exit(1)
}
const cache = new Map()
const bytesOf = path => {
	let b = cache.get(path)
	if (!b) {
		b = readFileSync(path)
		if (b.length < 2) throw new Error(`${path} holds no IQ`)
		cache.set(path, b)
	}
	return b
}

const totals = {
	bytes: 0,
	iqSeconds: 0,
	commands: 0,
	skippedSeconds: 0,
	clients: 0,
	fileStarts: 0,
}

/** One connection's cursor over the playlist. */
function cursor() {
	let idx = -1
	let buf = null
	let off = 0
	let left = 0
	let rateHz = items[0].rateHz
	const next = () => {
		idx = (idx + 1) % items.length
		const it = items[idx]
		buf = bytesOf(it.path)
		off = 0
		rateHz = it.rateHz
		left =
			it.seconds === null
				? buf.length - (buf.length % 2)
				: 2 * Math.round(it.seconds * it.rateHz)
		totals.fileStarts++
		log({
			ev: "file-start",
			idx,
			path: it.path,
			rateHz: it.rateHz,
			bytes: left,
		})
	}
	next()
	return {
		rate: () => rateHz,
		/** Up to n bytes of the current item (one item per call, so a chunk has one rate). */
		take(n) {
			if (left <= 0) next()
			const k = Math.min(n, left)
			const outBuf = Buffer.allocUnsafe(k)
			let w = 0
			while (w < k) {
				if (off >= buf.length - (buf.length % 2)) off = 0
				const m = Math.min(k - w, buf.length - (buf.length % 2) - off)
				buf.copy(outBuf, w, off, off + m)
				w += m
				off += m
			}
			left -= k
			return outBuf
		},
	}
}

const sockets = new Set()
const server = net.createServer(socket => {
	sockets.add(socket)
	totals.clients++
	log({ ev: "client", remotePort: socket.remotePort })
	socket.setNoDelay(true)
	socket.on("error", () => undefined)
	const header = Buffer.alloc(12)
	header.write("RTL0", 0, "ascii")
	header.writeUInt32BE(5, 4)
	header.writeUInt32BE(29, 8)
	socket.write(header)
	let pending = 0
	socket.on("data", d => {
		pending += d.length
		totals.commands += Math.floor(pending / 5)
		pending %= 5
	})
	const cur = cursor()
	let nextDue = performance.now()
	let timer = null
	let waiting = false
	const pump = () => {
		timer = null
		if (socket.destroyed) return
		if (socket.writableNeedDrain) {
			waiting = true
			return
		}
		const now = performance.now()
		if (now - nextDue > MAX_BEHIND_S * 1000) {
			totals.skippedSeconds += (now - nextDue) / 1000
			nextDue = now
		}
		const parts = []
		let signalS = 0
		while (nextDue <= now && signalS < MAX_WRITE_S) {
			const rate = cur.rate()
			const chunk = cur.take(CHUNK)
			const s = chunk.length / (2 * rate)
			parts.push(chunk)
			signalS += s
			totals.bytes += chunk.length
			totals.iqSeconds += s
			nextDue += s * 1000
		}
		if (parts.length > 0)
			socket.write(parts.length === 1 ? parts[0] : Buffer.concat(parts))
		timer = setTimeout(pump, Math.max(1, nextDue - performance.now()))
	}
	socket.on("drain", () => {
		if (waiting) {
			waiting = false
			pump()
		}
	})
	socket.on("close", () => {
		if (timer) clearTimeout(timer)
		sockets.delete(socket)
		log({ ev: "client-close", ...totals })
	})
	pump()
})

server.on("error", err => {
	process.stderr.write(`fake rtl_tcp: ${err.message}\n`)
	process.exit(1)
})
server.listen(wantPort, "127.0.0.1", () => {
	const addr = server.address()
	const port = typeof addr === "object" && addr ? addr.port : 0
	if (BANNED_PORTS.has(port)) {
		process.stderr.write(`refused ephemeral port ${port}\n`)
		process.exit(3)
	}
	log({ ev: "listen", port, items: items.length })
	process.stdout.write(`${JSON.stringify({ port })}\n`)
})

process.on("SIGUSR2", () => {
	log({ ev: "mark", monoMs: performance.now(), ...totals })
})
for (const sig of ["SIGTERM", "SIGINT"])
	process.on(sig, () => {
		log({ ev: "summary", ...totals })
		for (const s of sockets) s.destroy()
		server.close()
		process.exit(0)
	})
