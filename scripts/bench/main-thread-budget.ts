/**
 * Main-thread budget harness, tier A (host-native scratch core; measurement only, never a CI gate).
 *
 *   pnpm run build && node scripts/bench/budget-build.mjs
 *   nice -n 10 node output/bench/main-thread-budget.mjs --label base
 *     [--rate 1024000|2400000] [--seconds 60] [--warmup 20] [--clients 0|1|2]
 *     [--passive on|off] [--profile] [--counts] [--out DIR] [--keep] [--core PATH]
 *   node output/bench/main-thread-budget.mjs --finish-image DIR [--label NAME]
 *   node output/bench/main-thread-budget.mjs --reassemble DIR
 *
 * Tier A writes a seeded synthetic CU8 scene (two NFM voice transmissions with CTCSS in overs, a
 * 4FSK-like burst train, an unmodulated carrier, over a noise floor) to a tmp work dir and serves
 * it from budget-fake-rtltcp.mjs on an ephemeral 127.0.0.1 port. It starts
 * `nice -n 10 node --import budget-preload.mjs <core>` against a config in that work dir (also
 * the state dir), with spectrum, the passive scanner and its recorder, live demod through the
 * csdr rate stub, catalogue decoders through stand-in binaries on a tmp PATH, and the real
 * channelizer only when WAVEKIT_CHAN_BIN names a file. The core runs in protected access mode
 * (local-http, scratch access state in the work dir) so that every listener binds 127.0.0.1;
 * after start-up `lsof` checks that by the core's PID and any other listener aborts the run.
 * Web-like clients are budget-ws-client.mjs processes with the scratch machine credential.
 * After the warm-up, one SIGUSR2 to the core opens the preload's window and a second closes it;
 * the fake and the clients write marks at the same edges. --seconds is rounded up to a whole
 * number of 20 s scene periods.
 * --profile CPU-profiles the main thread over the inspector for that window; --counts adds a
 * second window with V8 precise-coverage call counts (it perturbs timing, so nothing else is read
 * from it). Everything is turned into DIR/manifest.json (budget-manifest.ts).
 *
 * --finish-image DIR builds the same manifest (tier B) from what main-thread-budget-image.sh
 * collected in DIR. --reassemble DIR rebuilds DIR/manifest.json from the files of an earlier run
 * (its run.json), for instance after a change to the post-processing.
 *
 * The work dir (config, state, scene IQ, stand-ins) is removed at the end unless --keep; the
 * out dir (default a new tmp dir, printed) holds the results and is always kept.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs"
import net from "node:net"
import os from "node:os"
import { basename, dirname, isAbsolute, join, resolve } from "node:path"
import process from "node:process"
import { fileURLToPath, pathToFileURL } from "node:url"
import { z } from "zod"
import { WaveKitError } from "../../src/utils/errors.js"
import {
	buildScene,
	type Interval,
	type Scene,
	SceneGenerator,
} from "./scanner-quality/scene.js"
import {
	descendantsOf,
	iqSecondsOf,
	type Manifest,
	ManifestSchema,
	nonLoopbackListeners,
	parseLsofListeners,
	parseProcLines,
	parsePs,
	perIqSecond,
	type PsRow,
	roundWindowUp,
	spread,
	timingValidity,
} from "./budget-manifest.js"
import {
	callCounts,
	COUNTED_FUNCTIONS,
	CpuProfileSchema,
	PreciseCoverageSchema,
	summariseProfile,
} from "./budget-profile.js"

const BANNED_PORTS = new Set([
	1234, 4713, 5555, 5556, 5173, 8080, 8081, 8082, 9000, 9229, 15555, 15556,
	18080,
])
const SOURCE_ID = "bench0"
/** Synthetic 70 cm centre, as the scanner-quality scenes use; no real allocation. */
const CENTRE_HZ = 439_000_000
const SCENE_MS = 20_000
const VOICE_A_HZ = 150_000
/** Decoder executables the catalogue may spawn: each becomes a stand-in that discards stdin. */
const DECODER_STANDINS = [
	"multimon-ng",
	"dsd-fme",
	"direwolf",
	"rtl_433",
	"readsb",
	"AIS-catcher",
	"acarsdec",
	"dumpvdl2",
	"lora-node",
	"sox",
]
/** Receiver tools that must never run from a scratch core: shadowed by a script that exits 127. */
const RECEIVER_TOOLS = [
	"rtl_tcp",
	"rtl_sdr",
	"rtl_test",
	"rtl_fm",
	"rtl_power",
	"rtl_eeprom",
	"rtl_biast",
	"wavekit-iqcap",
]

// === options ===

const argv = process.argv.slice(2)
const flag = (name: string): boolean => argv.includes(`--${name}`)
const opt = (name: string): string | undefined => {
	const i = argv.indexOf(`--${name}`)
	return i >= 0 ? argv[i + 1] : undefined
}
function numOpt(
	name: string,
	fallback: number,
	allowed?: readonly number[],
): number {
	const raw = opt(name)
	if (raw === undefined) return fallback
	const v = Number(raw)
	if (!Number.isFinite(v) || v < 0 || (allowed && !allowed.includes(v)))
		throw new WaveKitError(`bad --${name} ${raw}`, "BUDGET_ARGS")
	return v
}

const root = fileURLToPath(new URL("../../", import.meta.url))
const benchDir = join(root, "scripts", "bench")

const log = (line: string): void => {
	process.stderr.write(`${line}\n`)
}
const sleep = (ms: number): Promise<void> =>
	new Promise(r => {
		setTimeout(r, ms)
	})

// === small helpers (after scripts/profile-spectrum-main.ts) ===

async function listenEphemeral(server: net.Server): Promise<number> {
	for (let attempt = 0; attempt < 8; attempt++) {
		const port = await new Promise<number>((res, rej) => {
			server.once("error", rej)
			server.listen(0, "127.0.0.1", () => {
				const addr = server.address()
				if (addr === null || typeof addr === "string")
					rej(new WaveKitError("no TCP port", "BUDGET_PORT"))
				else res(addr.port)
			})
		})
		if (!BANNED_PORTS.has(port)) return port
		await new Promise<void>(r => server.close(() => r()))
	}
	throw new WaveKitError("no ephemeral port", "BUDGET_PORT")
}

