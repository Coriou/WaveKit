/**
 * WG10 req 2.4: live audio gap harness (measure only, not CI).
 *
 * Runs the LiveDemodulator with local stand-in processes for its two CSDR
 * stages (tiny node passthroughs, via the `spawnStage` seam; not csdr) and
 * a fake IQ branch paced in real time, attaches one client, then performs
 * offset changes and full restarts (a gain change). For each change it
 * reports the audio gap the client saw: the growth of bytes missing against
 * real time (stream rate × elapsed − bytes received) within the window after
 * the change, in milliseconds of audio ("gap"), and the longest time the
 * client received no byte at all ("stall": what drains a player's ring).
 * Prints p50/p90/max, client disconnects and the load average.
 *
 *   pnpm exec esbuild scripts/bench/live-audio-gap.ts --bundle \
 *     --platform=node --format=esm --packages=external \
 *     --outfile=output/bench/live-audio-gap.mjs
 *   node output/bench/live-audio-gap.mjs [--changes 20] [--window-ms 1500]
 *
 * Against frozen code (no `spawnStage` seam) the same script is run with a
 * patched `child_process.spawn` (the seam is detected at runtime).
 */
import childProcess, { type ChildProcess } from "node:child_process"
import { syncBuiltinESMExports } from "node:module"
import os from "node:os"
import { PassThrough, Writable } from "node:stream"
import { performance } from "node:perf_hooks"
import process from "node:process"
import { createLogger } from "../../src/utils/logger.js"
import { LiveDemodConfigSchema } from "../../src/config.js"
import { LiveDemodulator } from "../../src/core/live-demodulator.js"

const IQ_RATE = 2_400_000 // U8 IQ capture, decimation 96 → 25 kHz channel
const CHANNEL_RATE = 25_000
const AUDIO_BYTES_PER_SECOND = CHANNEL_RATE * 2 // s16le mono
const FEED_MS = 10

// Stand-in front: 96 complex U8 samples (192 bytes) in → one CF32 sample out.
const FRONT_SCRIPT = `let a=0;process.stdin.on("data",c=>{a+=c.length;const n=Math.floor(a/192);if(n>0){a-=n*192;const b=Buffer.alloc(n*8);for(let i=0;i<n;i++){b.writeFloatLE(0.1,i*8);b.writeFloatLE(0.1,i*8+4)}process.stdout.write(b)}});process.stdin.on("end",()=>process.exit(0))`
// Stand-in back: one CF32 sample in → one s16le sample out.
const BACK_SCRIPT = `let a=0;process.stdin.on("data",c=>{a+=c.length;const n=Math.floor(a/8);if(n>0){a-=n*8;process.stdout.write(Buffer.alloc(n*2,1))}});process.stdin.on("end",()=>process.exit(0))`

function spawnStandIn(command: string): ChildProcess {
	const back = command.includes("demod") || command.includes("-o s16")
	return childProcess.spawn(
		process.execPath,
		["-e", back ? BACK_SCRIPT : FRONT_SCRIPT],
		{ stdio: ["pipe", "pipe", "pipe"], detached: true },
	)
}

function arg(name: string, fallback: number): number {
	const index = process.argv.indexOf(`--${name}`)
	if (index < 0) return fallback
	const value = Number(process.argv[index + 1])
	return Number.isFinite(value) ? value : fallback
}

