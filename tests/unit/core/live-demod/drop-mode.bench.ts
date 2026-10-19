/**
 * Drop-mode harness for the live IQ fanout. Not a vitest file
 * (`vitest` collects `tests/**\/*.test.ts` only).
 *
 * Run (tsx is not a project dependency; vite-node --script keeps the path in argv):
 *   node <vite-node> --script tests/unit/core/live-demod/drop-mode.bench.ts --
 *   [--duration 60] [--consumers rust,sink,dsd,multimon,csdr-live]
 *   [--sink-delay-us N] [--chunk-bytes 16384]
 *
 * Default: 60 s Rust live-demod consumer, then a 60 s sink-delay sweep.
 * The fake rtl_tcp listens on 127.0.0.1 port 0 only.
 *
 * csdr is not installed on this Mac. Decoder commands are still built by the
 * real AudioDemodDecoder subclasses and printed. A requested dsd / multimon /
 * csdr-live consumer without csdr uses a boxcar substitute (cost stated below);
 * that substitute is not a measurement of csdr.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process"
import { once } from "node:events"
import { existsSync } from "node:fs"
import net from "node:net"
import { loadavg } from "node:os"
import { join } from "node:path"
import { Writable } from "node:stream"
import {
	LiveDemodConfigSchema,
	type SourceConfig,
} from "../../../../src/config.js"
import { FanoutManager } from "../../../../src/core/fanout-manager.js"
import {
	liveDemodRates,
	planLiveDemodPipeline,
} from "../../../../src/core/live-demod-pipeline.js"
import { RustEngine } from "../../../../src/core/live-demod/rust-engine.js"
import { SourceManager } from "../../../../src/core/source-manager.js"
import { audioDemodRates } from "../../../../src/decoders/audio-demod-decoder.js"
import { DsdFmeDecoder } from "../../../../src/decoders/builtin/dsd-fme.js"
import { MultimonDecoder } from "../../../../src/decoders/builtin/multimon-ng.js"
import { channelFilterPlan } from "../../../../src/decoders/csdr-stages.js"
import type {
	DecoderConfig,
	DemodulationConfig,
} from "../../../../src/decoders/types.js"
import { createLogger } from "../../../../src/utils/logger.js"

const FS = 2_048_000
const BYTES_PER_SECOND = FS * 2
const HWM = 256 * 1024
const FORBIDDEN_PORTS = new Set([9000, 5173, 8081, 8082, 15555, 15556, 18080])
const SWEEP_US = [0, 1000, 2000, 3000, 3500, 4000, 4200, 4500, 5000, 8000]
const BINARY = join(
	process.cwd(),
	"native/wavekit-chan/target/release/wavekit-chan",
)

const PROPOSED_DIFF = `diff --git a/src/decoders/manager.ts b/src/decoders/manager.ts
--- a/src/decoders/manager.ts
+++ b/src/decoders/manager.ts
@@ channelRequestFor
-		if (!this.channelizer || state.config.useChannelizer !== true || !caps)
-			return undefined
+		// dsd-fme and multimon-ng on the raw fanout each run a csdr convert +
+		// firdecimate (multimon also a complex AGC) at the capture rate. At
+		// 2.048 Msps that is tens of MAC/sample on a 256 KiB branch (~64 ms).
+		// Route them through the channelizer channel at the demod rate whenever
+		// a channelizer is up, including when useChannelizer is omitted. An
+		// explicit false stays on the raw branch. ChannelizerManager exists
+		// only when config.channelizer.enabled is true (src/index.ts); with it
+		// off, this.channelizer is null and the raw branch is unchanged.
+		// Raising the 256 KiB highWaterMark is not the fix: any finite buffer
+		// fills when the branch is slower than the source.
+		const audioFront =
+			state.config.type === "dsd-fme" || state.config.type === "multimon-ng"
+		const opted =
+			state.config.useChannelizer === true ||
+			(state.config.useChannelizer !== false && audioFront)
+		if (!this.channelizer || !opted || !caps) return undefined
`

class CommandDsd extends DsdFmeDecoder {
	shell(): string {
		return this.buildPipelineCommand()
	}
	demod(): DemodulationConfig {
		return this.boundedDemodConfig()
	}
}

class CommandMultimon extends MultimonDecoder {
	shell(): string {
		return this.buildPipelineCommand()
	}
	demod(): DemodulationConfig {
		return this.boundedDemodConfig()
	}
}

interface Args {
	durationSec: number
	chunkBytes: number
	consumers: Set<string>
	sinkDelayUs: number | undefined
}

interface BranchReport {
	id: string
	bytesIn: number
	bytesDelivered: number
	bytesOut: number
	backpressureEntries: number
	droppedBytes: number
}

interface TrialReport {
	label: string
	elapsedSec: number
	pacedBytes: number
	branches: BranchReport[]
}

function mainGuard(): boolean {
	return (process.argv[1] ?? "").includes("drop-mode.bench")
}

if (mainGuard()) {
	main().catch((err: unknown) => {
		console.error(err instanceof Error ? err.stack : err)
		process.exitCode = 1
	})
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2))
	console.log(loadLine("start"))
	console.log(diagnosis())
	console.log(PROPOSED_DIFF)
	if (args.consumers.has("rust")) {
		console.log(`\n=== rust consumer ${args.durationSec}s ===`)
		const report = await runSession({
			durationSec: args.durationSec,
			chunkBytes: args.chunkBytes,
			consumers: new Set(["rust"]),
			sinkDelayUs: 0,
			label: "rust",
		})
		printTrial(report)
	}
	if (args.consumers.has("sink")) {
		if (args.sinkDelayUs !== undefined) {
			console.log(`\n=== sink delay ${args.sinkDelayUs} us ===`)
			const report = await runSession({
				durationSec: args.durationSec,
				chunkBytes: args.chunkBytes,
				consumers: new Set(["sink"]),
				sinkDelayUs: args.sinkDelayUs,
				label: `sink-${args.sinkDelayUs}us`,
			})
			printTrial(report)
		} else {
			await sweep(args)
		}
	}
	for (const name of ["dsd", "multimon", "csdr-live"] as const) {
		if (!args.consumers.has(name)) continue
		console.log(`\n=== ${name} consumer ${args.durationSec}s ===`)
		const report = await runSession({
			durationSec: args.durationSec,
			chunkBytes: args.chunkBytes,
			consumers: new Set([name]),
			sinkDelayUs: 0,
			label: name,
		})
		printTrial(report)
	}
	console.log(loadLine("end"))
	process.exit(process.exitCode ?? 0)
}

function parseArgs(argv: string[]): Args {
	let durationSec = 60
	let chunkBytes = 16384
	let consumers: Set<string> | null = null
	let sinkDelayUs: number | undefined
	const known = new Set(["rust", "sink", "dsd", "multimon", "csdr-live"])
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i]
		const next = argv[i + 1]
		if (flag === "--duration" && next !== undefined) {
			durationSec = Number(next)
			i++
		} else if (flag === "--chunk-bytes" && next !== undefined) {
			chunkBytes = Number(next)
			i++
		} else if (flag === "--consumers" && next !== undefined) {
			consumers = new Set(next.split(",").filter(part => part.length > 0))
			i++
		} else if (flag === "--sink-delay-us" && next !== undefined) {
			sinkDelayUs = Number(next)
			i++
		} else if (flag === "--") {
			continue
		} else if (flag === "--help") {
			console.log(
				"flags: --duration 60 --consumers rust,sink,dsd,multimon,csdr-live --sink-delay-us N --chunk-bytes 16384",
			)
			process.exit(0)
		} else {
			throw new Error(`unknown argument ${flag ?? ""}`)
		}
	}
	if (!Number.isFinite(durationSec) || durationSec <= 0) {
		throw new Error("--duration must be a positive number of seconds")
	}
	if (!Number.isInteger(chunkBytes) || chunkBytes < 2 || chunkBytes % 2 !== 0) {
		throw new Error("--chunk-bytes must be a positive even integer")
	}
	if (
		sinkDelayUs !== undefined &&
		(!Number.isFinite(sinkDelayUs) || sinkDelayUs < 0)
	) {
		throw new Error("--sink-delay-us must be >= 0")
	}
	const selected = consumers ?? new Set(["rust", "sink"])
	for (const name of selected) {
		if (!known.has(name)) throw new Error(`unknown consumer ${name}`)
	}
	return { durationSec, chunkBytes, consumers: selected, sinkDelayUs }
}

async function sweep(args: Args): Promise<void> {
	const each = args.durationSec / SWEEP_US.length
	console.log(
		`\n=== sink sweep ${args.durationSec}s total, ${SWEEP_US.length} delays, ${each.toFixed(3)}s each, chunk ${args.chunkBytes} ===`,
	)
	console.log(
		`source ${BYTES_PER_SECOND} B/s, chunk time ${((args.chunkBytes / BYTES_PER_SECOND) * 1000).toFixed(3)} ms, HWM ${HWM} bytes (${((HWM / BYTES_PER_SECOND) * 1000).toFixed(1)} ms)`,
	)
	const rows: Array<TrialReport & { delayUs: number; drainBps: number }> = []
	for (const delayUs of SWEEP_US) {
		const report = await runSession({
			durationSec: each,
			chunkBytes: args.chunkBytes,
			consumers: new Set(["sink"]),
			sinkDelayUs: delayUs,
			label: `sink-${delayUs}us`,
		})
		const drainBps =
			delayUs === 0
				? Number.POSITIVE_INFINITY
				: args.chunkBytes / (delayUs / 1e6)
		rows.push({ ...report, delayUs, drainBps })
		printTrial(report, ` drain_Bps=${formatRate(drainBps)}`)
	}
	const entered = rows.filter(row =>
		row.branches.some(
			branch => branch.backpressureEntries > 0 || branch.droppedBytes > 0,
		),
	)
	const clean = rows.filter(row => !entered.includes(row))
	const slowestClean = clean.reduce<(typeof rows)[number] | undefined>(
		(best, row) =>
			best === undefined || row.delayUs > best.delayUs ? row : best,
		undefined,
	)
	const fastestDrop = entered.reduce<(typeof rows)[number] | undefined>(
		(best, row) =>
			best === undefined || row.delayUs < best.delayUs ? row : best,
		undefined,
	)
	console.log(
		`sweep threshold: highest delay with no drop-mode ${slowestClean ? `${slowestClean.delayUs} us (${formatRate(slowestClean.drainBps)} B/s)` : "none"}; lowest delay that entered drop-mode ${fastestDrop ? `${fastestDrop.delayUs} us (${formatRate(fastestDrop.drainBps)} B/s)` : "none"}`,
	)
}

function formatRate(bps: number): string {
	if (!Number.isFinite(bps)) return "unbounded"
	return bps.toFixed(0)
}

async function runSession(input: {
	durationSec: number
	chunkBytes: number
	consumers: Set<string>
	sinkDelayUs: number
	label: string
}): Promise<TrialReport> {
	const logger = createLogger({ level: "fatal" })
	const fake = await listenLoop()
	const manager = new SourceManager(logger)
	const fanout = new FanoutManager(logger)
	const engineSlots: RustEngine[] = []
	const children: ChildProcess[] = []
	const sinks: Writable[] = []
	const outs = new Map<string, () => number>()
	let paced = 0
	let elapsedSec = 0
	let branches: BranchReport[] = []
	try {
		const socketPromise = fake.connected
		const config: SourceConfig = {
			id: "drop-bench",
			type: "rtl_tcp",
			host: "127.0.0.1",
			port: fake.port,
			loop: false,
			playbackSpeed: 1,
			stallTimeoutMs: 0,
			caps: {
				kind: "iq",
				sampleRate: FS,
				format: "U8_IQ",
				centerFreq: 100_000_000,
				exclusive: false,
			},
		}
		const sourceStream = await manager.connect(config)
		const socket = await socketPromise
		socket.on("error", () => undefined)

		const add = (id: string): ReturnType<FanoutManager["addBranch"]> =>
			fanout.addBranch({ id, highWaterMark: HWM, sourceId: "drop-bench" })

		if (input.consumers.has("rust")) {
			if (!existsSync(BINARY)) {
				throw new Error(
					"release binary native/wavekit-chan/target/release/wavekit-chan is absent; build with cargo build --release --locked --offline --manifest-path native/wavekit-chan/Cargo.toml",
				)
			}
			const branch = add("rust")
			const engine = new RustEngine({
				binaryPath: BINARY,
				logger,
				probeTimeoutMs: 2000,
				openTimeoutMs: 2000,
				stopKillMs: 2000,
			})
			engineSlots.push(engine)
			let audio = 0
			const started = await engine.start({
				config: LiveDemodConfigSchema.parse({
					engine: "rust",
					modulation: "nfm",
					bandwidth: 12500,
					squelch: 0,
					gain: 2,
					audioFormat: "s16le",
				}),
				caps: config.caps,
				input: branch,
				squelch: { mode: "off" },
				handlers: {
					onAudio: chunk => {
						audio += chunk.length
					},
					onGate: () => undefined,
					onMetrics: () => undefined,
					onDown: () => undefined,
				},
			})
			if (!started.ok) {
				throw new Error(`rust engine did not open: ${JSON.stringify(started)}`)
			}
			outs.set("rust", () => audio)
		}

		if (input.consumers.has("sink")) {
			const branch = add("sink")
			const sink = new DelaySink(input.sinkDelayUs / 1000, input.chunkBytes)
			sinks.push(sink)
			branch.pipe(sink)
			outs.set("sink", () => sink.bytesOut)
		}

		const csdr = csdrPath()
		for (const name of ["dsd", "multimon", "csdr-live"] as const) {
			if (!input.consumers.has(name)) continue
			const branch = add(name)
			const command = frontCommand(name)
			if (csdr) {
				const shell = replaceTail(
					command,
					"dd bs=65536 of=/dev/null status=none",
				)
				console.log(`spawn ${name}: ${shell}`)
				const child = spawn("/bin/sh", ["-c", shell], {
					detached: true,
					stdio: ["pipe", "ignore", "pipe"],
				})
				children.push(child)
				child.stderr?.resume()
				child.on("error", () => undefined)
				if (child.stdin) branch.pipe(child.stdin)
				outs.set(name, () => 0)
			} else {
				const decimation = decimationOf(name)
				console.log(
					`csdr absent; ${name} substitute is a boxcar of ${decimation} (one add per complex sample, then a reset). Not a channel FIR and not a csdr drop measurement. Command that would have run: ${command}`,
				)
				const sink = new BoxcarSink(decimation)
				sinks.push(sink)
				branch.pipe(sink)
				outs.set(name, () => sink.bytesOut)
			}
		}

		fanout.attachSource(sourceStream)
		const pace = await paceSocket(socket, input.durationSec, input.chunkBytes)
		paced = pace.bytes
		elapsedSec = pace.elapsedSec
	} finally {
		branches = snapshotBranches(fanout, outs)
		for (const engine of engineSlots) await engine.stop()
		for (const child of children) killGroup(child)
		for (const sink of sinks) sink.destroy()
		fanout.detachSource()
		for (const id of fanout.getBranchIds()) fanout.removeBranch(id)
		await manager.disconnectAll()
		await new Promise<void>(resolve => fake.server.close(() => resolve()))
	}
	return { label: input.label, elapsedSec, pacedBytes: paced, branches }
}

function snapshotBranches(
	fanout: FanoutManager,
	outs: Map<string, () => number>,
): BranchReport[] {
	const branches: BranchReport[] = []
	for (const [id, readOut] of outs) {
		const telemetry = fanout.getBranchTelemetry(id)
		const bytesIn = telemetry?.totalBytesWritten ?? 0
		const dropped = telemetry?.droppedBytesTotal ?? 0
		branches.push({
			id,
			bytesIn,
			bytesDelivered: bytesIn - dropped,
			bytesOut: readOut(),
			backpressureEntries: telemetry?.backpressureEnterCount ?? 0,
			droppedBytes: dropped,
		})
	}
	return branches
}

function printTrial(report: TrialReport, extra = ""): void {
	const hours = report.elapsedSec / 3600
	console.log(
		`${report.label} elapsed_s=${report.elapsedSec.toFixed(3)} paced_bytes=${report.pacedBytes}${extra}`,
	)
	for (const branch of report.branches) {
		const perHour = (n: number) => (hours > 0 ? n / hours : 0)
		console.log(
			`  ${branch.id} bytes_in=${branch.bytesIn} bytes_delivered=${branch.bytesDelivered} bytes_out=${branch.bytesOut} backpressure_entries=${branch.backpressureEntries} dropped_bytes=${branch.droppedBytes} backpressure_per_hour=${perHour(branch.backpressureEntries).toFixed(1)} dropped_bytes_per_hour=${perHour(branch.droppedBytes).toFixed(0)}`,
		)
	}
}

class DelaySink extends Writable {
	bytesOut = 0
	private readonly timers = new Set<ReturnType<typeof setTimeout>>()
	constructor(
		private readonly delayMs: number,
		highWaterMark: number,
	) {
		super({ highWaterMark })
		this.on("close", () => {
			for (const timer of this.timers) clearTimeout(timer)
			this.timers.clear()
		})
	}
	override _write(
		chunk: Buffer,
		_encoding: BufferEncoding,
		callback: (error?: Error | null) => void,
	): void {
		this.bytesOut += chunk.length
		const timer = setTimeout(() => {
			this.timers.delete(timer)
			if (!this.destroyed) callback()
		}, this.delayMs)
		this.timers.add(timer)
	}
}

/** Cheap stand-in when csdr is not installed. Cost: one add per complex sample. */
class BoxcarSink extends Writable {
	bytesOut = 0
	private acc = 0
	private count = 0
	constructor(private readonly decimation: number) {
		super({ highWaterMark: 16 * 1024 })
	}
	override _write(
		chunk: Buffer,
		_encoding: BufferEncoding,
		callback: (error?: Error | null) => void,
	): void {
		this.bytesOut += chunk.length
		const pairs = chunk.length >> 1
		for (let i = 0; i < pairs; i++) {
			this.acc += (chunk[i * 2] ?? 0) / 127.5 - 1
			this.count += 1
			if (this.count >= this.decimation) {
				this.acc = 0
				this.count = 0
			}
		}
		callback()
	}
}

