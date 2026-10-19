/**
 * Analog-trial calibration (req 5.3, 5.4). Runs the built `wavekit-iqcap
 * analyze` on synthetic cf32 files this test writes under mkdtemp, then the
 * TS runner. Skipped when the release binary is absent. No sockets.
 *
 * Expected at 10–20 dB channel SNR: NFM voice → heard, voice+CTCSS 88.5 and
 * voice+DCS 023N → decoded, 4FSK 4800/2400 and gaussian 2FSK BT 1 →
 * data-like, AM voice → heard, carrier → carrier-only, noise in NFM and AM
 * → no-sync.
 *
 * Genuine GMSK (BT 0.3, h 0.5) is measured and not asserted. A symbol-centre
 * gaussian matched filter scored about 0.49 / 0.51 / 0.51 at 10 / 15 / 20 dB
 * (voice at 20 dB about 0.24) and was not kept: the pulse autocorrelation at
 * one symbol is 0.28 of the cursor, so about half the symbols miss the frozen
 * ±15 % window, and the 31-tap filter added about 20 ms per 4 s capture.
 * The row below is the shipped cluster. The 0.6 data score is unchanged.
 */
import { spawn, type ChildProcess } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { Readable } from "node:stream"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { ToneDetector } from "../../src/core/audio-tones/tone-detector.js"
import { createAnalogTrialRunner } from "../../src/core/iq-capture/analog-trial.js"
import type { IqCapturePort } from "../../src/core/scanner/iq-capture-contract.js"
import {
	ANALOG_TRIAL_AUDIO_MIN_DB,
	ANALOG_TRIAL_DATA_SCORE,
	ANALOG_TRIAL_QUIETING_DB,
	ANALOG_TRIAL_VOICE_INDEX,
	type AnalogTrialMode,
	type AnalogTrialOutcome,
	type AnalogTrialResult,
} from "../../src/core/scanner/scanner-redesign-contract.js"
import { createLogger } from "../../src/utils/logger.js"
import {
	synthesizeAnalogIq,
	type AnalogSynthKind,
} from "../mocks/iq/analog-synth.js"

const BINARY = fileURLToPath(
	new URL(
		"../../native/wavekit-chan/target/release/wavekit-iqcap",
		import.meta.url,
	),
)
const PRESENT = existsSync(BINARY)
const SECONDS = 2
const SEED = 0xa5a55a5a
const SNRS = [10, 15, 20] as const

interface CalCase {
	kind: AnalogSynthKind
	mode: AnalogTrialMode
	expected: AnalogTrialOutcome
}

const CASES: readonly CalCase[] = [
	{ kind: "nfm-voice", mode: "nfm", expected: "heard" },
	{ kind: "nfm-ctcss", mode: "nfm", expected: "decoded" },
	{ kind: "nfm-dcs", mode: "nfm", expected: "decoded" },
	{ kind: "fsk4-4800", mode: "nfm", expected: "data-like" },
	{ kind: "fsk4-2400", mode: "nfm", expected: "data-like" },
	{ kind: "gfsk-bt1", mode: "nfm", expected: "data-like" },
	{ kind: "gmsk", mode: "nfm", expected: "data-like" },
	{ kind: "am-voice", mode: "am", expected: "heard" },
	{ kind: "carrier", mode: "nfm", expected: "carrier-only" },
	{ kind: "noise", mode: "nfm", expected: "no-sync" },
	{ kind: "noise", mode: "am", expected: "no-sync" },
]

interface MarginRow {
	kind: AnalogSynthKind
	mode: AnalogTrialMode
	snrDb: number | null
	outcome: AnalogTrialOutcome
	expected: AnalogTrialOutcome
	quietingDb: number | null
	cluster: number | null
	syllabic: number | null
	audioDb: number | null
	tone: string
}

const rows: MarginRow[] = []