async function freePort(): Promise<number> {
	const server = net.createServer()
	const port = await listenEphemeral(server)
	await new Promise<void>(r => server.close(() => r()))
	return port
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`
}

function sha256File(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex")
}

function readJsonl(path: string): unknown[] {
	if (!existsSync(path)) return []
	const out: unknown[] = []
	for (const line of readFileSync(path, "utf8").split("\n")) {
		if (line.trim() === "") continue
		try {
			out.push(JSON.parse(line))
		} catch {
			// a torn last line
		}
	}
	return out
}

function readJson(path: string): unknown {
	try {
		return JSON.parse(readFileSync(path, "utf8"))
	} catch {
		return null
	}
}

function gitCommit(): { sha: string; dirty: boolean } {
	const sha = spawnSync("git", ["rev-parse", "HEAD"], {
		cwd: root,
		encoding: "utf8",
	})
	const status = spawnSync("git", ["status", "--porcelain"], {
		cwd: root,
		encoding: "utf8",
	})
	return {
		sha: sha.status === 0 ? sha.stdout.trim() : "unknown",
		dirty: status.status !== 0 || status.stdout.trim() !== "",
	}
}

// === boundary schemas for the collected files ===

const KindCounts = z.record(
	z.object({
		count: z.number(),
		bytes: z.number().optional(),
		ms: z.number().optional(),
	}),
)
const DeltaSchema = z.object({
	wallMs: z.number(),
	mainCpuUs: z.number(),
	processCpuUs: z.number(),
	elu: z.object({ utilization: z.number() }),
	loopDelayMs: z
		.object({ p50: z.number(), p99: z.number(), max: z.number() })
		.nullable(),
	gc: KindCounts,
	contextSwitches: z.object({ voluntary: z.number(), involuntary: z.number() }),
	writes: KindCounts,
	structuredClone: z.number(),
	sourceChunks: z.number().nullable(),
	sourceBytes: z.number().nullable(),
	schedstat: z.object({ waitShare: z.number().nullable() }).nullable(),
})
const WindowSchema = DeltaSchema.extend({
	n: z.number(),
	pid: z.number(),
	platform: z.string(),
	startUtc: z.string(),
	endUtc: z.string(),
	tasks: z
		.array(
			z.object({
				tid: z.number(),
				comm: z.string(),
				main: z.boolean(),
				cpuMs: z.number(),
			}),
		)
		.nullable(),
})
const TickSchema = DeltaSchema.extend({ loadavg: z.array(z.number()) })
const WorkerFileSchema = z.object({
	threadId: z.number(),
	name: z.string().nullable(),
	cpuUs: z.number(),
})
const FakeLineSchema = z.object({
	ev: z.string(),
	bytes: z.number().optional(),
	iqSeconds: z.number().optional(),
	skippedSeconds: z.number().optional(),
	rateHz: z.number().optional(),
	port: z.number().optional(),
})
const WsLineSchema = z.object({
	ev: z.string(),
	ms: z.number(),
	messages: z.number(),
	bytes: z.number(),
	byType: z.record(z.object({ messages: z.number(), bytes: z.number() })),
})
const DecisionsSchema = z.object({ counts: z.record(z.number()).optional() })
const DecodersSchema = z.array(
	z.object({ id: z.string(), running: z.boolean().optional() }),
)
const CoverageFileSchema = z.object({
	seconds: z.number(),
	result: PreciseCoverageSchema,
})
const RunMetaSchema = z.object({
	tier: z.enum(["A", "B"]),
	label: z.string(),
	rateHz: z.number(),
	clients: z.number().int(),
	passive: z.boolean(),
	profile: z.boolean(),
	counts: z.boolean(),
	coreSha256: z.string(),
	corePath: z.string(),
	bundleUrl: z.string(),
	imageId: z.string().nullable(),
	scene: z.object({
		id: z.string(),
		sha256: z.string(),
		fixtures: z.enum(["modelled", "recorded"]),
	}),
	parts: z.record(z.enum(["real", "stand-in", "absent", "unknown"])),
	notes: z.array(z.string()),
	commit: z.object({ sha: z.string(), dirty: z.boolean() }),
	/** Tier B: one entry per uptime line, null for a line that did not parse; null without any. */
	outerLoad: z.array(z.number().nullable()).nullable(),
	windowSecondsRequested: z.number().nullable(),
	warmupSeconds: z.number(),
	listenersChecked: z.boolean(),
	overlay: z
		.array(z.object({ file: z.string(), sha256: z.string() }))
		.nullable(),
	warnings: z.array(z.string()),
})
type RunMeta = z.infer<typeof RunMetaSchema>

// === ps (children CPU, by PID) ===

/** Tier A: the core's descendants with their CPU, as `pid ppid time comm` lines. */
function psUnder(corePid: number): string {
	const all = spawnSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" })
	if (all.status !== 0) return ""
	const rows = all.stdout
		.split("\n")
		.map(l => /^\s*(\d+)\s+(\d+)/.exec(l))
		.filter((m): m is RegExpExecArray => m !== null)
		.map(m => ({ pid: Number(m[1]), ppid: Number(m[2]) }))
	const pids = [...descendantsOf(rows, corePid)]
	if (pids.length === 0) return ""
	const r = spawnSync(
		"ps",
		["-o", "pid=,ppid=,time=,comm=", "-p", pids.join(",")],
		{ encoding: "utf8" },
	)
	return r.status === 0 || r.stdout ? r.stdout : ""
}

// === manifest assembly (both tiers) ===

function marks<T extends { ev: string }>(lines: readonly T[]): T[] {
	return lines.filter(l => l.ev === "mark")
}

function assemble(outDir: string, meta: RunMeta): Manifest {
	const preDir = join(outDir, "preload")
	const winParsed = WindowSchema.safeParse(
		readJson(join(preDir, "window-0.json")),
	)
	if (!winParsed.success)
		throw new WaveKitError(
			`no valid timing window in ${preDir}: ${winParsed.error.issues[0]?.message ?? ""}`,
			"BUDGET_WINDOW",
		)
	const win = winParsed.data
	const windowSeconds = win.wallMs / 1000
	const ticks = readJsonl(join(preDir, "ticks-0.jsonl"))
		.map(t => TickSchema.safeParse(t))
		.flatMap(r => (r.success ? [r.data] : []))
	const loadSamples = ticks
		.map(t => t.loadavg[0])
		.filter((v): v is number => typeof v === "number")
	const waits = ticks
		.map(t => t.schedstat?.waitShare)
		.filter((v): v is number => typeof v === "number")
	const rq = waits.length > 0 ? spread(waits) : null
	const verdict = timingValidity({
		loadSamples,
		runQueueWaitP95: rq === null ? null : rq.p95,
		tier: meta.tier,
		outerLoadSamples: meta.outerLoad,
	})
	const warnings = [...meta.warnings]
	// IQ in the window: the bytes the core received on its source socket; the fake's first two
	// marks are the cross-check.
	const fake = marks(
		readJsonl(join(outDir, "fake.jsonl"))
			.map(l => FakeLineSchema.safeParse(l))
			.flatMap(r => (r.success ? [r.data] : [])),
	)
	const fakeA = fake[0]
	const fakeB = fake[1]
	const iq = iqSecondsOf({
		sourceBytes: win.sourceBytes,
		rateHz: meta.rateHz,
		fakeIqSeconds:
			fakeA?.iqSeconds !== undefined && fakeB?.iqSeconds !== undefined
				? fakeB.iqSeconds - fakeA.iqSeconds
				: null,
	})
	warnings.push(...iq.warnings)
	const iqSeconds = iq.iqSeconds
	const sourceSkippedSeconds =
		fakeA?.skippedSeconds !== undefined && fakeB?.skippedSeconds !== undefined
			? fakeB.skippedSeconds - fakeA.skippedSeconds
			: null
	if (sourceSkippedSeconds !== null && sourceSkippedSeconds > 0)
		warnings.push(
			`the fake skipped ${sourceSkippedSeconds.toFixed(2)} s of signal in the window: the core fell more than 2 s behind its source`,
		)
	const perIq = (ms: number | null): number | null => perIqSecond(ms, iqSeconds)
	const perS = (v: number): number =>
		windowSeconds > 0 ? v / windowSeconds : 0

	// Workers: the preload in each worker. Threads: on Linux every thread from /proc.
	const workers: Manifest["results"]["workers"] = []
	for (const f of existsSync(preDir) ? readdirSync(preDir).sort() : []) {
		if (!/^window-0-worker-\d+\.json$/.test(f)) continue
		const w = WorkerFileSchema.safeParse(readJson(join(preDir, f)))
		if (w.success)
			workers.push({
				threadId: w.data.threadId,
				name: w.data.name,
				cpuMsPerIqSecond: perIq(w.data.cpuUs / 1000),
				source: "preload threadCpuUsage",
			})
	}
	const threads: Manifest["results"]["threads"] =
		win.tasks === null
			? null
			: win.tasks
					.filter(t => !t.main)
					.map(t => ({
						tid: t.tid,
						name: t.comm,
						cpuMsPerIqSecond: perIq(t.cpuMs),
						source: "/proc task stat",
					}))
	const workersUnknownReason =
		workers.length > 0
			? null
			: "no worker reported a window (no file workers ran, or the preload did not load in them)"

	// Children by PID under the core: tier A from ps, tier B from /proc inside the container.
	let children: Manifest["results"]["children"] = []
	let childrenUnknownReason: string | null = null
	const listing = (name: string): PsRow[] | null => {
		const path = join(outDir, name)
		if (!existsSync(path)) return null
		const text = readFileSync(path, "utf8")
		return meta.tier === "B" ? parseProcLines(text) : parsePs(text)
	}
	const [startName, endName] =
		meta.tier === "B"
			? ["proc-start.txt", "proc-end.txt"]
			: ["ps-start.txt", "ps-end.txt"]
	const psA = listing(startName)
	const psB = listing(endName)
	if (psA === null || psB === null || psB.length === 0)
		childrenUnknownReason = `no ${meta.tier === "B" ? "/proc" : "ps"} listing of the core's children`
	else {
		const under = descendantsOf(psB, win.pid)
		const before = new Map(psA.map(r => [r.pid, r]))
		children = psB
			.filter(r => under.has(r.pid))
			.map(r => ({
				pid: r.pid,
				comm: r.comm,
				cpuMsPerIqSecond: perIq(r.cpuMs - (before.get(r.pid)?.cpuMs ?? 0)),
			}))
			.sort((x, y) => (y.cpuMsPerIqSecond ?? 0) - (x.cpuMsPerIqSecond ?? 0))
	}

	// ws clients: their first two marks.
	const ws: Manifest["results"]["ws"] = []
	const wsDir = join(outDir, "ws")
	for (const f of existsSync(wsDir) ? readdirSync(wsDir).sort() : []) {
		if (!f.endsWith(".jsonl")) continue
		const m = marks(
			readJsonl(join(wsDir, f))
				.map(l => WsLineSchema.safeParse(l))
				.flatMap(r => (r.success ? [r.data] : [])),
		)
		const a = m[0]
		const b = m[1]
		const client = f.replace(/\.jsonl$/, "")
		if (!a || !b) {
			ws.push({
				client,
				messagesPerSecond: null,
				bytesPerSecond: null,
				byType: {},
			})
			continue
		}
		const s = (b.ms - a.ms) / 1000
		const byType: Record<string, { messages: number; bytes: number }> = {}
		for (const [k, v] of Object.entries(b.byType)) {
			const p = a.byType[k]
			byType[k] = {
				messages: s > 0 ? (v.messages - (p?.messages ?? 0)) / s : 0,
				bytes: s > 0 ? (v.bytes - (p?.bytes ?? 0)) / s : 0,
			}
		}
		ws.push({
			client,
			messagesPerSecond: s > 0 ? (b.messages - a.messages) / s : null,
			bytesPerSecond: s > 0 ? (b.bytes - a.bytes) / s : null,
			byType,
		})
	}

	// Profile and counts.
	const bundlePath =
		meta.tier === "B" ? join(outDir, "index.js") : meta.corePath
	const bundleText = existsSync(bundlePath)
		? readFileSync(bundlePath, "utf8")
		: ""
	const isBundleUrl = (url: string): boolean => url === meta.bundleUrl
	let buckets: Manifest["results"]["buckets"] = null
	let profileBusyShare: number | null = null
	let longTaskReport: Manifest["results"]["longTasks"] = null
	const profPath = join(outDir, "main.cpuprofile")
	if (meta.profile) {
		const prof = existsSync(profPath)
			? CpuProfileSchema.safeParse(readJson(profPath))
			: null
		if (prof?.success) {
			const sum = summariseProfile(prof.data, bundleText, { isBundleUrl })
			if (sum.warning !== null) warnings.push(sum.warning)
			buckets =
				sum.buckets?.map(x => ({
					id: x.id,
					label: x.label,
					share: x.share,
					nativeWriteShare: x.nativeWriteShare,
				})) ?? null
			profileBusyShare = sum.busyShare
			longTaskReport = sum.longTasks
		} else
			warnings.push(
				"--profile was asked for but no valid CPU profile was written",
			)
	}
	let callsPerSecond: Manifest["results"]["callsPerSecond"] = null
	const covPath = join(outDir, "coverage.json")
	if (meta.counts && existsSync(covPath)) {
		const cov = CoverageFileSchema.safeParse(readJson(covPath))
		if (cov.success && cov.data.seconds > 0) {
			const counts = callCounts(
				cov.data.result,
				bundleText,
				COUNTED_FUNCTIONS,
				{
					isBundleUrl,
				},
			)
			const calls: Record<string, number | null> = {}
			for (const [k, v] of Object.entries(counts))
				calls[k] = v === null ? null : v / cov.data.seconds
			callsPerSecond = {
				perturbed: true,
				windowSeconds: cov.data.seconds,
				calls,
			}
		}
	}

	// Coverage of the work classes.
	const classes: Manifest["coverage"]["classes"] = {}
	classes["sourceChunks"] = {
		count: win.sourceChunks,
		source: "preload: data events on the IQ source socket (timing window)",
	}
	const fromCalls = (name: string): number | null => {
		const v = callsPerSecond?.calls[name]
		return v === undefined || v === null || !callsPerSecond
			? null
			: Math.round(v * callsPerSecond.windowSeconds)
	}
	const wsTypeSum = (rx: RegExp): number | null => {
		if (ws.length === 0) return null
		let n = 0
		for (const c of ws)
			for (const [k, v] of Object.entries(c.byType))
				if (rx.test(k)) n += v.messages * windowSeconds
		return Math.round(n)
	}
	classes["spectrumBlocks"] = callsPerSecond
		? {
				count: fromCalls("ingest"),
				source: "counts window: SpectrumEngine.ingest calls",
			}
		: {
				count: wsTypeSum(/^spectrum:/),
				source: "proxy: spectrum frames to the clients (timing window)",
			}
	classes["trackEvents"] = callsPerSecond
		? {
				count: fromCalls("onTrack"),
				source: "counts window: scanner onTrack calls",
			}
		: {
				count: wsTypeSum(/^events:scanner:(activity|discovery)/),
				source:
					"proxy: scanner activity and discovery messages to the clients (timing window)",
			}
	const decA = DecisionsSchema.safeParse(
		readJson(join(outDir, "decisions-start.json")),
	)
	const decB = DecisionsSchema.safeParse(
		readJson(join(outDir, "decisions-end.json")),
	)
	const started = (d: z.infer<typeof DecisionsSchema>): number =>
		d.counts?.["started"] ?? 0
	classes["recorderSessions"] = {
		count:
			decA.success && decB.success && decA.data.counts && decB.data.counts
				? started(decB.data) - started(decA.data)
				: null,
		source: "api: recorder `started` decisions in the timing window",
	}
	const decoders = DecodersSchema.safeParse(
		readJson(join(outDir, "decoders-end.json")),
	)
	classes["decodersRunning"] = {
		count: decoders.success
			? decoders.data.filter(d => d.running === true).length
			: null,
		source: "api: decoders running at the end of the timing window",
	}
	const placements = fromCalls("reconcilePlacementsPass")
	classes["placementPasses"] = callsPerSecond
		? {
				count: placements,
				source:
					placements === null
						? "counts window: reconcilePlacementsPass absent from the coverage (V8 leaves out a function not called since the reset; null, not 0)"
						: "counts window: reconcilePlacementsPass calls",
			}
		: { count: null, source: "needs --counts" }
	for (const c of ws)
		classes[`wsMessages:${c.client}`] = {
			count:
				c.messagesPerSecond === null
					? null
					: Math.round(c.messagesPerSecond * windowSeconds),
			source: "client marks (timing window)",
		}
	const missing = Object.entries(classes)
		.filter(([, v]) => v.count === 0)
		.map(([k]) => k)
	const unknown = Object.entries(classes)
		.filter(([, v]) => v.count === null)
		.map(([k]) => k)

	const gc: Manifest["results"]["gc"] = {}
	for (const [k, v] of Object.entries(win.gc))
		gc[k] = { count: v.count, ms: v.ms ?? 0 }
	const writesPerSecond: Manifest["results"]["writesPerSecond"] = {}
	for (const [k, v] of Object.entries(win.writes))
		writesPerSecond[k] = { count: perS(v.count), bytes: perS(v.bytes ?? 0) }

	const manifest: Manifest = {
		schema: 2,
		label: meta.label,
		tier: meta.tier,
		commit: meta.commit,
		core: {
			path: meta.corePath,
			sha256: meta.coreSha256,
			imageId: meta.imageId,
			overlay: meta.overlay,
		},
		scene: meta.scene,
		composition: {
			parts: meta.parts,
			clients: meta.clients,
			passive: meta.passive,
			notes: meta.notes,
			listenersChecked: meta.listenersChecked,
		},
		profiledTimingWindow: meta.profile,
		coverage: { classes, missing, unknown },
		rateHz: meta.rateHz,
		startUtc: win.startUtc,
		endUtc: win.endUtc,
		windowSeconds,
		windowSecondsRequested: meta.windowSecondsRequested,
		warmupSeconds: meta.warmupSeconds,
		iqSeconds,
		iqSecondsFake: iq.iqSecondsFake,
		iqSecondsDisagreement: iq.iqSecondsDisagreement,
		warnings,
		host: {
			platform: win.platform,
			cpus: os.cpus().length,
			loadSamples,
			load: spread(loadSamples),
			outerLoad: meta.outerLoad
				? spread(
						meta.outerLoad.filter((v): v is number => typeof v === "number"),
					)
				: null,
		},
		runQueueWaitShare: rq,
		timingValid: verdict.timingValid,
		timingInvalidReasons: verdict.timingInvalidReasons,
		results: {
			mainCpuMsPerIqSecond: perIq(win.mainCpuUs / 1000),
			processCpuMsPerIqSecond: perIq(win.processCpuUs / 1000),
			workers,
			workersUnknownReason,
			threads,
			children,
			childrenUnknownReason,
			elu: win.elu.utilization,
			loopDelayMs: {
				p50: win.loopDelayMs?.p50 ?? null,
				p99: win.loopDelayMs?.p99 ?? null,
				max: win.loopDelayMs?.max ?? null,
			},
			gc,
			contextSwitches: {
				voluntary: perS(win.contextSwitches.voluntary),
				involuntary: perS(win.contextSwitches.involuntary),
			},
			writesPerSecond,
			structuredClonePerSecond: perS(win.structuredClone),
			ws,
			sourceChunksPerSecond:
				win.sourceChunks === null ? null : perS(win.sourceChunks),
			sourceSkippedSeconds,
			buckets,
			profileBusyShare,
			longTasks: longTaskReport,
			callsPerSecond,
		},
	}
	return ManifestSchema.parse(manifest)
}