async function listenLoop(): Promise<{
	server: net.Server
	port: number
	connected: Promise<net.Socket>
}> {
	for (let attempt = 0; attempt < 8; attempt++) {
		const opened = await listenOnce()
		if (!FORBIDDEN_PORTS.has(opened.port)) return opened
		await new Promise<void>(resolve => opened.server.close(() => resolve()))
	}
	throw new Error("listen(0) kept returning a protected port")
}

function listenOnce(): Promise<{
	server: net.Server
	port: number
	connected: Promise<net.Socket>
}> {
	return new Promise((resolve, reject) => {
		let settle: (socket: net.Socket) => void = () => undefined
		const connected = new Promise<net.Socket>(resolveSocket => {
			settle = resolveSocket
		})
		const server = net.createServer(socket => {
			socket.on("error", () => undefined)
			socket.on("data", () => undefined)
			const header = Buffer.alloc(12)
			header.write("RTL0", 0, "ascii")
			header.writeUInt32BE(5, 4)
			header.writeUInt32BE(29, 8)
			socket.write(header)
			settle(socket)
		})
		server.once("error", reject)
		server.listen(0, "127.0.0.1", () => {
			const address = server.address()
			if (address === null || typeof address === "string") {
				reject(new Error("fake rtl_tcp did not bind a port"))
				return
			}
			resolve({ server, port: address.port, connected })
		})
	})
}

