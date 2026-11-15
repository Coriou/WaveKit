/**
 * Proposes truth labels for CU8 captures (the scanner truth scorecard, `scanner-quality
 * --truth`). For each `<name>.cu8` with its `<name>.capture.json` in `--captures` (read only), it
 * finds the occupied channels (spectral peaks, plus the frequencies the capture's
 * `.discoveries.json` and `.activity.json` name), cuts each channel's on-air stretches, FM
 * demodulates each stretch and runs the offline decoders on it: multimon-ng (POCSAG 512, 1 200
 * and 2 400) and dsd-fme (DMR). A stretch a decoder decodes is labelled with that protocol and
 * confirmed (the decoder's CRC or FEC checked it). A stretch a live decode recorded with the
 * capture (`.activity.json`) falls in is proposed with that protocol, unconfirmed: a mixed-mode
 * channel's decode says nothing about the analog over next to it. Every other stretch is
 * proposed as `carrier` when its audio holds no modulation, else `unknown`, unconfirmed. A person
 * listens to its WAV in `<out>/<name>.segments/` and sets the label (analog-voice, noise, ...)
 * and `confirmed`. The always-on decoders' live decodes are written as the decodes the scorecard
 * injects at their recorded offsets (`via: ambient`; identify probes' are written as `probe`,
 * which the scorecard does not inject).
 *
 *   pnpm exec esbuild scripts/bench/scanner-truth-label.ts --bundle --platform=node \
 *     --format=esm --packages=external --outfile=output/bench/scanner-truth-label.mjs
 *   node output/bench/scanner-truth-label.mjs --captures <dir> --out <labels dir> [--only <name>]
 *     [--multimon <path>] [--dsd-fme <path>] [--no-decoders] [--force]
 *
 * Existing `<name>.truth.json` files are kept (labels a person confirmed) unless `--force`.
 * Writes only under `--out`. Exit 0 done, 2 bad arguments, 3 a decoder binary is missing.
 */
import { spawn } from "node:child_process"
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import process from "node:process"
import { z } from "zod"
import {
	channelSnr,
	channelsOf,
	demodulate,
	deviationRms,
	occupancy,
	parseDsdFme,
	parseMultimon,
	resample,
	segmentsOf,
	toS16,
	wav,
} from "./scanner-quality/truth-label-dsp.js"
import {
	TRUTH_SUFFIX,
	type TruthDecode,
	type TruthFile,
	type TruthInterval,
} from "./scanner-quality/truth-labels.js"

/** Channels are snapped to multiples of 3.125 kHz (half the finest land-mobile step, 6.25 kHz). */
const RASTER_HZ = 3_125
const RASTER_OFFSET_HZ = 0
/**
 * A live decode belongs to a stretch on its channel when it was produced inside it or within 1 s
 * after its end (a decoder reports a message once it ended). It is a proposal only: on a channel
 * that carries analog and digital overs a decode near an analog over says nothing about it.
 */
const LIVE_AFTER_MS = 1_000
/** A live decode names the channel it was placed on to within this (a probe's measured centre). */
const LIVE_REACH_HZ = 3_125
/** Audio deviation RMS under which a stretch is proposed as an unmodulated carrier (Hz). */
const CARRIER_RMS_HZ = 200
/** A decoder run on one stretch may take this long (a 10 s stretch decodes in well under 1 s). */
const DECODER_TIMEOUT_MS = 30_000

const CaptureMetaSchema = z
	.object({
		centerHz: z.number().positive(),
		sampleRate: z.number().positive(),
		startedAt: z.string(),
		durationS: z.number().positive(),
	})
	.passthrough()
const ActivitySchema = z.array(
	z
		.object({
			kind: z.string(),
			producedAt: z.string(),
			decoderId: z.string().optional(),
			protocol: z.string().optional(),
			frequencyHz: z.number().optional(),
			fields: z
				.array(z.object({ key: z.string(), value: z.unknown() }).passthrough())
				.optional(),
		})
		.passthrough(),
)
const DiscoveriesSchema = z.array(
	z.object({ frequencyHz: z.number() }).passthrough(),
)

const arg = (name: string): string | undefined => {
	const i = process.argv.indexOf(`--${name}`)
	return i >= 0 ? process.argv[i + 1] : undefined
}