function writeManifest(outDir: string, manifest: Manifest): void {
	writeFileSync(
		join(outDir, "manifest.json"),
		`${JSON.stringify(manifest, null, 2)}\n`,
	)
	const r = manifest.results
	const f = (v: number | null, d = 1): string =>
		v === null ? "n/a" : v.toFixed(d)
	process.stdout.write(
		[
			`manifest ${join(outDir, "manifest.json")}`,
			`  main-thread CPU ${f(r.mainCpuMsPerIqSecond)} ms per IQ s, process CPU ${f(r.processCpuMsPerIqSecond)} ms per IQ s, ${manifest.iqSeconds.toFixed(1)} IQ s in ${manifest.windowSeconds.toFixed(1)} s`,
			`  timing ${manifest.timingValid ? "valid" : `not valid: ${manifest.timingInvalidReasons.join("; ")}`}`,
			`  warnings: ${manifest.warnings.join("; ") || "none"}`,
			`  coverage missing: ${manifest.coverage.missing.join(", ") || "none"}; unknown: ${manifest.coverage.unknown.join(", ") || "none"}`,
			"",
		].join("\n"),
	)
}

// === tier A ===

function sceneFor(rateHz: number): Scene {
	const overs = (pairs: readonly [number, number][]): Interval[] =>
		pairs.map(([startMs, endMs]) => ({ startMs, endMs }))
	const bursts: Interval[] = []
	for (let t = 2_000; t + 1_200 <= SCENE_MS; t += 3_000)
		bursts.push({ startMs: t, endMs: t + 1_200 })
	return buildScene({
		name: `budget-${rateHz}`,
		rateHz,
		centreHz: CENTRE_HZ,
		durationMs: SCENE_MS,
		seed: 20_261_116,
		noiseSigma: 0.03,
		signals: [
			{
				class: "nfm-voice",
				offsetHz: VOICE_A_HZ,
				snrDb: 20,
				intervals: overs([
					[1_000, 7_000],
					[11_000, 17_000],
				]),
			},
			{
				class: "nfm-voice",
				offsetHz: -200_000,
				snrDb: 15,
				intervals: overs([
					[3_500, 9_000],
					[13_000, 18_500],
				]),
			},
			{ class: "dmr", offsetHz: 300_000, snrDb: 20, intervals: bursts },
			{
				class: "carrier",
				offsetHz: -60_000,
				snrDb: 25,
				intervals: [{ startMs: 0, endMs: SCENE_MS }],
			},
		],
	})
}

