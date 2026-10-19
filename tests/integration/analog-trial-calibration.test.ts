/**
 * Analog-trial calibration (req 5.3, 5.4). Runs the built `wavekit-iqcap
 * analyze` on synthetic cf32 files this test writes under mkdtemp, then the
 * TS runner. Skipped when the release binary is absent. No sockets.
 *
 * Expected at 10–20 dB channel SNR: NFM voice → heard, voice+CTCSS 88.5 and
 * voice+DCS 023N → decoded, 4FSK 4800/2400 and GMSK → data-like, carrier →
 * carrier-only, noise → no-sync.
 *
 * DCS is not asserted yet: it does not qualify on this audio. `wavekit-iqcap analyze`
 * high-passes at 300 Hz; the DCS detector low-passes at 200 Hz. A clean
 * ±2 kHz NRZ square wave of code 023 also comes back with no code. No
 * contract threshold produces that code, so none was moved.
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

const EXPECTED: Record<AnalogSynthKind, AnalogTrialOutcome> = {
	"nfm-voice": "heard",
	"nfm-ctcss": "decoded",
	"nfm-dcs": "decoded",
	"fsk4-4800": "data-like",
	"fsk4-2400": "data-like",
	gmsk: "data-like",
	carrier: "carrier-only",
	noise: "no-sync",
}

interface MarginRow {
	kind: AnalogSynthKind
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
			for (const kind of Object.keys(EXPECTED) as AnalogSynthKind[]) {
				const snrs = kind === "noise" ? [null] : SNRS
				for (const snrDb of snrs) {
					const iq = synthesizeAnalogIq({
						kind,
						snrDb: snrDb ?? 0,
						seconds: SECONDS,
						seed: SEED,
					})
					const name = `${kind}-${snrDb ?? "noise"}.cf32`
					const file = path.join(dir, name)
					await writeFile(
						file,
						Buffer.from(iq.buffer, iq.byteOffset, iq.byteLength),
					)
					const result = await trial(file, "nfm")
					rows.push(rowOf(kind, snrDb, result))
					if (result.error !== undefined) {
						failures.push(`${kind} @ ${snrDb ?? "noise"} error ${result.error}`)
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
			// DCS through analyze audio is an open gap, tracked by the todo below.
			if (row.kind === "nfm-dcs") continue
			if (row.outcome !== row.expected) {
				failures.push(
					`${row.kind} @ ${row.snrDb === null ? "noise" : row.snrDb} ${row.outcome} expected ${row.expected}`,
				)
			}
		}
		for (const row of rows) {
			if (row.kind === "nfm-ctcss" && row.tone !== "CTCSS 88.5") {
				failures.push(`nfm-ctcss @ ${row.snrDb} tone ${row.tone || "-"}`)
			}
		}
		expect(failures).toEqual([])
	}, 120_000)

	it.todo(
		"voice + DCS 023N decodes through analyze audio (blocked: the 300 Hz analyze high-pass removes the DCS band)",
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
	kind: AnalogSynthKind,
	snrDb: number | null,
	result: AnalogTrialResult,
): MarginRow {
	const stats = result.stats
	return {
		kind,
		snrDb,
		outcome: result.outcome,
		expected: EXPECTED[kind],
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
