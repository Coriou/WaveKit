/**
 * Scanner quality benchmark (measurement only): is everything on the waterfall found and
 * identified, and how fast? Runs a seeded synthetic scene with ground truth (NFM voice and
 * push-to-talk, DMR, POCSAG, OOK and FSK ISM bursts, AFSK1200, LoRa, CW, a birdie and a DC spike
 * at several SNRs) through the real scanner (spectrum detector, frame tracks, channel gate,
 * passive-job discoveries, IQ capture requests and the real replay planner) on a virtual clock,
 * then scores detection, splitting, false discoveries, identification (fake decoders, see
 * scanner-quality/metrics.ts) and CPU. Prints a table and one JSON line.
 *
 *   pnpm exec esbuild scripts/bench/scanner-quality.ts --bundle \
 *     --platform=node --format=esm --packages=external \
 *     --outfile=output/bench/scanner-quality.mjs
 *   node output/bench/scanner-quality.mjs [--scene NAME] [--seed N] [--unbounded-captures]
 *   node output/bench/scanner-quality.mjs --file <capture.cu8> --rate <Hz> --centre <Hz> [--seconds S]
 *
 * Scenes: small, full, gfsk (one GFSK burst transmitter, ground truth 1 discovery), and the
 * false-discovery scenes noise-1024k, noise-2400k, spurs-1024k, spurs-2400k (120 s each, nothing
 * real on air), lo-spur (a receiver spur at a fixed offset while the tuner moves between two
 * centres; --lo-lock on|off), carriers (steady unmodulated carriers and one NFM over) and voice-id
 * (one 28 s NFM over with CTCSS at 20 dB). --seeds N runs N seeds and prints the onset-to-classified
 * latency of each signal. A/B switches for the weak-admission rules (docs/SCANNER.md): --rule1 on|off (the
 * duty-aware sustained median, default on) and --rule2 on|off (repeated gate passes, default
 * off); each admission the second rule makes is printed with its pass median.
 *
 * The fake capture port enforces the real one's limits (2 captures at once, 6 detection captures
 * per source per minute, a 2 s ring); --unbounded-captures grants every request instead.
 *
 * --file replays a CU8 capture (the first seconds feed the lead-in while the passive job starts)
 * and prints counts only: there is no ground truth, so nothing is scored. Nothing listens on the
 * network; the scanner state lives in a temp dir removed at the end.
 */
import { closeSync, openSync, readSync } from "node:fs"
import process from "node:process"
import type { ScannerService } from "../../src/core/scanner/scanner-service.js"
import type { PendingAdmission } from "../../src/core/scanner/store/pending-admission.js"
import type { ObservationInput } from "../../src/core/scanner/types.js"
import {
	DQ_PENDING_BUCKET_HZ,
	DQ_REPEAT_WINDOW_MS,
} from "../../src/core/scanner/detection-quality-contract.js"
import { runScanner, type IqChunkSource } from "./scanner-quality/harness.js"
import {
	formatReport,
	formatRetuned,
	formatUnscored,
	score,
	scoreRetuned,
	unscoredJson,
	type QualityReport,
} from "./scanner-quality/metrics.js"
import {
	RetunedSource,
	SceneGenerator,
	buildScene,
	carriersScene,
	loSpurScene,
	voiceIdScene,
	fullScene,
	gfskScene,
	noiseScene,
	smallScene,
	spursScene,
	type Scene,
} from "./scanner-quality/scene.js"

const arg = (name: string): string | undefined => {
	const i = process.argv.indexOf(`--${name}`)
	return i >= 0 ? process.argv[i + 1] : undefined
}
const num = (name: string): number | undefined => {
	const v = arg(name)
	if (v === undefined) return undefined
	const n = Number(v)
	if (!Number.isFinite(n) || n <= 0) {
		process.stderr.write(`--${name} needs a positive number\n`)
		process.exit(2)
	}
	return n
}

const onOff = (name: string, fallback: boolean): boolean => {
	const v = arg(name)
	if (v === undefined) return fallback
	if (v !== "on" && v !== "off") {
		process.stderr.write(`--${name} is on or off\n`)
		process.exit(2)
	}
	return v === "on"
}

const SCENES: Record<string, (seed?: number) => Scene> = {
	small: smallScene,
	full: fullScene,
	gfsk: gfskScene,
	"noise-1024k": seed => noiseScene(1_024_000, undefined, seed),
	"noise-2400k": seed => noiseScene(2_400_000, undefined, seed),
	"spurs-1024k": seed => spursScene(1_024_000, undefined, seed),
	"spurs-2400k": seed => spursScene(2_400_000, undefined, seed),
	carriers: carriersScene,
	"voice-id": seed => voiceIdScene(seed),
}

