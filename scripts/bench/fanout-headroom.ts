/**
 * Fanout branch headroom at a full-rate CU8 source.
 *
 * A synthetic CU8 stream (white noise plus one carrier) is paced at the source
 * rate through the real FanoutManager and burst absorber into the two
 * full-rate branches of the default decoder set:
 *
 * - `channelizer`: one `wavekit-chan` process with `--channels` narrowband
 *   channels open (sockets drained), behind the channelizer's input mark.
 * - `live-demod`: one `wavekit-chan` demod channel (the Rust live engine, NFM,
 *   audio socket drained), behind the live-demod branch mark.
 *
 * It prints, per branch: bytes consumed per second against the required rate,
 * child CPU per Msample, queue high-water in bytes and in ms of signal,
 * drop-mode entries and dropped bytes, plus absorber holds, event-loop p99 and
 * the host load average. `--unpaced` instead feeds each consumer alone as fast
 * as it reads, which is its throughput ceiling: headroom = ceiling / required.
 * `--stall-ms N` freezes the consumers' input every second for N ms (SIGSTOP of
 * the child), the scheduler stall a busy VM imposes; it shows how much signal a
 * branch mark absorbs before drop-mode.
 *
 * `--channels 0` leaves the channelizer out, so a live-demod-only run measures
 * the live engine alone; `--live-block N` sets its `--block-samples` (1024 in
 * builds before 2026-10-30, `LIVE_DEMOD_BLOCK_SAMPLES` now).
 *
 * `--hogs N` starts N busy-loop processes for the run (a loaded host);
 * `--readsb-core F` adds an emulated readsb raw IQ branch spending F of a core
 * at the rate (0 turns it off). Each branch reports when it first entered
 * drop-mode and first dropped bytes. `--marks legacy` uses the fixed 256 KiB
 * marks from before 2026-10-30; the default `derived` uses the current ones.
 *
 * Needs a release `wavekit-chan` (make chan-build). No network, no RF:
 *
 *   pnpm exec esbuild scripts/bench/fanout-headroom.ts --bundle \
 *     --platform=node --format=esm --packages=external \
 *     --outfile=output/bench/fanout-headroom.mjs
 *   node output/bench/fanout-headroom.mjs --rate 2400000 --seconds 30
 *   node output/bench/fanout-headroom.mjs --rate 2400000 --unpaced
 *   node output/bench/fanout-headroom.mjs --rate 2400000 --stall-ms 150
 *   node output/bench/fanout-headroom.mjs --rate 1024000 --channels 0 \
 *     --readsb-core 0 --seconds 30
 */