export function percentile(values: number[], p: number): number {
	if (values.length === 0) return Number.NaN
	const sorted = [...values].sort((a, b) => a - b)
	const index = Math.min(
		sorted.length - 1,
		Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
	)
	return sorted[index]!
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

class TimedClient extends Writable {
	received = 0
	ended = false
	lastAt = performance.now()
	/** Longest time without a byte since the last reset. */
	longestStallMs = 0
	constructor() {
		super({ highWaterMark: 1 << 30 })
		this.on("finish", () => (this.ended = true))
		this.on("close", () => (this.ended = true))
	}
	override _write(chunk: Buffer, _enc: BufferEncoding, cb: () => void): void {
		const now = performance.now()
		this.longestStallMs = Math.max(this.longestStallMs, now - this.lastAt)
		this.lastAt = now
		this.received += chunk.length
		cb()
	}
}

async function main(): Promise<void> {
	const changes = arg("changes", 20)
	const windowMs = arg("window-ms", 1500)
	const caps = { kind: "iq", sampleRate: IQ_RATE, format: "U8_IQ" as const }
	const sourceManager = {
		getAllStatus: () => [{ id: "bench", connected: true }],
		getStatus: () => ({ id: "bench", connected: true }),
		getCaps: () => ({ ...caps }),
		on: () => sourceManager,
		off: () => sourceManager,
	}
	const branch = new PassThrough({ highWaterMark: 1 << 20 })
	const fanout = { addBranch: () => branch, removeBranch: () => undefined }
	const config = LiveDemodConfigSchema.parse({
		enabled: true,
		sourceId: "bench",
		httpPort: 40_000 + Math.floor(Math.random() * 5000),
	})
	// Frozen code has no seam: route its /bin/sh spawns to the stand-ins.
	const originalSpawn = childProcess.spawn
	;(childProcess as { spawn: unknown }).spawn = ((
		file: string,
		args: readonly string[],
		options: object,
	) =>
		file === "/bin/sh"
			? spawnStandIn(args[1] ?? "")
			: originalSpawn(file, args, options)) as unknown
	syncBuiltinESMExports()
	const demod = new LiveDemodulator(
		createLogger({ level: "fatal" }),
		sourceManager as never,
		fanout as never,
		config,
		{ httpHost: "127.0.0.1", spawnStage: spawnStandIn } as never,
	)
	await demod.start()

	// Real-time IQ feed (bytes for the elapsed time, every 10 ms).
	const feedStart = performance.now()
	let fed = 0
	const feeder = setInterval(() => {
		const due =
			Math.floor(((performance.now() - feedStart) / 1000) * IQ_RATE) * 2
		if (due > fed) {
			branch.write(Buffer.alloc(due - fed, 127))
			fed = due
		}
	}, FEED_MS)

	const client = new TimedClient()
	const internals = demod as unknown as {
		registerClient(response: unknown, remoteAddress: string): unknown
	}
	await sleep(1500) // pipeline warm-up
	internals.registerClient(client, "bench")
	const t0 = performance.now()
	const missingMs = () =>
		((performance.now() - t0) / 1000) * 1000 -
		(client.received / AUDIO_BYTES_PER_SECOND) * 1000
	let disconnects = 0

	const stalls: { offset: number[]; restart: number[] } = {
		offset: [],
		restart: [],
	}
	async function measure(
		kind: "offset" | "restart",
		change: () => Promise<void>,
	): Promise<number> {
		await sleep(300)
		client.longestStallMs = 0
		const before = missingMs()
		let worst = before
		const sampler = setInterval(() => {
			worst = Math.max(worst, missingMs())
		}, 2)
		await change()
		const end = performance.now() + windowMs
		while (performance.now() < end) await sleep(5)
		clearInterval(sampler)
		worst = Math.max(worst, missingMs())
		if (client.ended) disconnects++
		stalls[kind].push(
			Math.max(client.longestStallMs, performance.now() - client.lastAt),
		)
		return Math.max(0, worst - before)
	}

	const offsetGaps: number[] = []
	for (let i = 0; i < changes; i++) {
		const offsetHz = (i % 2 === 0 ? 1 : -1) * 6000 * (1 + (i % 5))
		offsetGaps.push(
			await measure("offset", () => demod.reconfigure({ offsetHz })),
		)
	}
	const restartGaps: number[] = []
	for (let i = 0; i < changes; i++) {
		restartGaps.push(
			await measure("restart", () =>
				demod.reconfigure({ gain: i % 2 === 0 ? 5 : 6 }),
			),
		)
	}
	clearInterval(feeder)
	await demod.stop()
	const load = os.loadavg().map(v => v.toFixed(2))
	const row = (name: string, gaps: number[]) =>
		`${name.padEnd(14)} n=${gaps.length} p50=${percentile(gaps, 50).toFixed(1)}ms p90=${percentile(gaps, 90).toFixed(1)}ms max=${Math.max(...gaps).toFixed(1)}ms`
	process.stdout.write(
		[
			row("offset change", offsetGaps),
			row("full restart", restartGaps),
			row("offset stall", stalls.offset),
			row("restart stall", stalls.restart),
			`client disconnects: ${disconnects}`,
			`load average: ${load.join(" ")} (cpus ${os.cpus().length})`,
			"",
		].join("\n"),
	)
}

void main().catch((err: unknown) => {
	process.stderr.write(`live-audio-gap failed: ${String(err)}\n`)
	process.exitCode = 1
})