/**
 * `--lo-lock on|off` (default on): off makes the store's LO-locked spur check answer "not
 * locked", the behaviour before it existed (A/B runs).
 */
function loLockSwitch(): ((svc: ScannerService) => void) | undefined {
	if (onOff("lo-lock", true)) return undefined
	return svc => {
		const store = (
			svc as unknown as {
				store: {
					loSpurs: { check: () => { locked: boolean; partners: string[] } }
				}
			}
		).store
		store.loSpurs.check = () => ({ locked: false, partners: [] })
	}
}

/** Middle value (even count: mean of the two central ones); null when empty. */
const medianOf = (xs: readonly number[]): number | null => {
	if (xs.length === 0) return null
	const s = [...xs].sort((a, b) => a - b)
	const m = s.length >> 1
	return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}

/** Onset-to-classification latency of every signal over `--seeds N` runs (seed, seed + 1, ...). */
function formatLatency(reports: readonly QualityReport[]): string {
	const lines = [
		`onset to classified (class) and identified over ${reports.length} seeds`,
	]
	const ids = reports[0]?.signals.map(s => s.id) ?? []
	for (const id of ids)
		for (const [what, pick] of [
			[
				"classified",
				(s: QualityReport["signals"][number]) => s.timeToClassifyMs,
			],
			[
				"identified",
				(s: QualityReport["signals"][number]) => s.timeToIdentifyMs,
			],
		] as const) {
			const xs = reports.map(r => {
				const s = r.signals.find(x => x.id === id)
				return s ? pick(s) : null
			})
			const got = xs.filter((x): x is number => x !== null)
			const sorted = [...got].sort((a, b) => a - b)
			lines.push(
				`  ${id}: ${what} ${got.length}/${xs.length}, median ${fmtS(medianOf(got))}, min ${fmtS(sorted[0] ?? null)}, max ${fmtS(sorted.at(-1) ?? null)}`,
			)
		}
	const falses = reports.map(r => r.totals.falseDiscoveries)
	lines.push(`  false discoveries per seed: ${falses.join(", ")}`)
	return lines.join("\n")
}

const fmtS = (v: number | null): string =>
	v === null ? "-" : `${(v / 1000).toFixed(2)}s`

interface RepeatAdmission {
	sceneMs: number
	offsetKHz: number
	medianDb: number
}

/**
 * Sets the admission rule switches and records each repeated-pass (rule 2) admission with the
 * median of the passes it counted (read from the entry just before the promoting pass).
 */
function admissionRules(
	centreHz: number,
	out: RepeatAdmission[],
): (svc: ScannerService, sceneNow: () => number) => void {
	const rule1 = onOff("rule1", true)
	const rule2 = onOff("rule2", false)
	return (svc, sceneNow) => {
		const pending = (svc as unknown as { store: { pending: PendingAdmission } })
			.store.pending
		pending.dutyAware = rule1
		pending.repeatRule = rule2
		// The store's own clock (the harness's virtual clock), the one pass times are stamped with.
		const svcNow = (): number =>
			(pending as unknown as { now: () => number }).now()
		const repeated = pending.repeated.bind(pending)
		pending.repeated = (obs: ObservationInput): boolean => {
			const bucket = Math.round(obs.track.centreHz / DQ_PENDING_BUCKET_HZ)
			const before = pending
				.repeatEntries(obs.sourceId)
				.filter(e => Math.abs(e.bucket - bucket) <= 1)
				.flatMap(e => e.samples)
				.filter(x => x.id !== obs.id && svcNow() - x.at < DQ_REPEAT_WINDOW_MS)
				.map(x => x.snr)
			const ok = repeated(obs)
			if (ok) {
				const snr = Math.max(
					obs.track.channelSnrDb ?? obs.track.snrDb,
					obs.track.peakChannelSnrDb ?? -Infinity,
				)
				const xs = [...before, snr].sort((a, b) => a - b)
				const mid = xs.length >> 1
				out.push({
					sceneMs: sceneNow(),
					offsetKHz: (obs.track.centreHz - centreHz) / 1000,
					medianDb:
						xs.length % 2 === 1 ? xs[mid]! : (xs[mid - 1]! + xs[mid]!) / 2,
				})
			}
			return ok
		}
	}
}

function formatRepeats(rs: readonly RepeatAdmission[]): string {
	const lines = [`rule 2 admissions ${rs.length}`]
	for (const r of rs)
		lines.push(
			`  at ${(r.sceneMs / 1000).toFixed(1)} s, ${r.offsetKHz.toFixed(1)} kHz, pass median ${r.medianDb.toFixed(1)} dB`,
		)
	return lines.join("\n")
}

