/**
 * DT.0 spectrum profile bench (measure only, not CI).
 *
 *   pnpm run build-file ./src/core/spectrum/spectrum-worker.ts \
 *     ./src/core/scanner/store/snapshot-worker.ts   (fresh dist workers first)
 *   pnpm exec esbuild scripts/bench/spectrum-profile.ts --bundle \
 *     --platform=node --format=esm --packages=external \
 *     --outfile=output/bench/spectrum-profile.mjs
 *   node output/bench/spectrum-profile.mjs [--seconds 120]
 *
 * In-process core: a fake rtl_tcp on 127.0.0.1:0 streams one precomputed second of
 * U8 noise plus 3 NFM and 2 4FSK channels, paced at 2.048 Msps and then 2.4 Msps.
 * One in-window job covers a 200 kHz scope on the tuned centre plus the passive job. The report is one JSON object on stdout.
 * Logs go to stderr. Nothing is written outside the esbuild outfile.
 */
import { copyFileSync, mkdtempSync, rmSync, existsSync } from "node:fs"
import net from "node:net"
import os from "node:os"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { performance, monitorEventLoopDelay } from "node:perf_hooks"
import process from "node:process"
import { fileURLToPath } from "node:url"
import pino from "pino"
import { ScannerConfigSchema, type SourceConfig } from "../../src/config.js"
import { FanoutManager } from "../../src/core/fanout-manager.js"
import { SourceFanoutRouter } from "../../src/core/source-fanout-router.js"
import { SourceManager } from "../../src/core/source-manager.js"
import { DiscoveryStore } from "../../src/core/scanner/store/discovery-store.js"
import { ScannerService } from "../../src/core/scanner/scanner-service.js"
import type { ScannerSettings } from "../../src/core/scanner/types.js"
import { PASSIVE_COST_LIMIT_DEFAULT } from "../../src/core/scanner/passive-cost-contract.js"
import { windowedUtilization } from "../../src/core/scanner/passive-cost.js"
import { TunerController } from "../../src/core/tuner-controller.js"
import { TunerRelay } from "../../src/core/tuner-relay.js"
import { wireTunerControl } from "../../src/core/tuner-wiring.js"
import {
	PIPELINE_PROFILE_STAGES,
	installSpectrumMainSpanSink,
	type PipelineProfile,
	type SpectrumMainSpan,
} from "../../src/core/spectrum/pipeline.js"
import {
	installSpectrumPipelineProfile,
	installSpectrumWorkerUrl,
	type EngineEpoch,
} from "../../src/core/spectrum/spectrum-engine.js"
import type { SpectrumService } from "../../src/core/spectrum/spectrum-service.js"
import type {
	EngineState,
	PipelineEvent,
} from "../../src/core/spectrum/types.js"
import { DecoderManager } from "../../src/decoders/manager.js"
import { DecoderRegistry } from "../../src/decoders/registry.js"
import { WaveKitError } from "../../src/utils/errors.js"

const CENTRE = 446_100_000
const RATES = [2_048_000, 2_400_000] as const
const SAMPLE_EVERY = 10
const SCOPE_HZ = 100_000
const CHUNK_BYTES = 32 * 1024
const BANNED_PORTS = new Set([9000, 5173, 8081, 8082, 15555, 15556, 18080])
const LISTENERS = [
	"tapFeed",
	"summaryDecode",
	"frameBuild",
	"scannerIngest",
	"store",
] as const

type ListenerName = (typeof LISTENERS)[number]

const arg = (name: string, fallback: number): number => {
	const i = process.argv.indexOf(`--${name}`)
	const v = i >= 0 ? Number(process.argv[i + 1]) : Number.NaN
	return Number.isFinite(v) && v > 0 ? v : fallback
}

const SECONDS = arg("seconds", 120)

const logger = pino({ level: "warn", base: null }, pino.destination(2))

const log = (line: string): void => {
	process.stderr.write(`${line}\n`)
}

const sleep = (ms: number): Promise<void> =>
	new Promise(resolve => {
		setTimeout(resolve, ms)
	})

function clampByte(v: number): number {
	const r = Math.round(v)
	if (r < 0) return 0
	if (r > 255) return 255
	return r
}

function xorshift(seed: number): () => number {
	let x = seed >>> 0
	return () => {
		x ^= x << 13
		x >>>= 0
		x ^= x >>> 17
		x ^= x << 5
		return x >>> 0
	}
}