import { spawn, type ChildProcess, execFileSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { connect, type Socket } from "node:net"
import { loadavg } from "node:os"
import { monitorEventLoopDelay, performance } from "node:perf_hooks"
import process from "node:process"
import { createInterface } from "node:readline"
import type { Writable } from "node:stream"
import { setTimeout as sleep } from "node:timers/promises"
import pino from "pino"
import { buildChannelizerArgs } from "../../src/core/channelizer/channelizer-process.js"
import { channelizerInputMark } from "../../src/core/channelizer/channelizer-manager.js"
import {
	DEFAULT_HIGH_WATER_MARK,
	FanoutManager,
	branchHighWaterMark,
} from "../../src/core/fanout-manager.js"
import {
	DECODER_BRANCH_STARTUP_BUFFER_S,
	DECODER_BRANCH_STARTUP_MS,
} from "../../src/decoders/enablement/contract.js"
import { createBurstAbsorber } from "../../src/core/link-burst/absorber.js"
import {
	encodeOpen,
	squelchFor,
} from "../../src/core/live-demod/rust-protocol.js"
import { LiveDemodRuntimeConfigSchema } from "../../src/core/live-demodulator.js"
import { LIVE_DEMOD_BLOCK_SAMPLES } from "../../src/core/live-demod/rust-engine.js"
import { WaveKitError } from "../../src/utils/errors.js"

interface Options {
	binary: string
	rate: number
	seconds: number
	channels: number
	/** `--block-samples` of the live-demod process (1024 before 2026-10-30). */
	liveBlock: number
	chunk: number
	chanMark: number | null
	liveMark: number | null
	absorberSeconds: number
	unpaced: boolean
	stallMs: number
	live: boolean
	/** legacy: every branch 256 KiB; derived: 250 ms of signal (current). */
	marks: "legacy" | "derived"
	/** CPU hog processes started next to the consumers (a loaded host). */
	hogs: number
	/** Core fraction the emulated readsb IQ consumer spends at the rate; 0: off. */
	readsbCore: number
}

function parse(argv: string[]): Options {
	const get = (name: string): string | undefined => {
		const i = argv.indexOf(`--${name}`)
		return i >= 0 ? argv[i + 1] : undefined
	}
	const num = (name: string, fallback: number): number => {
		const raw = get(name)
		const value = raw === undefined ? fallback : Number(raw)
		if (!Number.isFinite(value) || value < 0)
			throw new WaveKitError(
				`--${name} must be a non-negative number`,
				"BENCH_FANOUT_HEADROOM",
			)
		return value
	}
	const mark = (name: string): number | null =>
		get(name) === undefined ? null : num(name, 0)
	return {
		binary: get("binary") ?? "native/wavekit-chan/target/release/wavekit-chan",
		rate: num("rate", 2_400_000),
		seconds: num("seconds", 20),
		channels: num("channels", 4),
		liveBlock: num("live-block", LIVE_DEMOD_BLOCK_SAMPLES),
		// rtl_tcp over TCP arrives in socket reads of up to 64 KiB.
		chunk: num("chunk", 65_536),
		chanMark: mark("chan-mark"),
		liveMark: mark("live-mark"),
		absorberSeconds: num("absorber-s", 2),
		unpaced: argv.includes("--unpaced"),
		stallMs: num("stall-ms", 0),
		live: !argv.includes("--no-live"),
		marks: get("marks") === "legacy" ? "legacy" : "derived",
		hogs: num("hogs", 0),
		readsbCore: num("readsb-core", 0.35),
	}
}

/** One second of CU8: noise around 127.5 plus a carrier at +100 kHz. */
function synthetic(rate: number): Buffer {
	const out = Buffer.allocUnsafe(rate * 2)
	let seed = 0x2545f491
	const noise = () => {
		seed ^= seed << 13
		seed ^= seed >>> 17
		seed ^= seed << 5
		return ((seed >>> 0) / 0xffffffff - 0.5) * 16
	}
	const step = (2 * Math.PI * 100_000) / rate
	for (let n = 0; n < rate; n++) {
		out[2 * n] = Math.max(
			0,
			Math.min(255, 127.5 + 40 * Math.cos(step * n) + noise()),
		)
		out[2 * n + 1] = Math.max(
			0,
			Math.min(255, 127.5 + 40 * Math.sin(step * n) + noise()),
		)
	}
	return out
}

/** Child CPU seconds from ps (user + system of the process). */
function cpuSeconds(pid: number | undefined): number {
	if (pid === undefined) return NaN
	try {
		const raw = execFileSync("ps", ["-o", "time=", "-p", String(pid)], {
			encoding: "utf8",
		}).trim()
		// [[dd-]hh:]mm:ss.cc
		const parts = raw.split(/[-:]/).map(Number)
		return parts.reduce((acc, part) => acc * 60 + part, 0)
	} catch {
		return NaN
	}
}

interface Consumer {
	name: string
	child: ChildProcess
	input: Writable
	outputBytes: () => number
	discontinuities: () => number
	stop: () => Promise<void>
}

async function startChan(
	o: Options,
	name: string,
	opens: (center: number) => string[],
): Promise<Consumer> {
	const dir = mkdtempSync("/tmp/wkpf-")
	const center = 100_000_000
	const args = buildChannelizerArgs({
		binaryPath: o.binary,
		generation: 1,
		inputRateHz: o.rate,
		inputCenterHz: center,
		usableFraction: 0.8,
		blockSamples: name === "live-demod" ? o.liveBlock : 16_384,
		socketDir: dir,
	})
	const child = spawn(o.binary, args, {
		stdio: ["pipe", "pipe", "ignore", "pipe"],
	})
	const control = child.stdio[3] as Writable
	control.on("error", () => undefined)
	child.stdin?.on("error", () => undefined)
	let out = 0
	let gaps = 0
	const sockets: Socket[] = []
	let opened = 0
	const wanted = opens(center)
	const ready = new Promise<void>((resolve, reject) => {
		const timer = setTimeout(
			() =>
				reject(
					new WaveKitError(
						`${name}: no ready/opened events`,
						"BENCH_FANOUT_HEADROOM",
					),
				),
			5000,
		)
		createInterface({ input: child.stdout! }).on("line", line => {
			let e: { type?: string; socket?: string; reasonCode?: string }
			try {
				e = JSON.parse(line) as typeof e
			} catch {
				return
			}
			if (e.type === "ready") for (const req of wanted) control.write(req)
			else if (e.type === "opened" && e.socket) {
				const s = connect(e.socket)
				s.on("data", (chunk: Buffer) => (out += chunk.length))
				s.on("error", () => undefined)
				sockets.push(s)
				if (++opened === wanted.length) {
					clearTimeout(timer)
					resolve()
				}
			} else if (e.type === "rejected") {
				clearTimeout(timer)
				reject(
					new WaveKitError(
						`${name}: open rejected ${e.reasonCode}`,
						"BENCH_FANOUT_HEADROOM",
					),
				)
			} else if (e.type === "discontinuity") gaps++
		})
	})
	try {
		await ready
	} catch (err: unknown) {
		child.kill("SIGKILL")
		rmSync(dir, { recursive: true, force: true })
		throw err
	}
	return {
		name,
		child,
		input: child.stdin!,
		outputBytes: () => out,
		discontinuities: () => gaps,
		async stop() {
			const closed =
				child.exitCode !== null || child.signalCode !== null
					? Promise.resolve()
					: new Promise(resolve => child.once("close", resolve))
			control.end(`${JSON.stringify({ v: 1, type: "shutdown" })}\n`)
			child.stdin?.destroy()
			for (const s of sockets) s.destroy()
			await Promise.race([
				closed,
				sleep(3000).then(() => child.kill("SIGKILL")),
			])
			rmSync(dir, { recursive: true, force: true })
		},
	}
}

/**
 * readsb is not on a dev host: this child stands in for its raw IQ branch. It
 * spends `core` of a core per second of signal (busy-waits per chunk), so its
 * ceiling is 1 / core times real time on an idle core.
 */
function startReadsb(o: Options): Consumer {
	const script = `const f=${o.readsbCore},b=${o.rate * 2};process.stdin.on("data",c=>{const u=performance.now()+(c.length/b)*1000*f;while(performance.now()<u);})`
	const child = spawn(process.execPath, ["-e", script], {
		stdio: ["pipe", "ignore", "ignore"],
	})
	child.stdin?.on("error", () => undefined)
	return {
		name: "readsb-iq",
		child,
		input: child.stdin!,
		outputBytes: () => 0,
		discontinuities: () => 0,
		async stop() {
			child.stdin?.destroy()
			if (child.exitCode !== null || child.signalCode !== null) return
			const closed = new Promise(resolve => child.once("close", resolve))
			child.kill("SIGKILL")
			await Promise.race([closed, sleep(3000)])
		},
	}
}

function startHogs(n: number): ChildProcess[] {
	return Array.from({ length: n }, () =>
		spawn(process.execPath, ["-e", "for(;;){}"], { stdio: "ignore" }),
	)
}

function channelOpens(n: number): (center: number) => string[] {
	return center =>
		Array.from(
			{ length: n },
			(_, i) =>
				`${JSON.stringify({
					v: 1,
					type: "open",
					id: `ch${i}`,
					centerHz: center - 300_000 + i * 25_000,
					bandwidthHz: 12_500,
					transitionHz: 5_000,
					outputRateHz: 48_000,
					format: "cu8",
					queueBytes: 1 << 20,
				})}\n`,
		)
}

function demodOpen(center: number): string[] {
	// The production encoder over a parsed default NFM config, squelch off.
	const config = LiveDemodRuntimeConfigSchema.parse({
		enabled: true,
		modulation: "nfm",
		bandwidth: 12_500,
		squelchMode: "manual",
		squelch: 0,
	})
	return [
		encodeOpen({
			config,
			centerHz: center + 100_000,
			squelch: squelchFor(config, 0),
		}),
	]
}

async function startConsumers(o: Options): Promise<Consumer[]> {
	const consumers =
		o.channels > 0
			? [await startChan(o, "channelizer", channelOpens(o.channels))]
			: []
	if (o.live) consumers.push(await startChan(o, "live-demod", demodOpen))
	if (o.readsbCore > 0) consumers.push(startReadsb(o))
	return consumers
}

/** Throughput ceiling of one consumer fed alone as fast as it reads. */
async function unpaced(o: Options, c: Consumer, data: Buffer): Promise<number> {
	const cpu0 = cpuSeconds(c.child.pid)
	const t0 = performance.now()
	let written = 0
	const end = t0 + o.seconds * 1000
	let offset = 0
	while (performance.now() < end) {
		const chunk = data.subarray(offset, offset + o.chunk)
		offset = (offset + o.chunk) % data.length
		written += chunk.length
		if (!c.input.write(chunk))
			await new Promise(resolve => c.input.once("drain", resolve))
	}
	const seconds = (performance.now() - t0) / 1000
	const cpu = cpuSeconds(c.child.pid) - cpu0
	const samples = written / 2
	console.log(
		JSON.stringify({
			mode: "unpaced",
			branch: c.name,
			rate: o.rate,
			channels: c.name === "channelizer" ? o.channels : 1,
			msps: +(samples / seconds / 1e6).toFixed(3),
			headroom: +(samples / seconds / o.rate).toFixed(2),
			cpuSecondsPerMsample: +(cpu / (samples / 1e6)).toFixed(4),
			coreAtRate: +((cpu / (samples / 1e6)) * (o.rate / 1e6)).toFixed(3),
		}),
	)
	return samples / seconds / o.rate
}

async function paced(o: Options, consumers: Consumer[], data: Buffer) {
	const log = pino({ level: "silent" })
	const fanout = new FanoutManager(log)
	const absorber = createBurstAbsorber({
		fanout,
		recorder: null,
		monoNow: () => performance.now(),
		frameBytes: 2,
		log,
	})
	absorber.configure(o.absorberSeconds * o.rate * 2)
	// Legacy: the fixed 256 KiB marks before 2026-10-30. Derived: the marks the
	// core now computes (channelizer and live-demod from caps; a decoder branch
	// from the fanout byte rate, once the source router calls setByteRate).
	const legacy = o.marks === "legacy"
	if (!legacy) fanout.setByteRate(o.rate * 2)
	const marks: Record<string, number> = {
		channelizer:
			o.chanMark ??
			(legacy
				? DEFAULT_HIGH_WATER_MARK
				: channelizerInputMark(DEFAULT_HIGH_WATER_MARK, o.rate)),
		"live-demod":
			o.liveMark ??
			(legacy ? DEFAULT_HIGH_WATER_MARK : branchHighWaterMark(o.rate * 2)),
	}
	const high = new Map<string, number>()
	const firstEntry = new Map<string, number>()
	const firstDrop = new Map<string, number>()
	fanout.on("backpressure", (id: string) => {
		if (!firstEntry.has(id)) firstEntry.set(id, performance.now())
	})
	for (const c of consumers) {
		const mark = marks[c.name]
		const decoder = c.name === "readsb-iq"
		const branch = fanout.addBranch({
			id: c.name,
			...(mark !== undefined ? { highWaterMark: mark } : {}),
			...(decoder ? { deferred: true } : {}),
		})
		branch.pipe(c.input)
		// The decoder manager's shape: deferred, then a 1.5 s startup buffer for 5 s.
		if (decoder)
			fanout.activateBranch(c.name, {
				highWaterMark: Math.ceil(o.rate * 2 * DECODER_BRANCH_STARTUP_BUFFER_S),
				durationMs: DECODER_BRANCH_STARTUP_MS,
			})
		high.set(c.name, 0)
	}
	const cpu0 = consumers.map(c => cpuSeconds(c.child.pid))
	const loop = monitorEventLoopDelay({ resolution: 5 })
	loop.enable()
	const bytesPerMs = (o.rate * 2) / 1000
	const t0 = performance.now()
	let sent = 0
	let offset = 0
	let lastStall = t0
	let stalls = 0
	while (performance.now() - t0 < o.seconds * 1000) {
		const now = performance.now()
		if (o.stallMs > 0 && now - lastStall >= 1000) {
			lastStall = now
			stalls++
			for (const c of consumers) c.child.kill("SIGSTOP")
			setTimeout(() => {
				for (const c of consumers) c.child.kill("SIGCONT")
			}, o.stallMs).unref()
		}
		const due = Math.floor(((now - t0) * bytesPerMs) / 2) * 2
		while (sent + o.chunk <= due) {
			const chunk = data.subarray(offset, offset + o.chunk)
			offset = (offset + o.chunk) % data.length
			absorber.ingest(chunk)
			sent += o.chunk
			for (const t of fanout.getTelemetrySnapshot().branches) {
				high.set(t.id, Math.max(high.get(t.id) ?? 0, t.bufferBytes))
				if (t.droppedBytesTotal > 0 && !firstDrop.has(t.id))
					firstDrop.set(t.id, performance.now())
			}
		}
		await sleep(5)
	}
	await sleep(300)
	loop.disable()
	const elapsed = (performance.now() - t0) / 1000
	const snap = fanout.getTelemetrySnapshot()
	const stats = absorber.counters()
	for (const [i, c] of consumers.entries()) {
		const t = snap.branches.find(b => b.id === c.name)
		const cpu = cpuSeconds(c.child.pid) - (cpu0[i] ?? NaN)
		const consumed = (t?.totalBytesWritten ?? 0) - (t?.droppedBytesTotal ?? 0)
		const hw = high.get(c.name) ?? 0
		console.log(
			JSON.stringify({
				mode: "paced",
				branch: c.name,
				rate: o.rate,
				channels: c.name === "channelizer" ? o.channels : 1,
				stallMs: o.stallMs,
				stalls,
				highWaterMark: t?.highWaterMark,
				markMs: +(((t?.highWaterMark ?? 0) / (o.rate * 2)) * 1000).toFixed(1),
				requiredBytesPerS: o.rate * 2,
				consumedBytesPerS: Math.round(consumed / elapsed),
				queueHighWaterBytes: hw,
				queueHighWaterMs: +((hw / (o.rate * 2)) * 1000).toFixed(1),
				dropModeEntries: t?.backpressureEnterCount ?? 0,
				firstDropModeS: firstEntry.has(c.name)
					? +(((firstEntry.get(c.name) ?? t0) - t0) / 1000).toFixed(2)
					: null,
				firstDropS: firstDrop.has(c.name)
					? +(((firstDrop.get(c.name) ?? t0) - t0) / 1000).toFixed(2)
					: null,
				droppedBytes: t?.droppedBytesTotal ?? 0,
				discontinuities: c.discontinuities(),
				cpuCores: +(cpu / elapsed).toFixed(3),
				cpuSecondsPerMsample: +(cpu / (consumed / 2 / 1e6)).toFixed(4),
			}),
		)
	}
	console.log(
		JSON.stringify({
			mode: "paced",
			summary: true,
			seconds: +elapsed.toFixed(1),
			marks: o.marks,
			hogs: o.hogs,
			chunk: o.chunk,
			absorber: stats,
			loopP99Ms: +(loop.percentile(99) / 1e6).toFixed(2),
			loopMaxMs: +(loop.max / 1e6).toFixed(2),
			loadavg: loadavg().map(v => +v.toFixed(2)),
		}),
	)
	absorber.dispose()
	fanout.destroy()
}

async function main(): Promise<void> {
	const o = parse(process.argv.slice(2))
	const data = synthetic(o.rate)
	const consumers = await startConsumers(o)
	const hogs = startHogs(o.hogs)
	try {
		if (o.unpaced) for (const c of consumers) await unpaced(o, c, data)
		else await paced(o, consumers, data)
	} finally {
		for (const h of hogs) h.kill("SIGKILL")
		for (const c of consumers) await c.stop()
	}
}

await main()