async function paceSocket(
	socket: net.Socket,
	durationSec: number,
	chunkBytes: number,
): Promise<{ bytes: number; elapsedSec: number }> {
	const chunk = Buffer.alloc(chunkBytes, 128)
	const total = Math.floor(BYTES_PER_SECOND * durationSec)
	const start = process.hrtime.bigint()
	let sent = 0
	let nextLog = 15
	while (sent < total && !socket.destroyed) {
		const elapsed = Number(process.hrtime.bigint() - start) / 1e9
		if (elapsed >= nextLog) {
			console.log(`  pace ${elapsed.toFixed(0)}s ${sent}/${total}`)
			nextLog += 15
		}
		const allowed = elapsed * BYTES_PER_SECOND
		if (sent > allowed) {
			const waitMs = ((sent - allowed) / BYTES_PER_SECOND) * 1000
			await delay(waitMs > 2 ? Math.min(waitMs - 0.5, 20) : 0)
			continue
		}
		const n = Math.min(chunkBytes, total - sent)
		const piece = n === chunk.length ? chunk : chunk.subarray(0, n)
		let ok = true
		try {
			ok = socket.write(piece)
		} catch {
			break
		}
		sent += n
		if (!ok) {
			await Promise.race([
				once(socket, "drain").then(() => undefined),
				delay(1000),
			]).catch(() => undefined)
		}
		await new Promise<void>(resolve => setImmediate(resolve))
	}
	const elapsedSec = Number(process.hrtime.bigint() - start) / 1e9
	return { bytes: sent, elapsedSec }
}