/** One second of CU8: noise, 3 NFM, 2 4FSK, all inside ±100 kHz of the centre. */
function synthesize(rate: number): Uint8Array {
	const out = new Uint8Array(rate * 2)
	const rnd = xorshift(0x6d2b79f5)
	for (let i = 0; i < rate; i++) {
		const o = i * 2
		out[o] = clampByte(127 + ((rnd() % 13) - 6))
		out[o + 1] = clampByte(127 + ((rnd() % 13) - 6))
	}
	addNfm(out, rate, -80_000, 1000, 2500, 28)
	addNfm(out, rate, -40_000, 1300, 2500, 28)
	addNfm(out, rate, 20_000, 700, 2500, 28)
	add4fsk(out, rate, 50_000, 4800, 2400, 32, 0x41c64e6d)
	add4fsk(out, rate, 80_000, 4800, 2400, 32, 0x1b873593)
	return out
}

function addRotating(
	out: Uint8Array,
	rate: number,
	amp: number,
	hzAt: (sample: number) => number,
	step: number,
): void {
	let re = 1
	let im = 0
	let i = 0
	let sinceNorm = 0
	while (i < rate) {
		const d = (2 * Math.PI * hzAt(i)) / rate
		const wRe = Math.cos(d)
		const wIm = Math.sin(d)
		const end = Math.min(rate, i + step)
		for (; i < end; i++) {
			const nRe = re * wRe - im * wIm
			const nIm = re * wIm + im * wRe
			re = nRe
			im = nIm
			const o = i * 2
			out[o] = clampByte((out[o] ?? 127) + re * amp)
			out[o + 1] = clampByte((out[o + 1] ?? 127) + im * amp)
		}
		sinceNorm += step
		if (sinceNorm >= 4096) {
			const m = Math.hypot(re, im) || 1
			re /= m
			im /= m
			sinceNorm = 0
		}
	}
}

function addNfm(
	out: Uint8Array,
	rate: number,
	offsetHz: number,
	modHz: number,
	devHz: number,
	amp: number,
): void {
	addRotating(
		out,
		rate,
		amp,
		sample =>
			offsetHz + devHz * Math.sin((2 * Math.PI * modHz * sample) / rate),
		16,
	)
}

function add4fsk(
	out: Uint8Array,
	rate: number,
	offsetHz: number,
	baud: number,
	spacingHz: number,
	amp: number,
	seed: number,
): void {
	const symSamples = Math.max(1, Math.round(rate / baud))
	const levels = [-1.5, -0.5, 0.5, 1.5]
	const rnd = xorshift(seed)
	let left = 0
	let hz = offsetHz
	addRotating(
		out,
		rate,
		amp,
		() => {
			if (left <= 0) {
				hz = offsetHz + (levels[rnd() & 3] ?? 0) * spacingHz
				left = symSamples
			}
			left -= 32
			return hz
		},
		32,
	)
}

interface FakeRtl {
	port: number
	commands: () => number
	close: () => Promise<void>
}

function startFake(rate: number, iq: Uint8Array): Promise<FakeRtl> {
	const bytesPerSec = rate * 2
	const chunkMs = (CHUNK_BYTES / bytesPerSec) * 1000
	let commands = 0
	const stops = new Set<() => void>()
	const server = net.createServer(socket => {
		socket.on("error", () => undefined)
		const header = Buffer.alloc(12)
		header.write("RTL0", 0, "ascii")
		header.writeUInt32BE(5, 4)
		header.writeUInt32BE(29, 8)
		socket.write(header)
		let pending = Buffer.alloc(0)
		socket.on("data", (data: Buffer) => {
			pending = Buffer.concat([pending, data])
			const frames = Math.floor(pending.length / 5)
			if (frames > 0) {
				commands += frames
				pending = pending.subarray(frames * 5)
			}
		})
		let offset = 0
		let nextAt = performance.now()
		let timer: NodeJS.Timeout | null = null
		let stopped = false
		const stop = (): void => {
			stopped = true
			if (timer) clearTimeout(timer)
			timer = null
		}
		stops.add(stop)
		socket.on("close", () => {
			stop()
			stops.delete(stop)
		})
		const take = (): Uint8Array => {
			const end = offset + CHUNK_BYTES
			if (end < iq.length) {
				const chunk = iq.subarray(offset, end)
				offset = end
				return chunk
			}
			if (end === iq.length) {
				const chunk = iq.subarray(offset)
				offset = 0
				return chunk
			}
			const wrapped = new Uint8Array(CHUNK_BYTES)
			const first = iq.subarray(offset)
			wrapped.set(first, 0)
			const rest = CHUNK_BYTES - first.length
			wrapped.set(iq.subarray(0, rest), first.length)
			offset = rest
			return wrapped
		}
		const pump = (): void => {
			if (stopped || socket.destroyed) return
			const now = performance.now()
			if (now < nextAt) {
				timer = setTimeout(pump, nextAt - now)
				timer.unref()
				return
			}
			if (socket.writableNeedDrain) return
			const ok = socket.write(take())
			nextAt += chunkMs
			if (nextAt < now - chunkMs) nextAt = now
			if (!ok) return
			timer = setTimeout(pump, Math.max(0, nextAt - performance.now()))
			timer.unref()
		}
		socket.on("drain", () => {
			if (stopped) return
			nextAt = performance.now()
			pump()
		})
		pump()
	})
	server.on("error", () => undefined)
	return listenLocal(server).then(port => ({
		port,
		commands: () => commands,
		close: () =>
			new Promise(resolve => {
				for (const stop of stops) stop()
				server.close(() => resolve())
			}),
	}))
}

