/**
 * Longevity: heap over time on the per-message paths (measure only, not CI). Two bounded soaks,
 * heap sampled after a forced GC (run with --expose-gc):
 *
 * - iq: an in-process fake rtl_tcp on 127.0.0.1 port 0 streams U8 IQ at --rate samples/s into
 *   SourceManager → FanoutManager with two draining branches and one that never drains (drops),
 *   plus branch churn every second (a decoder restart each). Real time, --seconds long.
 * - tracking: a fake clock (Date.now replaced) drives AircraftTracker and the Activity admission
 *   ingress (coalescer + queue, drained as a writer would) with a rotating population: --aircraft
 *   aircraft in view, each replaced after 20 minutes, one report per aircraft every --step s (5), for
 *   --hours simulated hours.
 *
 *   pnpm exec esbuild scripts/longevity/memory-soak.ts --bundle \
 *     --platform=node --format=esm --packages=external \
 *     --outfile=output/longevity/memory-soak.mjs
 *   node --expose-gc output/longevity/memory-soak.mjs --part iq --seconds 60
 *   node --expose-gc output/longevity/memory-soak.mjs --part tracking --hours 12
 *
 * Synthetic data only (noise IQ, counter ICAO addresses). Never point it at a real receiver.
 */
import net from "node:net"
import os from "node:os"
import { performance } from "node:perf_hooks"
import process from "node:process"
import pino from "pino"
import { createActivityIngress } from "../../src/core/activity/ingress.js"
import { ActivityIngress } from "../../src/core/activity/storage/ingress.js"
import { resolveActivityLimits } from "../../src/core/activity/storage/limits.js"
import { AircraftTracker } from "../../src/core/aircraft-tracker.js"
import { FanoutManager } from "../../src/core/fanout-manager.js"
import { SourceManager } from "../../src/core/source-manager.js"
import type { SourceConfig } from "../../src/core/source-manager.js"

const arg = (name: string, fallback: number): number => {
	const i = process.argv.indexOf(`--${name}`)
	const v = i >= 0 ? Number(process.argv[i + 1]) : Number.NaN
	return Number.isFinite(v) && v > 0 ? v : fallback
}
const part = (() => {
	const i = process.argv.indexOf("--part")
	return i >= 0 ? (process.argv[i + 1] ?? "iq") : "iq"
})()
const silent = pino({ level: "silent" })

const heapMiB = (): number => {
	const g = (globalThis as { gc?: () => void }).gc
	if (g) g()
	return process.memoryUsage().heapUsed / 2 ** 20
}
const slope = (xs: number[], ys: number[]): number => {
	const n = xs.length
	const mx = xs.reduce((a, b) => a + b, 0) / n
	const my = ys.reduce((a, b) => a + b, 0) / n
	let num = 0
	let den = 0
	for (let i = 0; i < n; i++) {
		num += ((xs[i] ?? 0) - mx) * ((ys[i] ?? 0) - my)
		den += ((xs[i] ?? 0) - mx) ** 2
	}
	return den === 0 ? 0 : num / den
}

async function iqSoak(): Promise<void> {
	const seconds = arg("seconds", 60)
	const rate = arg("rate", 1_024_000)
	const chunkBytes = Math.round(rate * 2 * 0.02)
	const noise = Buffer.alloc(chunkBytes)
	for (let i = 0; i < noise.length; i++) noise[i] = 120 + ((i * 37) % 16)
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
		socket.on("data", () => undefined)
	})
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
	const port = (server.address() as net.AddressInfo).port
	const pump = setInterval(() => {
		for (const s of sockets) if (!s.destroyed) s.write(noise)
	}, 20)

	const manager = new SourceManager(silent)
	const fanout = new FanoutManager(silent)
	const config: SourceConfig = {
		id: "soak-1",
		type: "rtl_tcp",
		host: "127.0.0.1",
		port,
		loop: false,
		playbackSpeed: 1,
		caps: {
			kind: "iq",
			format: "U8_IQ",
			sampleRate: rate,
			exclusive: false,
		},
	} as SourceConfig
	const stream = await manager.connect(config)
	fanout.setByteRate(rate * 2)
	fanout.attachSource(stream)
	let drained = 0
	for (const id of ["a", "b"]) {
		const branch = fanout.addBranch({ id, highWaterMarkMs: 500 })
		branch.on("data", (c: Buffer) => {
			drained += c.length
		})
	}
	fanout.addBranch({ id: "stuck", highWaterMarkMs: 500 })
	let churn = 0
	const churnTimer = setInterval(() => {
		const id = `churn-${churn++}`
		const branch = fanout.addBranch({ id, highWaterMarkMs: 250 })
		branch.resume()
		setTimeout(() => fanout.removeBranch(id), 500)
	}, 1_000)

	const xs: number[] = []
	const ys: number[] = []
	const t0 = performance.now()
	const cpu0 = process.cpuUsage()
	const samples: { s: number; heapMiB: number; rssMiB: number }[] = []
	for (let s = 0; s <= seconds; s += 10) {
		if (s > 0) await new Promise(resolve => setTimeout(resolve, 10_000))
		const h = heapMiB()
		xs.push(s / 60)
		ys.push(h)
		samples.push({
			s,
			heapMiB: Number(h.toFixed(2)),
			rssMiB: Math.round(process.memoryUsage().rss / 2 ** 20),
		})
	}
	const cpu = process.cpuUsage(cpu0)
	const wallS = (performance.now() - t0) / 1000
	clearInterval(churnTimer)
	clearInterval(pump)
	fanout.destroy()
	await manager.disconnectAll()
	for (const s of sockets) s.destroy()
	await new Promise<void>(resolve => server.close(() => resolve()))
	console.log(
		JSON.stringify({
			part: "iq",
			rate,
			seconds,
			drainedMiB: Math.round(drained / 2 ** 20),
			branchChurn: churn,
			samples,
			heapSlopeMiBPerMin: Number(slope(xs, ys).toFixed(3)),
			cpuCores: Number(((cpu.user + cpu.system) / 1e6 / wallS).toFixed(3)),
			loadavg: os.loadavg().map(x => Number(x.toFixed(2))),
		}),
	)
}