/** A side file of a capture: `fallback` when absent, an error naming it when malformed. */
function readJson<T>(path: string, schema: z.ZodType<T>, fallback: T): T {
	if (!existsSync(path)) return fallback
	let json: unknown
	try {
		json = JSON.parse(readFileSync(path, "utf8"))
	} catch {
		throw new Error(`${path}: not JSON`)
	}
	const parsed = schema.safeParse(json)
	if (!parsed.success) {
		const issue = parsed.error.issues[0]
		throw new Error(
			`${path}: ${issue ? `${issue.path.join(".")} ${issue.message}` : "invalid"}`,
		)
	}
	return parsed.data
}

/** Runs a decoder; resolves with its stdout and stderr (a timeout kills it, by its own PID). */
function run(
	cmd: string,
	args: string[],
	stdin: Buffer | null,
): Promise<string> {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] })
		let out = ""
		child.stdout.on("data", (b: Buffer) => (out += b.toString("utf8")))
		child.stderr.on("data", (b: Buffer) => (out += b.toString("utf8")))
		const timer = setTimeout(() => child.kill("SIGKILL"), DECODER_TIMEOUT_MS)
		child.on("error", err => {
			clearTimeout(timer)
			reject(err)
		})
		child.on("close", () => {
			clearTimeout(timer)
			resolvePromise(out)
		})
		child.stdin.on("error", () => undefined)
		if (stdin) child.stdin.end(stdin)
		else child.stdin.end()
	})
}

const fieldOf = (
	row: z.infer<typeof ActivitySchema>[number],
	key: string,
): string | undefined => {
	const v = row.fields?.find(f => f.key === key)?.value
	return typeof v === "number" || typeof v === "string" ? String(v) : undefined
}

async function labelCapture(o: {
	name: string
	dir: string
	out: string
	multimon: string | null
	dsd: string | null
}): Promise<TruthFile> {
	const meta = CaptureMetaSchema.parse(
		JSON.parse(readFileSync(join(o.dir, `${o.name}.capture.json`), "utf8")),
	)
	const started = Date.parse(meta.startedAt)
	const cu8 = readFileSync(join(o.dir, `${o.name}.cu8`))
	const rate = meta.sampleRate
	const centre = meta.centerHz
	const durationMs = Math.floor(((cu8.length >> 1) * 1000) / rate)
	const activity = readJson(
		join(o.dir, `${o.name}.activity.json`),
		ActivitySchema,
		[],
	)
	const discoveries = readJson(
		join(o.dir, `${o.name}.discoveries.json`),
		DiscoveriesSchema,
		[],
	)
	const decodes: TruthDecode[] = []
	for (const row of activity) {
		if (row.kind !== "decoder-reception" || row.frequencyHz === undefined)
			continue
		if (row.protocol !== "dmr" && row.protocol !== "pocsag") continue
		const identity =
			row.protocol === "pocsag"
				? (fieldOf(row, "capcode") ?? fieldOf(row, "address"))
				: fieldOf(row, "colourCode")
		decodes.push({
			atMs: Date.parse(row.producedAt) - started,
			frequencyHz: row.frequencyHz,
			protocol: row.protocol,
			via: row.decoderId?.startsWith("scan-") ? "probe" : "ambient",
			...(identity !== undefined && /^\d{1,32}$/.test(identity)
				? { identity }
				: {}),
		})
	}
	decodes.sort((a, b) => a.atMs - b.atMs || a.frequencyHz - b.frequencyHz)
	const occ = occupancy(cu8, rate, centre)
	const channels = channelsOf(
		occ,
		[
			...discoveries.map(d => d.frequencyHz),
			...decodes.map(d => d.frequencyHz),
		],
		RASTER_HZ,
		RASTER_OFFSET_HZ,
	)
	const segDir = join(o.out, `${o.name}.segments`)
	mkdirSync(segDir, { recursive: true })
	const tmp = mkdtempSync(join(tmpdir(), "wk-truth-label-"))
	const intervals: TruthInterval[] = []
	try {
		for (const hz of channels) {
			for (const seg of segmentsOf(channelSnr(occ, hz), occ.frameMs)) {
				const { rateHz: demodRate, freq } = demodulate(
					cu8,
					rate,
					centre,
					hz,
					seg.startMs,
					seg.endMs,
				)
				const a48 = toS16(resample(freq, demodRate, 48_000))
				const file = `${Math.round(hz / 1000)}k-${seg.startMs}ms.wav`
				writeFileSync(join(segDir, file), wav(a48, 48_000))
				let protocol: "dmr" | "pocsag" | null = null
				let source: TruthInterval["source"] = "decoded-offline"
				let note = file
				if (o.multimon) {
					const a22 = toS16(resample(freq, demodRate, 22_050))
					const caps = parseMultimon(
						await run(
							o.multimon,
							[
								"-q",
								"-t",
								"raw",
								"-a",
								"POCSAG512",
								"-a",
								"POCSAG1200",
								"-a",
								"POCSAG2400",
								"-",
							],
							Buffer.from(a22.buffer, a22.byteOffset, a22.byteLength),
						),
					)
					if (caps.length > 0) {
						protocol = "pocsag"
						note = `${file} multimon-ng ${caps.length} messages`
					}
				}
				if (protocol === null && o.dsd) {
					const path = join(tmp, "segment.wav")
					writeFileSync(path, wav(a48, 48_000))
					const dmr = parseDsdFme(
						await run(o.dsd, ["-fs", "-i", path, "-o", "null"], null),
					)
					if (dmr.frames > 0) {
						protocol = "dmr"
						note = `${file} dsd-fme ${dmr.frames} frames`
					}
				}
				if (protocol === null) {
					const live = decodes.find(
						d =>
							Math.abs(d.frequencyHz - hz) <= LIVE_REACH_HZ &&
							d.atMs >= seg.startMs &&
							d.atMs <= seg.endMs + LIVE_AFTER_MS,
					)
					if (live) {
						protocol = live.protocol
						source = "decoded-live"
						note = `${file} live ${live.protocol} decode`
					}
				}
				const proposal =
					protocol ??
					(deviationRms(freq) < CARRIER_RMS_HZ ? "carrier" : "unknown")
				intervals.push({
					frequencyHz: hz,
					startMs: seg.startMs,
					endMs: seg.endMs,
					label: proposal,
					source: protocol === null ? "ear" : source,
					// Only an offline decode of the stretch itself confirms it (its decoder checked
					// it); a live decode near it and every other proposal wait for a person.
					confirmed: protocol !== null && source === "decoded-offline",
					note,
				})
			}
		}
	} finally {
		rmSync(tmp, { recursive: true, force: true })
	}
	return {
		version: 1,
		capture: resolve(o.dir, `${o.name}.cu8`),
		centreHz: centre,
		rateHz: rate,
		startedAt: new Date(started).toISOString(),
		durationMs,
		complete: false,
		intervals,
		decodes,
	}
}