async function listenLocal(server: net.Server): Promise<number> {
	for (let attempt = 0; attempt < 8; attempt++) {
		const port = await new Promise<number>((resolve, reject) => {
			const onError = (err: Error): void => {
				server.off("listening", onListen)
				reject(err)
			}
			const onListen = (): void => {
				server.off("error", onError)
				const addr = server.address()
				if (addr === null || typeof addr === "string") {
					reject(
						new WaveKitError(
							"fake rtl_tcp did not bind a TCP port",
							"SCANNER_BENCH_PORT",
						),
					)
					return
				}
				resolve(addr.port)
			}
			server.once("error", onError)
			server.listen(0, "127.0.0.1", onListen)
		})
		if (!BANNED_PORTS.has(port)) return port
		await new Promise<void>(resolve => {
			server.close(() => resolve())
		})
	}
	throw new WaveKitError(
		"fake rtl_tcp could not bind an ephemeral port",
		"SCANNER_BENCH_PORT",
	)
}

const samples: Record<ListenerName, number[]> = {
	tapFeed: [],
	summaryDecode: [],
	frameBuild: [],
	scannerIngest: [],
	store: [],
}
let recording = false
let ingestDepth = 0
let nestedStoreMs = 0

function installListenerProbes(): void {
	installSpectrumMainSpanSink((name: SpectrumMainSpan, ms: number) => {
		if (!recording) return
		if (name === "tap-feed") samples.tapFeed.push(ms)
		else if (name === "summary-decode") samples.summaryDecode.push(ms)
		else samples.frameBuild.push(ms)
	})
	const originalIngest = DiscoveryStore.prototype.ingest
	DiscoveryStore.prototype.ingest = function (input) {
		if (!recording) return originalIngest.call(this, input)
		const t0 = performance.now()
		try {
			return originalIngest.call(this, input)
		} finally {
			const dt = performance.now() - t0
			samples.store.push(dt)
			if (ingestDepth > 0) nestedStoreMs += dt
		}
	}
	const scannerProto = ScannerService.prototype as unknown as {
		onPipelineEvent: (
			this: ScannerService,
			sourceId: string,
			ev: PipelineEvent,
			epoch: EngineEpoch,
		) => void
	}
	const originalEvent = scannerProto.onPipelineEvent
	scannerProto.onPipelineEvent = function (sourceId, ev, epoch) {
		if (!recording) return originalEvent.call(this, sourceId, ev, epoch)
		const t0 = performance.now()
		const nestedBefore = nestedStoreMs
		ingestDepth++
		try {
			return originalEvent.call(this, sourceId, ev, epoch)
		} finally {
			ingestDepth--
			const wall = performance.now() - t0
			const nested = nestedStoreMs - nestedBefore
			samples.scannerIngest.push(Math.max(0, wall - nested))
		}
	}
}

function resetSamples(): void {
	for (const name of LISTENERS) samples[name].length = 0
	ingestDepth = 0
	nestedStoreMs = 0
}

function percentile(xs: readonly number[], p: number): number | null {
	if (xs.length === 0) return null
	const sorted = xs.slice().sort((a, b) => a - b)
	const idx = Math.min(
		sorted.length - 1,
		Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
	)
	return sorted[idx] ?? null
}

function listenerReport(name: ListenerName): {
	name: ListenerName
	n: number
	p50Ms: number | null
	p99Ms: number | null
	maxMs: number | null
} {
	const xs = samples[name]
	let max: number | null = null
	for (const v of xs) if (max === null || v > max) max = v
	return {
		name,
		n: xs.length,
		p50Ms: percentile(xs, 50),
		p99Ms: percentile(xs, 99),
		maxMs: max,
	}
}

function profileOf(state: EngineState | null): PipelineProfile | null {
	if (state === null || !Object.hasOwn(state, "profile")) return null
	const profile = (state as EngineState & { profile?: PipelineProfile }).profile
	if (!profile) return null
	return profile
}

type ProfileDelta =
	| { ok: true; profile: PipelineProfile }
	| { ok: false; error: string }