/** The scene as one CU8 file; returns its sha256. */
function writeScene(scene: Scene, path: string): string {
	const gen = new SceneGenerator(scene)
	const parts: Buffer[] = []
	const hash = createHash("sha256")
	for (;;) {
		const chunk = gen.next(1 << 16)
		if (chunk === null) break
		hash.update(chunk)
		parts.push(chunk)
	}
	writeFileSync(path, Buffer.concat(parts))
	return hash.digest("hex")
}

interface Proc {
	child: ChildProcess
	exited: Promise<number | null>
	name: string
}

const procs: Proc[] = []
/** The work dir to remove if a signal ends the run early. */
const held: { work: string | null } = { work: null }

function start(
	name: string,
	cmd: string,
	args: readonly string[],
	opts: { cwd?: string; env?: NodeJS.ProcessEnv; logTo?: Buffer[] } = {},
): Proc {
	const child = spawn(cmd, args, {
		cwd: opts.cwd,
		env: opts.env ?? process.env,
		stdio: ["ignore", "pipe", "pipe"],
	})
	const exited = new Promise<number | null>(r => {
		child.once("exit", code => r(code))
		child.once("error", () => r(null))
	})
	if (opts.logTo) {
		const sink = opts.logTo
		child.stdout?.on("data", (d: Buffer) => sink.push(d))
		child.stderr?.on("data", (d: Buffer) => sink.push(d))
	} else {
		child.stdout?.resume()
		child.stderr?.resume()
	}
	const p = { child, exited, name }
	procs.push(p)
	return p
}