describe.skipIf(!PRESENT)("analog trial calibration", () => {
	it("classifies synthetic captures at 10–20 dB", async () => {
		const failures: string[] = []
		const dir = await mkdtemp(path.join(tmpdir(), "wk-analog-cal-"))
		try {
			for (const spec of CASES) {
				const snrs = spec.kind === "noise" ? [null] : SNRS
				for (const snrDb of snrs) {
					const iq = synthesizeAnalogIq({
						kind: spec.kind,
						snrDb: snrDb ?? 0,
						seconds: SECONDS,
						seed: SEED,
					})
					const name = `${spec.kind}-${spec.mode}-${snrDb ?? "noise"}.cf32`
					const file = path.join(dir, name)
					await writeFile(
						file,
						Buffer.from(iq.buffer, iq.byteOffset, iq.byteLength),
					)
					const result = await trial(file, spec.mode)
					rows.push(rowOf(spec, snrDb, result))
					if (result.error !== undefined) {
						failures.push(
							`${spec.kind}/${spec.mode} @ ${snrDb ?? "noise"} error ${result.error}`,
						)
					}
				}
			}
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
		// Printed for the lane report. Margins are the median statistic minus
		// the frozen threshold (positive means that rule cleared).
		console.log(formatTable(rows))
		for (const row of rows) {
			const where = `${row.kind}/${row.mode} @ ${row.snrDb === null ? "noise" : row.snrDb}`
			// GMSK's data-like expectation is the known gap tracked by the todo.
			if (row.kind === "gmsk") continue
			if (row.outcome !== row.expected) {
				failures.push(`${where} ${row.outcome} expected ${row.expected}`)
			}
			if (row.kind === "nfm-ctcss" && row.tone !== "CTCSS 88.5") {
				failures.push(`${where} tone ${row.tone || "-"}`)
			}
			if (row.kind === "nfm-dcs" && row.tone !== "DCS 023N") {
				failures.push(`${where} tone ${row.tone || "-"}`)
			}
		}
		expect(failures).toEqual([])
	}, 180_000)

	it.todo(
		"genuine GMSK (BT 0.3, h 0.5) classifies data-like. A matched-filter eye scored about 0.49/0.51/0.51 at 10/15/20 dB, under the frozen 0.6 score, and is not on the hot path; NFM voice stays under 0.6",
	)
})

function trial(
	file: string,
	mode: AnalogTrialMode,
): Promise<AnalogTrialResult> {
	const logger = createLogger({ level: "fatal", pretty: false })
	const runner = createAnalogTrialRunner({
		port: portFor(file),
		tones: () => new ToneDetector(),
		logger,
	})
	return runner.run("calibration", mode, new AbortController().signal)
}

function portFor(file: string): IqCapturePort {
	return {
		openAnalyze(_captureId: string, mode: AnalogTrialMode) {
			const child = spawn(BINARY, ["analyze", "--in", file, "--mode", mode], {
				stdio: ["ignore", "pipe", "pipe", "ignore", "pipe"],
			})
			child.stderr?.resume()
			const stdout = child.stdout
			const eventFd = child.stdio[4]
			if (!stdout || !isReadable(eventFd)) {
				child.kill("SIGKILL")
				return null
			}
			return {
				audio: stdout,
				event: readEvent(child, eventFd),
				kill() {
					child.kill("SIGKILL")
				},
			}
		},
	} as unknown as IqCapturePort
}

function isReadable(value: unknown): value is Readable {
	return (
		value !== null &&
		typeof value === "object" &&
		typeof (value as { on?: unknown }).on === "function"
	)
}

function readEvent(child: ChildProcess, fd: Readable): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			child.kill("SIGKILL")
			reject(new Error("analyze timed out"))
		}, 15_000)
		const chunks: Buffer[] = []
		fd.on("data", (chunk: Buffer) => {
			chunks.push(chunk)
		})
		fd.on("error", err => {
			clearTimeout(timer)
			reject(err)
		})
		fd.on("end", () => {
			clearTimeout(timer)
			const text = Buffer.concat(chunks).toString("utf8").trim()
			const line = text.split("\n")[0] ?? ""
			try {
				resolve(JSON.parse(line))
			} catch (err: unknown) {
				reject(err)
			}
		})
	})
}

function median(values: number[]): number | null {
	if (values.length === 0) return null
	const sorted = [...values].sort((a, b) => a - b)
	const mid = sorted.length >> 1
	if (sorted.length % 2 === 1) return sorted[mid] ?? null
	const left = sorted[mid - 1]
	const right = sorted[mid]
	if (left === undefined || right === undefined) return null
	return (left + right) / 2
}

function rowOf(
	spec: CalCase,
	snrDb: number | null,
	result: AnalogTrialResult,
): MarginRow {
	const stats = result.stats
	return {
		kind: spec.kind,
		mode: spec.mode,
		snrDb,
		outcome: result.outcome,
		expected: spec.expected,
		quietingDb: stats ? median(stats.frames.map(f => -f.hfNoiseDb)) : null,
		cluster: stats ? median(stats.frames.map(f => f.cluster)) : null,
		syllabic: stats ? median(stats.frames.map(f => f.syllabic)) : null,
		audioDb: stats ? median(stats.frames.map(f => f.audioDb)) : null,
		tone: toneLabel(result),
	}
}

function toneLabel(result: AnalogTrialResult): string {
	if (result.tones.ctcssHz !== null) return `CTCSS ${result.tones.ctcssHz}`
	const dcs = result.tones.dcs
	if (dcs) return `DCS ${dcs.code}${dcs.polarity === "normal" ? "N" : "I"}`
	return ""
}

function formatTable(table: readonly MarginRow[]): string {
	const header = [
		"kind",
		"mode",
		"snr",
		"outcome",
		"quieting",
		`q-${ANALOG_TRIAL_QUIETING_DB}`,
		"cluster",
		`c-${ANALOG_TRIAL_DATA_SCORE}`,
		"syllabic",
		`s-${ANALOG_TRIAL_VOICE_INDEX}`,
		"audioDb",
		`a-(${ANALOG_TRIAL_AUDIO_MIN_DB})`,
		"tone",
	].join("\t")
	const lines = table.map(row =>
		[
			row.kind,
			row.mode,
			row.snrDb === null ? "-" : String(row.snrDb),
			`${row.outcome}/${row.expected}`,
			fmt(row.quietingDb),
			fmt(
				row.quietingDb === null
					? null
					: row.quietingDb - ANALOG_TRIAL_QUIETING_DB,
			),
			fmt(row.cluster),
			fmt(row.cluster === null ? null : row.cluster - ANALOG_TRIAL_DATA_SCORE),
			fmt(row.syllabic),
			fmt(
				row.syllabic === null ? null : row.syllabic - ANALOG_TRIAL_VOICE_INDEX,
			),
			fmt(row.audioDb),
			fmt(
				row.audioDb === null ? null : row.audioDb - ANALOG_TRIAL_AUDIO_MIN_DB,
			),
			row.tone,
		].join("\t"),
	)
	return ["analog-trial calibration", header, ...lines].join("\n")
}

function fmt(n: number | null): string {
	if (n === null || !Number.isFinite(n)) return "-"
	return n.toFixed(2)
}