function finiteCounter(value: number | null | undefined): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null
}

/**
 * Window delta of two profiles from the same worker. A missing side, a
 * non-finite counter, or a counter that went backwards is an error. The
 * absolute end profile is never used as a stand-in delta.
 */
function deltaProfile(
	start: PipelineProfile | null,
	end: PipelineProfile | null,
): ProfileDelta {
	if (!start && !end) {
		return {
			ok: false,
			error: "profile is missing at the start and end of the measurement",
		}
	}
	if (!start) {
		return {
			ok: false,
			error: "profile is missing at the start of the measurement",
		}
	}
	if (!end) {
		return {
			ok: false,
			error: "profile is missing at the end of the measurement",
		}
	}
	const startBlocks = finiteCounter(start.blocks)
	const endBlocks = finiteCounter(end.blocks)
	const startBusy = finiteCounter(start.busyMs)
	const endBusy = finiteCounter(end.busyMs)
	if (
		startBlocks === null ||
		endBlocks === null ||
		startBusy === null ||
		endBusy === null
	) {
		return { ok: false, error: "profile counters are not finite" }
	}
	const stages = {} as PipelineProfile["stages"]
	for (const stage of PIPELINE_PROFILE_STAGES) {
		const a = finiteCounter(start.stages[stage])
		const b = finiteCounter(end.stages[stage])
		if (a === null || b === null) {
			return {
				ok: false,
				error: `profile stage ${stage} is missing or not finite`,
			}
		}
		if (b < a) {
			return {
				ok: false,
				error: "profile counters reset during the measurement",
			}
		}
		stages[stage] = b - a
	}
	if (endBlocks < startBlocks || endBusy < startBusy) {
		return {
			ok: false,
			error: "profile counters reset during the measurement",
		}
	}
	const blocks = endBlocks - startBlocks
	const busyMs = endBusy - startBusy
	if (!(blocks > 0) || !(busyMs > 0)) {
		return {
			ok: false,
			error: `profile delta is not positive (blocks ${blocks}, busyMs ${busyMs})`,
		}
	}
	return { ok: true, profile: { blocks, busyMs, stages } }
}

function pushIfNotFinite(
	problems: string[],
	name: string,
	value: number | null,
): void {
	if (value === null || !Number.isFinite(value)) {
		problems.push(`${name} is missing or not finite`)
	}
}

interface JobView {
	id: string
	name: string | null
	state: string
	passive: boolean
	mode: string
	hops: number
	reason?: string
}

function jobsRunning(jobs: readonly JobView[]): boolean {
	return (
		jobs.some(job => job.passive && job.state === "running") &&
		jobs.some(job => !job.passive && job.state === "running")
	)
}

function jobViews(scanner: ScannerService): JobView[] {
	return scanner.listJobs().map(job => ({
		id: job.id,
		name: job.name,
		state: job.state,
		passive: job.passive,
		mode: job.spec.mode,
		hops: job.plan.hops.length,
		...(job.reason ? { reason: job.reason } : {}),
	}))
}

interface RateReport {
	sampleRateHz: number
	port: number
	rtlCommands: number
	jobsAtStart: JobView[]
	jobsAtEnd: JobView[]
	profile: PipelineProfile | null
	stageFractionOfBusy: Record<string, number> | null
	hotOverBusy: number | null
	passiveGuardUtilization: number | null
	engineUtilization: number | null
	measurementWindowUtilization: number | null
	workerGeneration: { start: number | null; end: number | null }
	mainThread: {
		utilization: number
		activeMs: number
		idleMs: number
		delayMs: { p50: number; p99: number; mean: number }
	} | null
	listeners: ReturnType<typeof listenerReport>[]
	listenersOver1msP99: ListenerName[]
	loadavg: number[]
	notes: string[]
	error?: string
}

async function waitUntil(
	check: () => boolean,
	timeoutMs: number,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs
	while (!check()) {
		if (Date.now() > deadline) return false
		await sleep(50)
	}
	return true
}

interface Stack {
	dir: string
	fake: FakeRtl
	scanner: ScannerService
	sources: SourceManager
	decoders: DecoderManager
	spectrum: SpectrumService
}