function alive(p: Proc): boolean {
	return p.child.exitCode === null && p.child.signalCode === null
}

/** Stop a process this harness started, by its own handle (never by name). */
async function stop(
	p: Proc,
	signal: NodeJS.Signals,
	graceMs: number,
): Promise<void> {
	if (!alive(p)) return
	p.child.kill(signal)
	const done = await Promise.race([
		p.exited.then(() => true),
		sleep(graceMs).then(() => false),
	])
	if (!done && alive(p)) {
		p.child.kill("SIGKILL")
		await Promise.race([p.exited, sleep(5000)])
	}
}

async function firstLine(
	p: Proc,
	rx: RegExp,
	timeoutMs: number,
): Promise<RegExpExecArray> {
	return new Promise((res, rej) => {
		let text = ""
		const onData = (d: Buffer): void => {
			text += d.toString("utf8")
			const m = rx.exec(text)
			if (m) {
				cleanup()
				res(m)
			}
		}
		const timer = setTimeout(() => {
			cleanup()
			rej(
				new WaveKitError(
					`${p.name}: no ${String(rx)} in ${timeoutMs} ms`,
					"BUDGET_START",
				),
			)
		}, timeoutMs)
		const cleanup = (): void => {
			clearTimeout(timer)
			p.child.stdout?.off("data", onData)
			p.child.stderr?.off("data", onData)
		}
		p.child.stdout?.on("data", onData)
		p.child.stderr?.on("data", onData)
	})
}

async function getJson(
	url: string,
	headers: Record<string, string> = {},
): Promise<unknown> {
	try {
		const res = await fetch(url, {
			headers,
			signal: AbortSignal.timeout(10_000),
		})
		return res.ok ? await res.json() : null
	} catch {
		return null
	}
}

async function waitUp(
	url: string,
	headers: Record<string, string>,
	core: Proc,
	timeoutMs: number,
): Promise<void> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		if (!alive(core))
			throw new WaveKitError(
				"scratch core exited before coming up",
				"BUDGET_UP",
			)
		if ((await getJson(url, headers)) !== null) return
		await sleep(500)
	}
	throw new WaveKitError("scratch core did not come up", "BUDGET_UP")
}

/** Waits for a collector's "started" line (it has started the profiler or coverage). */
async function startCollector(
	mode: "profile" | "coverage",
	inspector: string,
	seconds: number,
	outFile: string,
): Promise<Proc> {
	const p = start(`collect-${mode}`, process.execPath, [
		join(benchDir, "budget-preload.mjs"),
		"collect",
		mode,
		inspector,
		String(seconds),
		outFile,
	])
	await firstLine(p, /^started/m, 30_000)
	return p
}

/** Runs a `dist/access-command.js` subcommand; throws with its stderr on failure. */
function accessCommand(
	command: string,
	args: readonly string[],
	env: NodeJS.ProcessEnv,
): void {
	const r = spawnSync(process.execPath, [command, ...args], {
		env,
		encoding: "utf8",
		timeout: 30_000,
	})
	if (r.status !== 0)
		throw new WaveKitError(
			`access-command ${args[0] ?? ""} failed: ${(r.stderr || r.stdout).slice(-500)}`,
			"BUDGET_ACCESS",
		)
}

/**
 * Every TCP listener of `pid` must be on 127.0.0.1 or [::1]. Returns false when it cannot be
 * checked (no lsof, or a platform other than macOS and Linux); throws on any other listener.
 */
function checkLoopbackListeners(pid: number): boolean {
	if (process.platform !== "darwin" && process.platform !== "linux")
		return false
	const r = spawnSync(
		"lsof",
		["-nP", "-iTCP", "-sTCP:LISTEN", "-a", "-p", String(pid)],
		{ encoding: "utf8", timeout: 30_000 },
	)
	if (r.error !== undefined) return false
	const listeners = parseLsofListeners(r.stdout)
	if (listeners.length === 0)
		throw new WaveKitError(
			`lsof listed no TCP listener of the scratch core (PID ${pid}); cannot verify it binds loopback only`,
			"BUDGET_LISTEN",
		)
	const bad = nonLoopbackListeners(listeners)
	if (bad.length > 0)
		throw new WaveKitError(
			`the scratch core listens beyond loopback: ${bad.map(l => `${l.address}:${l.port}`).join(", ")}; aborting`,
			"BUDGET_LISTEN",
		)
	log(
		`listeners of the core, all loopback: ${listeners.map(l => `${l.address}:${l.port}`).join(", ")}`,
	)
	return true
}