function delay(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms))
}

function killGroup(child: ChildProcess): void {
	const pid = child.pid
	if (pid === undefined) return
	try {
		process.kill(-pid, "SIGKILL")
	} catch {
		try {
			child.kill("SIGKILL")
		} catch {
			// already gone
		}
	}
}

function csdrPath(): string | null {
	try {
		const out = execFileSync("which", ["csdr"], { encoding: "utf8" }).trim()
		return out.length > 0 ? out : null
	} catch {
		return null
	}
}

function decoderConfig(type: string): DecoderConfig {
	return {
		id: `${type}-bench`,
		type,
		enabled: false,
		options: { inputSampleRate: FS },
	}
}

function fronts(): { dsd: CommandDsd; multimon: CommandMultimon } {
	const logger = createLogger({ level: "fatal" })
	return {
		dsd: new CommandDsd(decoderConfig("dsd-fme"), logger),
		multimon: new CommandMultimon(decoderConfig("multimon-ng"), logger),
	}
}

function frontCommand(name: "dsd" | "multimon" | "csdr-live"): string {
	const built = fronts()
	if (name === "dsd") return built.dsd.shell()
	if (name === "multimon") return built.multimon.shell()
	const config = LiveDemodConfigSchema.parse({
		modulation: "nfm",
		bandwidth: 12500,
		squelch: 0,
		gain: 2,
		audioFormat: "s16le",
	})
	const rates = liveDemodRates(FS, config)
	const plan = planLiveDemodPipeline({
		config,
		iqSampleRate: FS,
		iqFormat: "U8_IQ",
		decimation: rates.decimation,
		logger: { info: () => undefined },
	})
	return `${plan.front} | ${plan.back}`
}