async function openStack(rate: number, iq: Uint8Array): Promise<Stack> {
	const fake = await startFake(rate, iq)
	const dir = mkdtempSync(join(tmpdir(), "wk-spectrum-profile-"))
	const source: SourceConfig = {
		id: "rtl",
		type: "rtl_tcp",
		host: "127.0.0.1",
		port: fake.port,
		loop: false,
		playbackSpeed: 1,
		stallTimeoutMs: 0,
		caps: {
			kind: "iq",
			format: "U8_IQ",
			sampleRate: rate,
			centerFreq: CENTRE,
			exclusive: false,
		},
	}
	const sourceManager = new SourceManager(logger)
	const fanout = new FanoutManager(logger)
	const routing = new SourceFanoutRouter(sourceManager, fanout, logger, "rtl")
	const tuner = new TunerController(logger, sourceManager)
	wireTunerControl({
		log: logger,
		sourceManager,
		tunerController: tuner,
		tunerRelay: new TunerRelay(
			logger,
			sourceManager,
			new FanoutManager(logger),
			{
				enabled: false,
				host: "127.0.0.1",
				port: 1,
				controlPolicy: "shared",
			},
		),
		relayEnabled: false,
	})
	const decoders = new DecoderManager(new DecoderRegistry(), fanout, logger)
	decoders.setSourceManager(sourceManager, routing)
	const settings = ScannerConfigSchema.parse({
		storage: { dir },
		// The passive guard's first check is 60 s after the engine opens, so a
		// 120 s run would otherwise measure two workloads. 1 is the schema max
		// and is above any single-thread utilization, so the guard cannot
		// disable the passive job. The verdict still uses PASSIVE_COST_LIMIT_DEFAULT.
		passive: { enabled: true, maxEngineUtilization: 1 },
	}) as ScannerSettings
	const scanner = new ScannerService({
		settings,
		sourceConfigs: [source],
		decoderConfigs: [],
		region: "EU",
		stateDir: dir,
		sources: sourceManager,
		routing,
		tuner,
		decoders,
		digitalVoice: null,
		liveDemod: null,
		logger,
		engineHost: "thread",
	})
	const spectrum = (scanner as unknown as { spectrum: SpectrumService })
		.spectrum
	await scanner.start()
	await sourceManager.connect(source)
	const tuned = await waitUntil(
		() => tuner.getState("rtl") !== undefined,
		15_000,
	)
	if (!tuned) log(`rate ${rate}: tuner state did not appear`)
	const job = await scanner.createJob({
		sourceId: "rtl",
		name: "bench-200khz",
		mode: "in-window",
		ranges: [{ startHz: CENTRE - SCOPE_HZ, endHz: CENTRE + SCOPE_HZ }],
		hold: { policy: "never" },
		signalsOnly: true,
		takeover: true,
	})
	log(
		`rate ${rate}: job ${job.id} ${job.state} hops ${job.plan.hops.length} passive waiting`,
	)
	const ready = await waitUntil(() => {
		const jobs = scanner.listJobs()
		const engine = spectrum.engine("rtl")
		const parked = jobs.some(j => !j.passive && j.state === "running")
		const passive = jobs.some(j => j.passive && j.state === "running")
		return engine !== undefined && parked && passive
	}, 20_000)
	if (!ready) {
		log(
			`rate ${rate}: jobs not both running yet ${JSON.stringify(jobViews(scanner))}`,
		)
	}
	await spectrum.subscribe("bench", {
		sourceId: "rtl",
		hz: 10,
		bins: 512,
	})
	return {
		dir,
		fake,
		scanner,
		sources: sourceManager,
		decoders,
		spectrum,
	}
}

async function closeStackBounded(stack: Stack, rate: number): Promise<void> {
	let timer: NodeJS.Timeout | undefined
	const timeout = new Promise<void>(resolve => {
		timer = setTimeout(() => {
			log(`rate ${rate}: cleanup timed out`)
			resolve()
		}, 20_000)
	})
	try {
		await Promise.race([closeStack(stack), timeout])
	} finally {
		if (timer) clearTimeout(timer)
	}
}

async function closeStack(stack: Stack): Promise<void> {
	await stack.scanner.stop().catch((err: unknown) => {
		log(`scanner stop: ${err instanceof Error ? err.message : String(err)}`)
	})
	await stack.sources.disconnectAll().catch((err: unknown) => {
		log(
			`source disconnect: ${err instanceof Error ? err.message : String(err)}`,
		)
	})
	await stack.decoders.destroy().catch((err: unknown) => {
		log(`decoder destroy: ${err instanceof Error ? err.message : String(err)}`)
	})
	await stack.fake.close().catch((err: unknown) => {
		log(`fake close: ${err instanceof Error ? err.message : String(err)}`)
	})
	rmSync(stack.dir, { recursive: true, force: true })
}

async function waitForBlocks(
	spectrum: SpectrumService,
	timeoutMs: number,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		const profile = await readProfile(spectrum)
		if ((profile?.blocks ?? 0) > 0) return true
		await sleep(200)
	}
	return false
}

async function readExport(
	spectrum: SpectrumService,
): Promise<EngineState | null> {
	const engine = spectrum.engine("rtl")
	if (!engine) return null
	return engine.exportState().catch(() => null)
}