async function tierA(): Promise<void> {
	const rateHz = numOpt("rate", 1_024_000, [1_024_000, 2_400_000])
	const requestedSeconds = numOpt("seconds", 60)
	const warmup = numOpt("warmup", 20)
	const clients = numOpt("clients", 1, [0, 1, 2])
	const passiveOpt = opt("passive") ?? "on"
	if (passiveOpt !== "on" && passiveOpt !== "off")
		throw new WaveKitError(`bad --passive ${passiveOpt}`, "BUDGET_ARGS")
	const passive = passiveOpt === "on"
	const profile = flag("profile")
	const counts = flag("counts")
	const keep = flag("keep")
	const label = opt("label") ?? "run"
	const coreArg = resolve(opt("core") ?? join(root, "dist/index.js"))
	if (!existsSync(coreArg))
		throw new WaveKitError(`no core bundle at ${coreArg}`, "BUDGET_ARGS")
	// Profile URLs name the resolved file, so compare against its real path.
	const corePath = realpathSync(coreArg)
	const accessCmd = join(dirname(corePath), "access-command.js")
	if (!existsSync(accessCmd))
		throw new WaveKitError(
			`no access-command.js next to ${corePath} (pnpm run build)`,
			"BUDGET_ARGS",
		)
	if (requestedSeconds < 10)
		throw new WaveKitError("--seconds must be at least 10", "BUDGET_ARGS")
	const { seconds, rounded } = roundWindowUp(requestedSeconds, SCENE_MS / 1000)
	if (rounded)
		log(
			`--seconds ${requestedSeconds} is not a whole number of ${SCENE_MS / 1000} s scene periods: measuring ${seconds} s`,
		)
	const outArg = opt("out")
	const outDir = outArg
		? resolve(outArg)
		: mkdtempSync(join(os.tmpdir(), "wk-budget-out-"))
	mkdirSync(join(outDir, "preload"), { recursive: true })
	mkdirSync(join(outDir, "ws"), { recursive: true })
	log(`out ${outDir}`)
	const work = mkdtempSync(join(os.tmpdir(), "wk-budget-"))
	chmodSync(work, 0o700)
	if (!keep) held.work = work
	const coreLog: Buffer[] = []
	let core: Proc | null = null
	try {
		// Scene and fake source.
		const scene = sceneFor(rateHz)
		log(`writing scene ${scene.name} (${SCENE_MS / 1000} s)`)
		const iqPath = join(work, "scene.cu8")
		const sceneSha = writeScene(scene, iqPath)
		writeFileSync(join(work, "playlist.txt"), `scene.cu8 ${rateHz}\n`)
		const fake = start("fake", process.execPath, [
			join(benchDir, "budget-fake-rtltcp.mjs"),
			"0",
			join(work, "playlist.txt"),
			join(outDir, "fake.jsonl"),
		])
		const fakePort = Number(
			(await firstLine(fake, /\{"port":(\d+)\}/, 30_000))[1],
		)
		if (!Number.isInteger(fakePort) || BANNED_PORTS.has(fakePort))
			throw new WaveKitError(`fake port ${fakePort} refused`, "BUDGET_PORT")

		// Stand-ins on a tmp PATH.
		const binDir = join(work, "bin")
		mkdirSync(binDir)
		const script = (name: string, body: string): void => {
			const path = join(binDir, name)
			writeFileSync(path, `#!/bin/sh\n${body}\n`)
			chmodSync(path, 0o755)
		}
		script(
			"csdr",
			`exec python3 ${shellQuote(join(root, "scripts/profile-stub-csdr.py"))} "$@"`,
		)
		for (const tool of DECODER_STANDINS) script(tool, "exec cat > /dev/null")
		for (const tool of RECEIVER_TOOLS) script(tool, "exit 127")
		const chanBin = process.env["WAVEKIT_CHAN_BIN"]
		const realChan =
			chanBin !== undefined &&
			chanBin !== "" &&
			existsSync(chanBin) &&
			statSync(chanBin).isFile()

		const ports = {
			api: await freePort(),
			audio: await freePort(),
			live: await freePort(),
			voice: await freePort(),
		}
		const origin = (port: number): string => `http://127.0.0.1:${port}`
		// Protected mode with loopback bind hosts: in legacy mode the live-demod and digital-voice
		// HTTP audio listeners bind every interface (src/index.ts passes them no host).
		const access = {
			mode: "protected",
			listenerScheme: "http",
			exposure: "local-http",
			allowedAuthorities: [`127.0.0.1:${ports.api}`],
			allowedOrigins: [origin(ports.api)],
			audio: {
				analog: {
					allowedAuthorities: [`127.0.0.1:${ports.live}`],
					bindHost: "127.0.0.1",
				},
				digital: {
					allowedAuthorities: [`127.0.0.1:${ports.voice}`],
					bindHost: "127.0.0.1",
				},
			},
			publicOrigins: {
				api: origin(ports.api),
				analogAudio: origin(ports.live),
				digitalAudio: origin(ports.voice),
			},
			healthProbe: {
				target: origin(ports.api),
				host: `127.0.0.1:${ports.api}`,
			},
		}
		const stateDir = join(work, "state")
		mkdirSync(stateDir, { mode: 0o700 })
		const privateDir = join(work, "private")
		mkdirSync(privateDir, { mode: 0o700 })
		const config = {
			access,
			region: "EU",
			stateDir,
			sources: [
				{
					id: SOURCE_ID,
					type: "rtl_tcp",
					host: "127.0.0.1",
					port: fakePort,
					stallTimeoutMs: 0,
					caps: {
						kind: "iq",
						format: "U8_IQ",
						sampleRate: rateHz,
						centerFreq: CENTRE_HZ,
						exclusive: false,
					},
				},
			],
			decoders: [],
			api: { host: "127.0.0.1", port: ports.api },
			audio: { tcpPort: ports.audio, host: "127.0.0.1", monitoring: false },
			tunerRelay: { enabled: false },
			liveDemod: {
				enabled: true,
				sourceId: SOURCE_ID,
				engine: "csdr",
				modulation: "nfm",
				offsetHz: VOICE_A_HZ,
				httpPort: ports.live,
			},
			digitalVoice: { enabled: true, httpPort: ports.voice },
			channelizer: realChan
				? { enabled: true, binaryPath: chanBin, socketDir: join(work, "chan") }
				: { enabled: false, auto: false },
			scanner: {
				passive: { enabled: passive, maxEngineUtilization: 1 },
			},
			resources: {
				containerMonitor: { enabled: false },
				sdrHostPoller: { enabled: false },
			},
			aircraftInfo: { online: false, localDb: { enabled: false } },
		}
		const configPath = join(work, "config.yaml")
		writeFileSync(configPath, JSON.stringify(config, null, 2))
		writeFileSync(join(outDir, "config.json"), JSON.stringify(config, null, 2))

		const env: NodeJS.ProcessEnv = {}
		for (const [k, v] of Object.entries(process.env))
			if (
				!k.startsWith("WAVEKIT_") &&
				!k.startsWith("BUDGET_") &&
				k !== "NODE_OPTIONS"
			)
				env[k] = v
		// The scratch access state: setup, then a copy of the machine credential for the clients.
		accessCommand(
			accessCmd,
			[
				"setup",
				"--private-directory",
				privateDir,
				"--ownership",
				"single-host-pid-namespace",
				"--api-origin",
				origin(ports.api),
				"--allow-origin",
				origin(ports.api),
				"--external-audio-origin",
				origin(ports.live),
				"--external-audio-origin",
				origin(ports.voice),
			],
			env,
		)
		const tokenPath = join(work, "machine-token")
		accessCommand(
			accessCmd,
			["machine-token", "--private-directory", privateDir, "--out", tokenPath],
			env,
		)
		const token = readFileSync(tokenPath, "utf8").trim()
		if (token === "")
			throw new WaveKitError("empty machine credential", "BUDGET_ACCESS")
		const auth = { Authorization: `Bearer ${token}` }
		env["WAVEKIT_CONFIG"] = configPath
		env["WAVEKIT_ACCESS_PRIVATE_DIRECTORY"] = privateDir
		env["PATH"] = `${binDir}:${process.env["PATH"] ?? ""}`
		env["BUDGET_OUT"] = join(outDir, "preload")
		env["BUDGET_SOURCE_PORT"] = String(fakePort)
		env["BUDGET_CORE_MATCH"] = `${basename(corePath).replaceAll(".", "\\.")}$`
		const inspect = profile || counts
		const nodeArgs = [
			...(inspect ? ["--inspect=127.0.0.1:0"] : []),
			"--import",
			join(benchDir, "budget-preload.mjs"),
			corePath,
		]
		log(
			`starting scratch core (api 127.0.0.1:${ports.api}, fake 127.0.0.1:${fakePort})`,
		)
		core = start("core", "nice", ["-n", "10", process.execPath, ...nodeArgs], {
			cwd: work,
			env,
			logTo: coreLog,
		})
		let inspector = ""
		if (inspect) {
			const m = await firstLine(
				core,
				/Debugger listening on ws:\/\/127\.0\.0\.1:(\d+)\//,
				60_000,
			)
			const port = Number(m[1])
			if (BANNED_PORTS.has(port))
				throw new WaveKitError(`inspector port ${port} refused`, "BUDGET_PORT")
			inspector = `127.0.0.1:${port}`
		}
		const api = `http://127.0.0.1:${ports.api}`
		await waitUp(`${api}/api/status`, auth, core, 180_000)
		const startedPid = core.child.pid
		if (startedPid === undefined)
			throw new WaveKitError("scratch core has no PID", "BUDGET_UP")
		const listenersChecked = checkLoopbackListeners(startedPid)
		if (!listenersChecked)
			log("lsof is not available here: the core's listeners were not checked")
		for (let i = 1; i <= clients; i++)
			start(`ws-${i}`, process.execPath, [
				join(benchDir, "budget-ws-client.mjs"),
				`ws://127.0.0.1:${ports.api}/ws`,
				token,
				join(outDir, "ws"),
				"--spectrum",
				"--source",
				SOURCE_ID,
				"--name",
				`client-${i}`,
			])
		log(`core up, warm-up ${warmup} s, load ${os.loadavg()[0]?.toFixed(1)}`)
		await sleep(warmup * 1000)
		const corePid = core.child.pid
		if (corePid === undefined || !alive(core))
			throw new WaveKitError("scratch core is not running", "BUDGET_UP")
		// Never signal a core whose preload did not activate (SIGUSR2 would end it).
		if (!existsSync(join(outDir, "preload", "preload.json")))
			throw new WaveKitError(
				"the preload did not activate in the scratch core (no preload/preload.json); not signalling it",
				"BUDGET_PRELOAD",
			)
		const markAll = (): void => {
			for (const p of procs)
				if ((p.name === "fake" || p.name.startsWith("ws-")) && alive(p))
					p.child.kill("SIGUSR2")
		}

		// Timing window.
		writeFileSync(
			join(outDir, "decisions-start.json"),
			JSON.stringify(
				await getJson(`${api}/api/scanner/recorder/decisions?limit=1`, auth),
			),
		)
		const prof = profile
			? await startCollector(
					"profile",
					inspector,
					seconds,
					join(outDir, "main.cpuprofile"),
				)
			: null
		// Children's CPU from just before the window opens (after the collector start).
		writeFileSync(join(outDir, "ps-start.txt"), psUnder(corePid))
		markAll()
		core.child.kill("SIGUSR2")
		const startUtc = new Date().toISOString()
		log(`window open ${startUtc}, ${seconds} s`)
		await sleep(seconds * 1000)
		core.child.kill("SIGUSR2")
		markAll()
		writeFileSync(join(outDir, "ps-end.txt"), psUnder(corePid))
		writeFileSync(
			join(outDir, "decisions-end.json"),
			JSON.stringify(
				await getJson(`${api}/api/scanner/recorder/decisions?limit=1`, auth),
			),
		)
		if (prof) await Promise.race([prof.exited, sleep(60_000)])
		writeFileSync(
			join(outDir, "decoders-end.json"),
			JSON.stringify(await getJson(`${api}/api/decoders`, auth)),
		)
		writeFileSync(
			join(outDir, "status-end.json"),
			JSON.stringify(await getJson(`${api}/api/status`, auth)),
		)

		// Counts window (perturbed: call counts only).
		if (counts) {
			log(`counts window ${seconds} s`)
			const cov = await startCollector(
				"coverage",
				inspector,
				seconds,
				join(outDir, "coverage.json"),
			)
			await Promise.race([cov.exited, sleep((seconds + 60) * 1000)])
		}

		// Stop clients, core, fake.
		for (const p of procs)
			if (p.name.startsWith("ws-")) await stop(p, "SIGTERM", 5000)
		await stop(core, "SIGINT", 20_000)
		await stop(fake, "SIGTERM", 5000)
		writeFileSync(join(outDir, "core.log"), Buffer.concat(coreLog))

		const parts: RunMeta["parts"] = {
			iqSource: "stand-in",
			sceneIq: "stand-in",
			spectrum: "real",
			passiveScanner: passive ? "real" : "absent",
			widebandRecorder: passive ? "real" : "absent",
			liveDemodCore: "real",
			liveDemodChain: "stand-in",
			channelizer: realChan ? "real" : "absent",
			decoderManager: "real",
			// Catalogue decoders need the channelizer: without it they stay suspended.
			decoderBinaries: realChan ? "stand-in" : "absent",
			activityStore: "real",
			wsClients: clients > 0 ? "real" : "absent",
			iqCapture: "absent",
		}
		const meta: RunMeta = {
			tier: "A",
			label,
			rateHz,
			clients,
			passive,
			profile,
			counts,
			coreSha256: sha256File(corePath),
			corePath,
			bundleUrl: pathToFileURL(corePath).href,
			imageId: null,
			scene: { id: scene.name, sha256: sceneSha, fixtures: "modelled" },
			parts,
			notes: [
				"access protected (local-http, every listener bound to 127.0.0.1; the raw audio TCP port and the tuner relay do not run in protected mode), region EU, logging at the default level",
				"passive guard limit maxEngineUtilization 1, so a loaded host does not turn passive off mid-run",
				`stand-in decoder executables: ${DECODER_STANDINS.join(", ")} (read and discard stdin)`,
				...(realChan
					? []
					: [
							"no channelizer (WAVEKIT_CHAN_BIN unset): catalogue decoders are placed but suspended (channelizer-unavailable), so no decoder process runs",
						]),
				"csdr: scripts/profile-stub-csdr.py (rate-only)",
				"iq capture not enabled (scanner.iqCapture unset)",
			],
			commit: gitCommit(),
			outerLoad: null,
			windowSecondsRequested: requestedSeconds,
			warmupSeconds: warmup,
			listenersChecked,
			overlay: null,
			warnings: [],
		}
		writeFileSync(
			join(outDir, "run.json"),
			JSON.stringify(RunMetaSchema.parse(meta), null, 2),
		)
		writeManifest(outDir, assemble(outDir, meta))
	} catch (err) {
		log(`failed: ${err instanceof Error ? err.message : String(err)}`)
		log(Buffer.concat(coreLog).toString("utf8").slice(-3000))
		process.exitCode = 1
	} finally {
		for (const p of [...procs].reverse()) await stop(p, "SIGTERM", 5000)
		if (coreLog.length > 0 && !existsSync(join(outDir, "core.log")))
			writeFileSync(join(outDir, "core.log"), Buffer.concat(coreLog))
		if (keep) log(`kept work dir ${work}`)
		else rmSync(work, { recursive: true, force: true })
		log(`results in ${outDir}`)
	}
}