async function main(): Promise<number> {
	const dir = arg("captures")
	const out = arg("out")
	if (dir === undefined || out === undefined) {
		process.stderr.write(
			"usage: scanner-truth-label --captures <dir> --out <labels dir> [--only <name>] [--multimon <path>] [--dsd-fme <path>] [--no-decoders] [--force]\n",
		)
		return 2
	}
	const decoders = !process.argv.includes("--no-decoders")
	const multimon = decoders ? (arg("multimon") ?? "multimon-ng") : null
	const dsd = decoders ? (arg("dsd-fme") ?? "dsd-fme") : null
	for (const [bin, probe] of [
		[multimon, ["-h"]],
		[dsd, ["-h"]],
	] as const) {
		if (bin === null) continue
		try {
			await run(bin, [...probe], null)
		} catch {
			process.stderr.write(`decoder not found: ${bin} (or --no-decoders)\n`)
			return 3
		}
	}
	mkdirSync(out, { recursive: true })
	const only = arg("only")
	const names = readdirSync(dir)
		.filter(f => f.endsWith(".cu8"))
		.map(f => f.slice(0, -4))
		.filter(n => existsSync(join(dir, `${n}.capture.json`)))
		.filter(n => only === undefined || n === only)
		.sort()
	for (const name of names) {
		const target = join(out, `${name}${TRUTH_SUFFIX}`)
		if (existsSync(target) && !process.argv.includes("--force")) {
			process.stderr.write(`  ${name}: kept (labels exist; --force to redo)\n`)
			continue
		}
		const truth = await labelCapture({ name, dir, out, multimon, dsd })
		writeFileSync(target, `${JSON.stringify(truth, null, "\t")}\n`)
		const by = new Map<string, number>()
		for (const iv of truth.intervals)
			by.set(iv.label, (by.get(iv.label) ?? 0) + 1)
		process.stderr.write(
			`  ${name}: ${truth.intervals.length} stretches (${[...by].map(([k, v]) => `${k} ${v}`).join(", ")}), ${truth.decodes.length} live decodes\n`,
		)
	}
	return 0
}

main().then(
	code => {
		process.exitCode = code
	},
	(err: unknown) => {
		process.stderr.write(
			`${err instanceof Error ? err.message : String(err)}\n`,
		)
		process.exitCode = 1
	},
)