async function readProfile(
	spectrum: SpectrumService,
): Promise<PipelineProfile | null> {
	return profileOf(await readExport(spectrum))
}

async function runRate(rate: number, iq: Uint8Array): Promise<RateReport> {
	const notes: string[] = []
	let stack: Stack | null = null
	try {
		stack = await openStack(rate, iq)
		const engine = stack.spectrum.engine("rtl")
		if (!engine) {
			notes.push("spectrum engine did not open")
			return {
				sampleRateHz: rate,
				port: stack.fake.port,
				rtlCommands: stack.fake.commands(),
				jobsAtStart: jobViews(stack.scanner),
				jobsAtEnd: jobViews(stack.scanner),
				profile: null,
				stageFractionOfBusy: null,
				hotOverBusy: null,
				passiveGuardUtilization: null,
				engineUtilization: null,
				measurementWindowUtilization: null,
				workerGeneration: { start: null, end: null },
				mainThread: null,
				listeners: LISTENERS.map(listenerReport),
				listenersOver1msP99: [],
				loadavg: os.loadavg(),
				notes,
				error: "no engine",
			}
		}
		const sawBlock = await waitForBlocks(stack.spectrum, 15_000)
		if (!sawBlock) notes.push("no profiled block before the measurement window")
		const jobsAtStart = jobViews(stack.scanner)
		const profileStart = await readProfile(stack.spectrum)
		const eluStartSample = engine.eluSample()
		resetSamples()
		const elu0 = performance.eventLoopUtilization()
		const delay = monitorEventLoopDelay({ resolution: 1 })
		delay.enable()
		recording = true
		log(`rate ${rate}: measuring ${SECONDS}s`)
		await sleep(SECONDS * 1000)
		recording = false
		delay.disable()
		const elu = performance.eventLoopUtilization(elu0)
		const profileEnd = await readProfile(stack.spectrum)
		const eluEndSample = engine.eluSample()
		const delta = deltaProfile(profileStart, profileEnd)
		const profile = delta.ok ? delta.profile : null
		const busy = profile ? profile.busyMs : null
		let hotOverBusy: number | null = null
		if (profile && busy !== null && busy > 0) {
			const hot =
				profile.stages.window +
				profile.stages.fft +
				profile.stages.power +
				profile.stages.wire
			const ratio = hot / busy
			hotOverBusy = Number.isFinite(ratio) ? ratio : null
		}
		const stageFractionOfBusy =
			profile && busy !== null && busy > 0
				? Object.fromEntries([
						...PIPELINE_PROFILE_STAGES.map(stage => [
							stage,
							profile.stages[stage] / busy,
						]),
						[
							"unattributed",
							Math.max(
								0,
								busy -
									PIPELINE_PROFILE_STAGES.reduce(
										(sum, stage) => sum + profile.stages[stage],
										0,
									),
							) / busy,
						],
					])
				: null
		const lifeSample = eluEndSample
			? {
					idle: eluEndSample.elu.idle,
					active: eluEndSample.elu.active,
					generation: eluEndSample.generation,
				}
			: null
		const passiveGuardUtilization = lifeSample
			? windowedUtilization(lifeSample, null)
			: null
		const genStart = eluStartSample?.generation ?? null
		const genEnd = eluEndSample?.generation ?? null
		const sameGeneration =
			genStart !== null && genEnd !== null && genStart === genEnd
		const windowSample =
			sameGeneration && eluStartSample && eluEndSample
				? windowedUtilization(
						{
							idle: eluEndSample.elu.idle,
							active: eluEndSample.elu.active,
							generation: eluEndSample.generation,
						},
						{
							idle: eluStartSample.elu.idle,
							active: eluStartSample.elu.active,
							generation: eluStartSample.generation,
						},
					)
				: null
		const engineUtilization = engine.utilization()
		const listeners = LISTENERS.map(listenerReport)
		const over = listeners.flatMap(row =>
			row.p99Ms !== null && row.p99Ms > 1 ? [row.name] : [],
		)
		const problems: string[] = []
		const endState = await readExport(stack.spectrum)
		if (endState && !Object.hasOwn(endState, "profile")) {
			problems.push(
				"rebuild the worker: pnpm run build-file ./src/core/spectrum/spectrum-worker.ts",
			)
		} else if (!delta.ok) {
			problems.push(delta.error)
		}
		if (genStart === null || genEnd === null) {
			problems.push(
				"worker generation is missing at the start or end of the measurement",
			)
		} else if (genStart !== genEnd) {
			problems.push(
				`worker generation changed during the measurement (start ${genStart}, end ${genEnd})`,
			)
		} else {
			pushIfNotFinite(
				problems,
				"passiveGuardUtilization",
				passiveGuardUtilization,
			)
			pushIfNotFinite(problems, "measurementWindowUtilization", windowSample)
			pushIfNotFinite(problems, "engineUtilization", engineUtilization)
			if (profile && hotOverBusy === null) {
				problems.push("hotOverBusy is missing or not finite")
			}
		}
		if (!jobsRunning(jobsAtStart) || !jobsRunning(jobViews(stack.scanner))) {
			problems.push("jobs not running for the whole measurement")
		}
		if (stageFractionOfBusy) {
			const unattributed = stageFractionOfBusy.unattributed
			if (typeof unattributed !== "number" || !Number.isFinite(unattributed)) {
				problems.push("unattributed share is missing or not finite")
			} else if (unattributed > 0.05) {
				problems.push(
					`unattributed share ${unattributed.toFixed(4)} exceeds 0.05`,
				)
			}
		}
		if (!profile || !(profile.blocks > 0))
			notes.push("no profiled block in the measurement window")
		const error = problems.length > 0 ? problems.join("; ") : undefined
		return {
			sampleRateHz: rate,
			port: stack.fake.port,
			rtlCommands: stack.fake.commands(),
			jobsAtStart,
			jobsAtEnd: jobViews(stack.scanner),
			profile,
			stageFractionOfBusy,
			hotOverBusy,
			passiveGuardUtilization,
			engineUtilization,
			measurementWindowUtilization: windowSample,
			workerGeneration: {
				start: genStart,
				end: genEnd,
			},
			mainThread: {
				utilization: elu.utilization,
				activeMs: elu.active,
				idleMs: elu.idle,
				delayMs: {
					p50: delay.percentile(50) / 1e6,
					p99: delay.percentile(99) / 1e6,
					mean: delay.mean / 1e6,
				},
			},
			listeners,
			listenersOver1msP99: over,
			loadavg: os.loadavg(),
			notes,
			...(error ? { error } : {}),
		}
	} catch (err: unknown) {
		recording = false
		const message = err instanceof Error ? err.message : String(err)
		log(`rate ${rate}: ${message}`)
		return {
			sampleRateHz: rate,
			port: stack?.fake.port ?? 0,
			rtlCommands: stack?.fake.commands() ?? 0,
			jobsAtStart: stack ? jobViews(stack.scanner) : [],
			jobsAtEnd: stack ? jobViews(stack.scanner) : [],
			profile: null,
			stageFractionOfBusy: null,
			hotOverBusy: null,
			passiveGuardUtilization: null,
			engineUtilization: null,
			measurementWindowUtilization: null,
			workerGeneration: { start: null, end: null },
			mainThread: null,
			listeners: [],
			listenersOver1msP99: [],
			loadavg: os.loadavg(),
			notes,
			error: message,
		}
	} finally {
		recording = false
		if (stack) await closeStackBounded(stack, rate)
	}
}