// === tier B post-processing ===

const ImageRunSchema = z.object({
	label: z.string(),
	clients: z.number().int(),
	passive: z.boolean(),
	profile: z.boolean(),
	counts: z.boolean(),
	imageId: z.string(),
	configSha256: z.string(),
	sourceId: z.string(),
	tuneHz: z.number().nullable(),
	iqDir: z.string(),
	windowSeconds: z.number(),
	warmupSeconds: z.number(),
})
const OverlayFileSchema = z.array(
	z.object({
		file: z.string().regex(/^[A-Za-z0-9._-]+$/),
		sha256: z.string().regex(/^[0-9a-f]{64}$/),
	}),
)

/** sha256 over each playlist file's sha256 and rate, in playlist order. */
function playlistScene(
	playlistPath: string,
	iqDir: string,
): { sha256: string; rateHz: number } {
	const outer = createHash("sha256")
	let rateHz = 0
	for (const raw of readFileSync(playlistPath, "utf8").split("\n")) {
		const line = raw.trim()
		if (line === "" || line.startsWith("#")) continue
		const [file, rate, secs] = line.split(/\s+/)
		if (!file || !rate) continue
		// Inside the container the IQ dir is /iq; map it back to the host directory.
		const host = file.startsWith("/iq/")
			? join(iqDir, file.slice(4))
			: isAbsolute(file)
				? file
				: join(dirname(playlistPath), file)
		outer.update(`${sha256File(host)} ${rate} ${secs ?? ""}\n`)
		if (rateHz === 0) rateHz = Number(rate)
	}
	return { sha256: outer.digest("hex"), rateHz }
}