function decimationOf(name: "dsd" | "multimon" | "csdr-live"): number {
	if (name === "csdr-live") {
		const config = LiveDemodConfigSchema.parse({
			modulation: "nfm",
			bandwidth: 12500,
		})
		return liveDemodRates(FS, config).decimation
	}
	const built = fronts()
	const demod = name === "dsd" ? built.dsd.demod() : built.multimon.demod()
	return audioDemodRates(demod).decimation
}

function replaceTail(command: string, tail: string): string {
	const parts = command.split(" | ")
	parts[parts.length - 1] = tail
	return parts.join(" | ")
}

function countCsdr(command: string): number {
	return command
		.split(" | ")
		.filter(stage => stage.trimStart().startsWith("csdr")).length
}

function diagnosis(): string {
	const built = fronts()
	const dsd = describeDecoder(
		"dsd-fme",
		built.dsd.shell(),
		built.dsd.demod(),
		false,
	)
	const multimon = describeDecoder(
		"multimon-ng",
		built.multimon.shell(),
		built.multimon.demod(),
		true,
	)
	const liveConfig = LiveDemodConfigSchema.parse({
		modulation: "nfm",
		bandwidth: 12500,
		squelch: 0,
		gain: 2,
		audioFormat: "s16le",
	})
	const liveRates = liveDemodRates(FS, liveConfig)
	const livePlan = planLiveDemodPipeline({
		config: liveConfig,
		iqSampleRate: FS,
		iqFormat: "U8_IQ",
		decimation: liveRates.decimation,
		logger: { info: () => undefined },
	})
	const liveCommand = `${livePlan.front} | ${livePlan.back}`
	const liveTaps = channelFilterPlan(FS, liveRates.decimation, 12500)
	const lines = [
		`csdr: ${csdrPath() ?? "ABSENT (which csdr failed). Decoder-chain drop behaviour is not measured. Substitute, if requested, is a boxcar: one add per complex sample."}`,
		dsd,
		multimon,
		describeLive(
			liveCommand,
			liveRates.decimation,
			liveRates.effectiveSampleRate,
			liveTaps.taps,
		),
		"HWM 256 KiB is 64.0 ms of 2.048 Msps cu8 (4_096_000 B/s). A branch slower than the source fills any finite HWM and then drop-mode sheds every later chunk until drain. The fix is to stop the full-rate firdecimate (and multimon's full-rate complex AGC) on each raw decoder branch.",
		"Proposed fix (not applied): opt dsd-fme and multimon-ng into the existing channelizer channel unless useChannelizer is explicitly false. The channel IQ path already nulls convert/shift/decimate and starts at fmdemod. config.channelizer.enabled must be true or DecoderManager.channelizer stays null and the raw branch is unchanged. ARCHITECTURE.md marks useChannelizer as an unverified prototype.",
	]
	return lines.join("\n")
}