function fileSource(
	path: string,
	rateHz: number,
	centreHz: number,
	seconds: number | undefined,
): IqChunkSource & { close(): void } {
	const fd = openSync(path, "r")
	let left = seconds === undefined ? Infinity : Math.round(seconds * rateHz)
	const read = (samples: number): Buffer | null => {
		const n = Math.min(samples, left)
		if (n <= 0) return null
		const buf = Buffer.allocUnsafe(2 * n)
		const got = readSync(fd, buf, 0, buf.length, null)
		if (got < 2) return null
		left -= got >> 1
		return buf.subarray(0, got & ~1)
	}
	// An empty scene's generator only supplies noise once the file ran out during the lead-in.
	const filler = new SceneGenerator(
		buildScene({
			name: "lead-in",
			rateHz,
			centreHz,
			durationMs: 0,
			seed: 1,
			noiseSigma: 0.03,
			signals: [],
		}),
	)
	return {
		rateHz,
		centreHz,
		next: read,
		leadIn: n => read(n) ?? filler.noiseOnly(n),
		close: () => closeSync(fd),
	}
}

async function main(): Promise<void> {
	const file = arg("file")
	if (file !== undefined) {
		const rate = num("rate")
		const centre = num("centre")
		if (rate === undefined || centre === undefined) {
			process.stderr.write("--file needs --rate and --centre\n")
			process.exit(2)
		}
		const src = fileSource(file, rate, centre, num("seconds"))
		const repeats: RepeatAdmission[] = []
		try {
			const run = await runScanner(src, {
				inspect: admissionRules(centre, repeats),
			})
			process.stdout.write(`${formatUnscored(run)}\n`)
			process.stdout.write(`${formatRepeats(repeats)}\n\n`)
			process.stdout.write(
				`${JSON.stringify({ ...unscoredJson(run), rule2Admissions: repeats })}\n`,
			)
		} finally {
			src.close()
		}
		return
	}
	const name = arg("scene") ?? "small"
	const captureLimits = !process.argv.includes("--unbounded-captures")
	if (name === "lo-spur") {
		const seeds = num("seeds") ?? 1
		const base = num("seed") ?? 20_261_108
		for (let k = 0; k < seeds; k++) {
			const scene = loSpurScene(base + 10 * k)
			const inspect = loLockSwitch()
			const run = await runScanner(new RetunedSource(scene), {
				captureLimits,
				...(inspect ? { inspect } : {}),
			})
			const report = scoreRetuned(scene, run, { "nfm-voice-20dB": 1_000 })
			process.stdout.write(
				`${formatRetuned(report)}\n${JSON.stringify(report)}\n`,
			)
		}
		return
	}
	const make = SCENES[name]
	if (make === undefined) {
		process.stderr.write(
			`--scene is one of ${Object.keys(SCENES).join(", ")}\n`,
		)
		process.exit(2)
	}
	const seed = num("seed")
	const seeds = num("seeds")
	if (seeds !== undefined && seeds > 1) {
		const reports: QualityReport[] = []
		const first = seed ?? make().seed
		for (let k = 0; k < seeds; k++) {
			const scene = make(first + k)
			const gen = new SceneGenerator(scene)
			const run = await runScanner(
				{
					rateHz: scene.rateHz,
					centreHz: scene.centreHz,
					next: n => gen.next(n),
					leadIn: n => gen.noiseOnly(n),
				},
				{ captureLimits },
			)
			reports.push(score(scene, run))
		}
		process.stdout.write(`${formatLatency(reports)}\n`)
		return
	}
	const scene = make(seed)
	const repeats: RepeatAdmission[] = []
	const gen = new SceneGenerator(scene)
	const run = await runScanner(
		{
			rateHz: scene.rateHz,
			centreHz: scene.centreHz,
			next: n => gen.next(n),
			leadIn: n => gen.noiseOnly(n),
		},
		{
			captureLimits,
			inspect: admissionRules(scene.centreHz, repeats),
			onProgress: ms => {
				if (ms % 10_000 < 1_000)
					process.stderr.write(`  ${(ms / 1000).toFixed(0)} s\n`)
			},
		},
	)
	const report = score(scene, run)
	const perHour = (report.totals.falseDiscoveries * 3_600) / run.iqSeconds
	process.stdout.write(`${formatReport(report)}\n`)
	process.stdout.write(
		`false discoveries per IQ hour ${perHour.toFixed(1)}\n${formatRepeats(repeats)}\n\n`,
	)
	process.stdout.write(
		`${JSON.stringify({ ...report, falsePerHour: perHour, rule2Admissions: repeats })}\n`,
	)
}

main().catch((err: unknown) => {
	process.stderr.write(
		`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
	)
	process.exit(1)
})