function finishImage(dirArg: string): void {
	const outDir = resolve(dirArg)
	const run = ImageRunSchema.parse(readJson(join(outDir, "run-image.json")))
	const { sha256, rateHz } = playlistScene(
		join(outDir, "playlist.txt"),
		run.iqDir,
	)
	const bundle = join(outDir, "index.js")
	if (!existsSync(bundle))
		throw new WaveKitError(`no bundle copied to ${bundle}`, "BUDGET_FINISH")
	const coreSha256 = sha256File(bundle)
	// The overlay's index.js, when there is one, is the bundle that ran (the script copied it
	// from the overlay directory on the host).
	const overlay = existsSync(join(outDir, "overlay.json"))
		? OverlayFileSchema.parse(readJson(join(outDir, "overlay.json")))
		: null
	const overlayIndex = overlay?.find(f => f.file === "index.js")
	if (overlayIndex !== undefined && overlayIndex.sha256 !== coreSha256)
		throw new WaveKitError(
			"index.js in the out dir is not the overlay's index.js",
			"BUDGET_FINISH",
		)
	// One entry per uptime line; a line that does not parse is null (makes tier B timing invalid).
	const outerLoad: (number | null)[] = []
	if (existsSync(join(outDir, "uptime.txt")))
		for (const line of readFileSync(join(outDir, "uptime.txt"), "utf8").split(
			"\n",
		)) {
			if (line.trim() === "") continue
			const m = /load averages?:\s*([\d.]+)/.exec(line)
			const v = m ? Number(m[1]) : Number.NaN
			outerLoad.push(Number.isFinite(v) ? v : null)
		}
	const meta: RunMeta = {
		tier: "B",
		label: opt("label") ?? run.label,
		rateHz,
		clients: run.clients,
		passive: run.passive,
		profile: run.profile,
		counts: run.counts,
		coreSha256,
		corePath: "/app/dist/index.js",
		bundleUrl: "file:///app/dist/index.js",
		imageId: run.imageId,
		scene: {
			id: `playlist-${sha256.slice(0, 12)}`,
			sha256,
			fixtures: "recorded",
		},
		parts: {
			iqSource: "stand-in",
			sceneIq: "real",
			spectrum: "unknown",
			passiveScanner: run.passive ? "unknown" : "absent",
			decoderBinaries: "unknown",
			channelizer: "unknown",
			wsClients: run.clients > 0 ? "real" : "absent",
		},
		notes: [
			`config sha256 ${run.configSha256}`,
			`tuned ${run.tuneHz === null ? "as configured" : "through the API"}`,
			"composition follows the image and its config; parts marked unknown were not inspected",
			...(overlay !== null
				? [
						`dist overlay: ${overlay.map(f => f.file).join(", ") || "(empty)"} bind-mounted read-only over /app/dist`,
					]
				: []),
		],
		commit: gitCommit(),
		outerLoad: outerLoad.length > 0 ? outerLoad : null,
		windowSecondsRequested: run.windowSeconds,
		warmupSeconds: run.warmupSeconds,
		listenersChecked: false,
		overlay,
		warnings: [],
	}
	writeFileSync(
		join(outDir, "run.json"),
		JSON.stringify(RunMetaSchema.parse(meta), null, 2),
	)
	writeManifest(outDir, assemble(outDir, meta))
}

// === entry ===

const finish = opt("finish-image")
const reassemble = opt("reassemble")
if (reassemble !== undefined) {
	try {
		const dir = resolve(reassemble)
		const meta = RunMetaSchema.parse(readJson(join(dir, "run.json")))
		writeManifest(dir, assemble(dir, meta))
	} catch (err) {
		log(`failed: ${err instanceof Error ? err.message : String(err)}`)
		process.exitCode = 1
	}
} else if (finish !== undefined) {
	try {
		finishImage(finish)
	} catch (err) {
		log(`failed: ${err instanceof Error ? err.message : String(err)}`)
		process.exitCode = 1
	}
} else {
	for (const signal of ["SIGINT", "SIGTERM"] as const)
		process.once(signal, () => {
			log(`${signal}: stopping`)
			void Promise.all([...procs].reverse().map(p => stop(p, "SIGTERM", 3000)))
				.catch(() => undefined)
				.finally(() => {
					if (held.work !== null)
						rmSync(held.work, { recursive: true, force: true })
					process.exit(signal === "SIGINT" ? 130 : 143)
				})
		})
	void tierA().catch((err: unknown) => {
		log(err instanceof Error ? (err.stack ?? err.message) : String(err))
		process.exitCode = 1
	})
}
