/**
 * Analog trial bench (RP.3b, measure only, not CI).
 *
 * One 4 s synthetic NFM capture. `wavekit-iqcap analyze` wall time and child
 * CPU (`/usr/bin/time -p` user+sys) per capture, then the TS tone pass (the
 * runner, audio already in memory) wall time and process CPU. Event-loop
 * delay p99 is sampled during a burst of 6 tone passes. No sockets.
 *
 *   pnpm exec esbuild scripts/bench/analog-trial.ts --bundle --platform=node --format=esm \
 *     --packages=external --outfile=output/bench/analog-trial.mjs
 *   node output/bench/analog-trial.mjs
 */
import { execFileSync, spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { monitorEventLoopDelay } from "node:perf_hooks"
import process from "node:process"
import { PassThrough, type Readable } from "node:stream"
import { fileURLToPath } from "node:url"
import { ToneDetector } from "../../src/core/audio-tones/tone-detector.js"
import { createAnalogTrialRunner } from "../../src/core/iq-capture/analog-trial.js"
import type { IqCapturePort } from "../../src/core/scanner/iq-capture-contract.js"
import { createLogger } from "../../src/utils/logger.js"
import { synthesizeAnalogIq } from "../../tests/mocks/iq/analog-synth.js"

const BINARY = fileURLToPath(
	new URL(
		"../../native/wavekit-chan/target/release/wavekit-iqcap",
		import.meta.url,
	),
)
const BURST = 6
const SECONDS = 4
const logger = createLogger({ level: "fatal", pretty: false })

interface AnalyzeSample {
	wallMs: number
	cpuMs: number | null
	pcm: Buffer
	event: unknown
	code: number | null
}

function main(): Promise<void> {
	const uptime = execFileSync("/usr/bin/uptime", { encoding: "utf8" }).trim()
	console.log(`uptime: ${uptime}`)
	console.log(
		`os.uptime_s ${os.uptime().toFixed(0)} loadavg ${os
			.loadavg()
			.map(n => n.toFixed(2))
			.join(" ")}`,
	)
	if (!existsSync(BINARY)) {
		console.log("wavekit-iqcap release binary is absent; bench skipped")
		return Promise.resolve()
	}
	return run()
}

async function run(): Promise<void> {
	const dir = await mkdtemp(path.join(os.tmpdir(), "wk-analog-bench-"))
	try {
		const iq = synthesizeAnalogIq({
			kind: "nfm-voice",
			snrDb: 15,
			seconds: SECONDS,
			seed: 0xa5a55a5a,
		})
		const file = path.join(dir, "nfm-voice.cf32")
		await writeFile(file, Buffer.from(iq.buffer, iq.byteOffset, iq.byteLength))
		const analyzes: AnalyzeSample[] = []
		for (let i = 0; i < BURST; i++) analyzes.push(await analyzeOnce(file))
		const sample = analyzes[analyzes.length - 1]
		if (!sample || sample.pcm.length === 0) {
			console.log("analyze produced no audio")
			return
		}
		printAnalyzes(analyzes)
		const tones: { wallMs: number; cpuMs: number }[] = []
		for (let i = 0; i < BURST; i++)
			tones.push(await toneOnce(sample.pcm, sample.event))
		printTones(tones)
		await burst(sample.pcm, sample.event)
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
}

function analyzeOnce(file: string): Promise<AnalyzeSample> {
	return new Promise((resolve, reject) => {
		const t0 = performance.now()
		const child = spawn(
			"/usr/bin/time",
			["-p", BINARY, "analyze", "--in", file, "--mode", "nfm"],
			{ stdio: ["ignore", "pipe", "pipe", "ignore", "pipe"] },
		)
		const audio: Buffer[] = []
		const errChunks: Buffer[] = []
		const eventChunks: Buffer[] = []
		child.stdout?.on("data", (chunk: Buffer) => {
			audio.push(chunk)
		})
		child.stderr?.on("data", (chunk: Buffer) => {
			errChunks.push(chunk)
		})
		const eventFd = child.stdio[4]
		if (isReadable(eventFd)) {
			eventFd.on("data", (chunk: Buffer) => {
				eventChunks.push(chunk)
			})
		}
		child.on("error", reject)
		child.on("close", code => {
			const text = Buffer.concat(errChunks).toString("utf8")
			const line =
				Buffer.concat(eventChunks).toString("utf8").trim().split("\n")[0] ?? ""
			let event: unknown = null
			try {
				event = line.length > 0 ? JSON.parse(line) : null
			} catch {
				event = null
			}
			resolve({
				wallMs: performance.now() - t0,
				cpuMs: timeCpuMs(text),
				pcm: Buffer.concat(audio),
				event,
				code,
			})
		})
	})
}

function timeCpuMs(text: string): number | null {
	const user = /^user\s+([0-9.]+)/m.exec(text)
	const sys = /^sys\s+([0-9.]+)/m.exec(text)
	if (user?.[1] === undefined || sys?.[1] === undefined) return null
	const ms = (Number(user[1]) + Number(sys[1])) * 1000
	return Number.isFinite(ms) ? ms : null
}

function isReadable(value: unknown): value is Readable {
	return (
		value !== null &&
		typeof value === "object" &&
		typeof (value as { on?: unknown }).on === "function"
	)
}

async function toneOnce(
	pcm: Buffer,
	event: unknown,
): Promise<{ wallMs: number; cpuMs: number }> {
	const cpu0 = process.cpuUsage()
	const t0 = performance.now()
	await pass(pcm, event)
	const cpu = process.cpuUsage(cpu0)
	return {
		wallMs: performance.now() - t0,
		cpuMs: (cpu.user + cpu.system) / 1000,
	}
}

function pass(pcm: Buffer, event: unknown): Promise<unknown> {
	const runner = createAnalogTrialRunner({
		port: portFor(pcm, event),
		tones: () => new ToneDetector(),
		logger,
	})
	return runner.run("bench", "nfm", new AbortController().signal)
}

function portFor(pcm: Buffer, event: unknown): IqCapturePort {
	return {
		openAnalyze() {
			const audio = new PassThrough()
			audio.end(pcm)
			return {
				audio,
				event: Promise.resolve(event),
				kill() {},
			}
		},
	} as unknown as IqCapturePort
}

async function burst(pcm: Buffer, event: unknown): Promise<void> {
	const histogram = monitorEventLoopDelay({ resolution: 1 })
	histogram.enable()
	const cpu0 = process.cpuUsage()
	const t0 = performance.now()
	await Promise.all(Array.from({ length: BURST }, () => pass(pcm, event)))
	const cpu = process.cpuUsage(cpu0)
	const wallMs = performance.now() - t0
	histogram.disable()
	console.log(
		`burst ${BURST} tone passes wall ${wallMs.toFixed(2)} ms  cpu ${(
			(cpu.user + cpu.system) /
			1000
		).toFixed(2)} ms`,
	)
	console.log(
		`event-loop delay ms p50 ${(histogram.percentile(50) / 1e6).toFixed(3)} p99 ${(histogram.percentile(99) / 1e6).toFixed(3)} max ${(histogram.max / 1e6).toFixed(3)}`,
	)
}

function printAnalyzes(samples: readonly AnalyzeSample[]): void {
	samples.forEach((sample, i) => {
		const frames = frameCount(sample.event)
		console.log(
			`analyze ${i + 1} wall ${sample.wallMs.toFixed(2)} ms  cpu ${
				sample.cpuMs === null ? "-" : sample.cpuMs.toFixed(2)
			} ms  audio_bytes ${sample.pcm.length}  frames ${frames}  exit ${sample.code ?? "-"}`,
		)
	})
}

function printTones(
	samples: readonly { wallMs: number; cpuMs: number }[],
): void {
	samples.forEach((sample, i) => {
		console.log(
			`tone ${i + 1} wall ${sample.wallMs.toFixed(2)} ms  cpu ${sample.cpuMs.toFixed(2)} ms`,
		)
	})
}

function frameCount(event: unknown): number {
	if (event === null || typeof event !== "object") return -1
	const frames = (event as { frames?: unknown }).frames
	return Array.isArray(frames) ? frames.length : -1
}

void main().catch((err: unknown) => {
	const message = err instanceof Error ? err.name : "Error"
	console.log(`bench failed: ${message}`)
	process.exitCode = 1
})