async function trackingSoak(): Promise<void> {
	const hours = arg("hours", 12)
	const inView = arg("aircraft", 150)
	const T0 = Date.parse("2026-01-01T00:00:00.000Z")
	const clock = { t: T0 }
	const realNow = Date.now
	Date.now = () => clock.t
	try {
		const tracker = new AircraftTracker({}, silent)
		const cleanup = (): void =>
			(tracker as unknown as { cleanup(): void }).cleanup()
		const store = new ActivityIngress(
			resolveActivityLimits({}),
			() => clock.t,
			silent,
		)
		const ingress = createActivityIngress({
			sink: (envelope, present) => {
				store.admit(envelope, present)
			},
			logger: silent,
			now: () => new Date(clock.t),
		})
		let rows = 0
		const drain = (): void => {
			for (;;) {
				const batch = store.takeBatch(64, 1 << 20)
				if (batch.length === 0) return
				rows += batch.length
				store.ack(new Set(batch.map(r => r.eventId)))
			}
		}
		const LIFE_S = 20 * 60
		const STEP_S = arg("step", 5)
		const xs: number[] = []
		const ys: number[] = []
		const samples: { h: number; heapMiB: number; tracked: number }[] = []
		const cpu0 = process.cpuUsage()
		const w0 = performance.now()
		let reports = 0
		for (let s = 0; s <= hours * 3600; s += STEP_S) {
			clock.t = T0 + s * 1_000
			for (let k = 0; k < inView; k++) {
				// Slot k hosts a new airframe every LIFE_S, staggered per slot.
				const generation = Math.floor((s + (k * LIFE_S) / inView) / LIFE_S)
				const icao = (0x100000 + generation * inView + k)
					.toString(16)
					.toUpperCase()
				const lat = 50 + k / 100 + s / 1e5
				const lon = 4 + k / 100
				tracker.processUpdate({
					hex: icao,
					flight: `WKA${k}`,
					lat,
					lon,
					alt_baro: 30_000,
					gs: 420,
					track: k % 360,
				})
				ingress.publish("readsb", "readsb", {
					timestamp: new Date(clock.t),
					decoder: "readsb",
					type: "aircraft",
					data: {
						icao,
						callsign: `WKA${k}`,
						lat,
						lon,
						altitude: 30_000,
						groundSpeed: 420,
						track: k % 360,
					},
				})
				reports++
			}
			drain()
			cleanup()
			if (s % 3600 === 0) {
				const h = heapMiB()
				xs.push(s / 3600)
				ys.push(h)
				samples.push({
					h: s / 3600,
					heapMiB: Number(h.toFixed(2)),
					tracked: tracker.getAll().length,
				})
			}
		}
		const cpu = process.cpuUsage(cpu0)
		console.log(
			JSON.stringify({
				part: "tracking",
				hours,
				inView,
				reports,
				rows,
				samples,
				heapSlopeMiBPerHourAfterFirst: Number(
					slope(xs.slice(1), ys.slice(1)).toFixed(3),
				),
				cpuSeconds: Number(((cpu.user + cpu.system) / 1e6).toFixed(1)),
				wallSeconds: Number(((performance.now() - w0) / 1000).toFixed(1)),
				loadavg: os.loadavg().map(x => Number(x.toFixed(2))),
			}),
		)
	} finally {
		Date.now = realNow
	}
}

if (part === "iq") await iqSoak()
else if (part === "tracking") await trackingSoak()
else throw new RangeError(`unknown part ${part}`)