function describeDecoder(
	name: string,
	command: string,
	config: DemodulationConfig,
	fullRateAgc: boolean,
): string {
	const rates = audioDemodRates(config)
	const taps =
		config.filterTransition !== undefined
			? Math.floor(4 / config.filterTransition) | 1
			: channelFilterPlan(
					rates.inputSampleRate,
					rates.decimation,
					config.bandwidth,
				).taps
	return describeWork(
		name,
		command,
		rates.decimation,
		rates.actualDemodRate,
		taps,
		fullRateAgc,
	)
}

function describeLive(
	command: string,
	decimation: number,
	actualRate: number,
	taps: number,
): string {
	return describeWork("csdr-live", command, decimation, actualRate, taps, false)
}

function describeWork(
	name: string,
	command: string,
	decimation: number,
	actualRate: number,
	taps: number,
	fullRateAgc: boolean,
): string {
	const complexMacPerInput = taps / decimation
	// A decimating FIR does `taps` MACs per output sample, so MAC/s = taps * output rate.
	const complexMacPerSec = (taps * FS) / decimation
	const demodFlopPerSample = 10
	const demodFlopPerSec = demodFlopPerSample * actualRate
	const processes = countCsdr(command)
	const agc = fullRateAgc
		? ` Full-rate complex AGC is an extra csdr process at ${FS} sps (a few flops/sample plus a ${FS * 8} B/s float pipe) before the FIR.`
		: ""
	return [
		`${name} command: ${command}`,
		`${name} csdr_processes=${processes} decimation=${decimation} demod_hz=${actualRate.toFixed(3)} fir_taps=${taps} at_${FS}_sps: complex_MAC_per_captured_sample=${complexMacPerInput.toFixed(2)} complex_MAC_per_s=${complexMacPerSec.toFixed(0)}`,
		`${name} at decimated channel IQ (${actualRate.toFixed(0)} Hz cf32) convert/shift/firdecimate are null, so FIR MAC/sample=0. fmdemod is about ${demodFlopPerSample} flop/sample (~${demodFlopPerSec.toFixed(0)} flop/s) instead of ${complexMacPerSec.toFixed(0)} complex MAC/s. Branch bytes fall from ${BYTES_PER_SECOND} B/s cu8 to about ${(actualRate * 8).toFixed(0)} B/s cf32.${agc}`,
	].join("\n")
}

function loadLine(when: string): string {
	let uptime = ""
	try {
		uptime = execFileSync("uptime", { encoding: "utf8" }).trim()
	} catch (err: unknown) {
		uptime = err instanceof Error ? err.message : "uptime failed"
	}
	const avg = loadavg()
	const one = avg[0] ?? 0
	const five = avg[1] ?? 0
	const fifteen = avg[2] ?? 0
	return `load ${when}: ${uptime} | os.loadavg ${one.toFixed(2)} ${five.toFixed(2)} ${fifteen.toFixed(2)}`
}