/**
 * The esbuild bundle's import.meta.url is output/bench, so workers that resolve
 * `./snapshot-worker.js` beside dist/index.js look beside the bench instead.
 * Copy the built worker next to the bundle when it exists.
 */
function placeSnapshotWorker(): boolean {
	const src = fileURLToPath(
		new URL("../../dist/snapshot-worker.js", import.meta.url),
	)
	const dest = fileURLToPath(new URL("./snapshot-worker.js", import.meta.url))
	if (src === dest) return existsSync(dest)
	if (!existsSync(src)) return false
	copyFileSync(src, dest)
	return true
}

function workerUrl(): URL {
	const url = new URL("../../dist/spectrum-worker.js", import.meta.url)
	if (!existsSync(fileURLToPath(url))) {
		throw new WaveKitError(
			`spectrum worker missing at ${fileURLToPath(url)}; run pnpm run build-file ./src/core/spectrum/spectrum-worker.ts`,
			"SCANNER_WORKER_MISSING",
		)
	}
	return url
}

async function main(): Promise<number> {
	const snapshotWorker = placeSnapshotWorker()
	if (!snapshotWorker)
		log(
			"dist/snapshot-worker.js missing; discovery snapshots run on the main thread",
		)
	installSpectrumPipelineProfile({ sampleEvery: SAMPLE_EVERY })
	installSpectrumWorkerUrl(workerUrl())
	installListenerProbes()
	const rates: RateReport[] = []
	for (const rate of RATES) {
		log(`synthesizing ${rate}`)
		const iq = synthesize(rate)
		rates.push(await runRate(rate, iq))
	}
	const at2048 = rates.find(r => r.sampleRateHz === 2_048_000)
	const hot = finiteCounter(at2048?.hotOverBusy)
	const util = finiteCounter(at2048?.passiveGuardUtilization)
	const over = [...new Set(rates.flatMap(r => r.listenersOver1msP99))]
	const rateErrors = rates
		.filter(r => r.error !== undefined)
		.map(r => `${r.sampleRateHz}: ${r.error}`)
	if (!at2048) rateErrors.push("2.048 Msps measurement is missing")
	else if (hot === null || util === null) {
		rateErrors.push(
			"2.048 Msps hotOverBusy or utilization is missing or not finite",
		)
	}
	const failure = rateErrors.join("; ")
	// A verdict exists only for a complete measurement. Missing inputs are not
	// coerced to 0, and a failed measurement does not report met, deferred, or fail.
	const verdict =
		failure.length === 0 && hot !== null && util !== null
			? hot >= 0.5 && util > PASSIVE_COST_LIMIT_DEFAULT
				? "met"
				: "deferred"
			: null
	const report = {
		seconds: SECONDS,
		sampleEvery: SAMPLE_EVERY,
		passiveCostLimit: PASSIVE_COST_LIMIT_DEFAULT,
		centreHz: CENTRE,
		scopeHz: SCOPE_HZ * 2,
		...(verdict ? { rustDetectorGate: verdict } : {}),
		...(failure ? { error: failure } : {}),
		rustDetectorGateInputs: {
			sampleRateHz: 2_048_000,
			hotOverBusy: hot,
			passiveGuardUtilization: util,
			limit: PASSIVE_COST_LIMIT_DEFAULT,
		},
		listenersOver1msP99: over,
		loadavg: os.loadavg(),
		rates,
		snapshotWorker,
		notes: [
			"Parking (DT.2) is not implemented. The 200 kHz job is mode in-window on the tuned centre, the parked-job equivalent on this base.",
			"signalsOnly is set, so the operator job does not request decoder trials. offsetProbes stays at its default false.",
			"Frame build is SpectrumService.frames with one subscribed client at 10 Hz and 512 bins.",
			"scannerIngest is ScannerService.onPipelineEvent excluding nested DiscoveryStore.ingest. store is every DiscoveryStore.ingest call.",
			"tapFeed, summaryDecode and frameBuild are spans around the real engine tap, the host summary decode and frames().",
			"Worker stages are the measurement-window delta, sampled one finished block in ten. gate is 0 because the channel gate is not in the pipeline yet.",
			"busyMs sums synchronous time on sampled blocks: windowing (including a chunk that yields no frame), each sampled frame, block finalization on every path, and the worker's encodeEventsForWire plus postMessage. Waits between rtl_tcp chunks are not included.",
			"scanner.passive.maxEngineUtilization is 1 in this bench only, so the passive CPU guard cannot disable the passive job at its 60 s check. The verdict still compares utilization with PASSIVE_COST_LIMIT_DEFAULT (0.25). Both jobs are required to be running at the start and end of the measurement.",
			"A measurement needs a start profile and an end profile from the same worker generation, a positive block delta and busy delta with no counter reset, and finite utilization. A missing profile, a generation change, a counter reset, a non-positive delta, a non-finite utilization, a stale dist/spectrum-worker.js (no profile on export-state), jobs that are not running, or an unattributed share above 0.05 exits non-zero with an error and no rustDetectorGate verdict. deferred is only a complete measurement that misses the hot-path criterion. Missing inputs are not coerced to 0.",
			"passiveGuardUtilization is windowedUtilization of the worker ELU sample with no previous sample: the worker's whole life, which is how the passive guard reads its first check.",
			"measurementWindowUtilization is the same pair of samples differenced across the measurement window.",
			"monitorEventLoopDelay is process-wide at 1 ms resolution. Per-listener p50/p99 are callback durations.",
			"The fake rtl_tcp listens on 127.0.0.1 port 0 and paces one precomputed second of U8 noise plus 3 NFM and 2 4FSK at the sample rate.",
			"snapshotWorker is true when dist/snapshot-worker.js was copied beside this bundle. Otherwise ScannerPersistence runs snapshots on the main thread.",
		],
	}
	process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
	return verdict === null ? 1 : 0
}

void main()
	.then(code => {
		process.exitCode = code
	})
	.catch((err: unknown) => {
		const message = err instanceof Error ? err.message : String(err)
		process.stdout.write(`${JSON.stringify({ error: message }, null, 2)}\n`)
		process.exitCode = 1
	})
	.finally(() => {
		installSpectrumPipelineProfile(undefined)
		installSpectrumWorkerUrl(undefined)
		installSpectrumMainSpanSink(null)
		setTimeout(() => {
			process.exit(process.exitCode ?? 0)
		}, 100)
	})
