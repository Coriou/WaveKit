/**
 * Evidence squelch cost: the frozen tone-squelch paths against EvidenceGate + PreRoll and the
 * closed fast path, at 25 kHz and 50 kHz audio in s16le and f32le. The voice case starts a fresh
 * gate in `waiting` over seeded speech-shaped audio and runs through the latch to `open`; the
 * idle case is stage 1 closed with an empty FIFO. Work is sliced into 10 ms stage-1 blocks
 * inside 64 KiB chunks, as the live wiring decides per block. Core fraction is processing time
 * per second of audio; the step is the largest synchronous 64 KiB chunk. Both are medians of
 * five passes after a discarded warmup pass. Pass/fail is against the desktop budgets
 * (docs/specs/evidence-squelch/design.md, Budgets): <= 0.006 core and <= 1 ms per 64 KiB.
 *
 *   pnpm exec esbuild scripts/bench/evidence-squelch.ts --bundle \
 *     --platform=node --format=esm --packages=external \
 *     --outfile=output/bench/evidence-squelch.mjs
 *   node output/bench/evidence-squelch.mjs --seconds 30 [--json]
 */
import { performance } from "node:perf_hooks"
import process from "node:process"
import { pathToFileURL } from "node:url"
import { ToneSquelchGate } from "../../src/core/audio-tones/tone-squelch.js"
import type { EvidencePcmFormat } from "../../src/core/evidence-squelch/contract.js"
import { EvidenceGate } from "../../src/core/evidence-squelch/evidence-gate.js"
import { PreRoll } from "../../src/core/evidence-squelch/pre-roll.js"
import { WaveKitError } from "../../src/utils/errors.js"
import {
	toPcm,
	voiceLike,
} from "../../tests/unit/core/evidence-squelch/synthetic.js"

const CHUNK_BYTES = 64 * 1024
const BLOCK_MS = 10
const CORE_BUDGET = 0.006
const STEP_BUDGET_MS = 1

export type BenchPath =
	| "frozen fill(0)"
	| "frozen ToneSquelchGate.push"
	| "EvidenceGate.push + PreRoll.process (waiting -> open)"
	| "closed idle fast path"

export interface BenchRow {
	path: BenchPath
	stage: "before" | "after"
	rate: number
	format: EvidencePcmFormat
	coreFraction: number
	maxStepMs: number
	/** Seconds of audio before the latch (voice case), else null. */
	latchS: number | null
	pass: boolean
}

interface PassResult {
	ms: number
	maxStepMs: number
	latchS: number | null
}

type Step = (chunk: Buffer, start: number, end: number) => void

const PATHS: BenchPath[] = [
	"frozen fill(0)",
	"frozen ToneSquelchGate.push",
	"EvidenceGate.push + PreRoll.process (waiting -> open)",
	"closed idle fast path",
]

function runPass(
	path: BenchPath,
	source: Buffer,
	scratch: Buffer,
	rate: number,
	format: EvidencePcmFormat,
): PassResult {
	const width = format === "s16le" ? 2 : 4
	const blockBytes = Math.ceil((rate * BLOCK_MS) / 1000) * width
	let latchByte = -1
	let base = 0
	let step: Step
	if (path === "frozen fill(0)") {
		step = chunk => {
			chunk.fill(0)
		}
	} else if (path === "frozen ToneSquelchGate.push") {
		const gate = new ToneSquelchGate(
			{ kind: "ctcss", frequencyTenthsHz: 1000 },
			rate,
		)
		step = (chunk, start, end) => {
			gate.push(chunk, format, start, end)
			if (!gate.open()) chunk.fill(0, start, end)
		}
	} else {
		const gate = new EvidenceGate({ rate, modulation: "nfm", gain: 2 })
		const preRoll = new PreRoll({ rate, format })
		if (path === "closed idle fast path") {
			step = (chunk, start, end) => {
				for (let s = start; s < end; s += blockBytes) {
					gate.noteBlock(false)
					gate.closed(Math.min(blockBytes, end - s), format)
				}
				if (preRoll.delaySamples === 0) chunk.fill(0, start, end)
			}
		} else {
			step = (chunk, start, end) => {
				for (let s = start; s < end; s += blockBytes) {
					const e = Math.min(end, s + blockBytes)
					gate.noteBlock(true)
					const wasOpen = gate.state === "open"
					const at = gate.push(chunk, format, s, e)
					if (wasOpen) preRoll.process(chunk, s, e, "pass")
					else if (at < 0) preRoll.process(chunk, s, e, "pending")
					else {
						preRoll.process(chunk, s, at, "pending")
						preRoll.latch()
						preRoll.process(chunk, at, e, "pass")
						if (latchByte < 0) latchByte = base + at
					}
				}
			}
		}
	}
	let ms = 0
	let maxStepMs = 0
	for (base = 0; base < source.length; base += CHUNK_BYTES) {
		const n = Math.min(CHUNK_BYTES, source.length - base)
		// The copy stands in for the demodulator's fresh output chunk and is not timed.
		source.copy(scratch, 0, base, base + n)
		const t0 = performance.now()
		step(scratch, 0, n)
		const dt = performance.now() - t0
		ms += dt
		if (n === CHUNK_BYTES && dt > maxStepMs) maxStepMs = dt
	}
	return {
		ms,
		maxStepMs,
		latchS: latchByte < 0 ? null : latchByte / width / rate,
	}
}

function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b)
	return sorted[Math.floor(sorted.length / 2)] ?? 0
}

export function runBench(opts: { seconds: number }): BenchRow[] {
	const { seconds } = opts
	if (!Number.isFinite(seconds) || seconds <= 0)
		throw new WaveKitError("Expected positive seconds", "INVALID_BENCH_OPTIONS")
	const rows: BenchRow[] = []
	const scratch = Buffer.alloc(CHUNK_BYTES)
	for (const rate of [25_000, 50_000])
		for (const format of ["s16le", "f32le"] as const) {
			const source = toPcm(voiceLike({ rate, seconds, seed: 7 }), format)
			for (const path of PATHS) {
				runPass(path, source, scratch, rate, format) // Discard warmup.
				const passes = Array.from({ length: 5 }, () =>
					runPass(path, source, scratch, rate, format),
				)
				const coreFraction = median(passes.map(p => p.ms)) / (seconds * 1000)
				const maxStepMs = median(passes.map(p => p.maxStepMs))
				rows.push({
					path,
					stage: path.startsWith("frozen") ? "before" : "after",
					rate,
					format,
					coreFraction,
					maxStepMs,
					latchS: passes[0]?.latchS ?? null,
					pass: coreFraction <= CORE_BUDGET && maxStepMs <= STEP_BUDGET_MS,
				})
			}
		}
	return rows
}

export function formatTable(rows: BenchRow[]): string {
	const lines = [
		"| Stage | Path | Rate | Format | Core fraction | Max step per 64 KiB (ms) | Latch (s) | Pass |",
		"| --- | --- | --- | --- | --- | --- | --- | --- |",
	]
	for (const r of rows)
		lines.push(
			`| ${r.stage} | ${r.path} | ${r.rate / 1000} kHz | ${r.format} | ${r.coreFraction.toFixed(5)} | ${r.maxStepMs.toFixed(3)} | ${r.latchS === null ? "-" : r.latchS.toFixed(2)} | ${r.pass ? "pass" : "FAIL"} |`,
		)
	lines.push(
		`| budget | Total while a carrier is up (desktop) | 25 / 50 kHz | both | <= ${CORE_BUDGET} | <= ${STEP_BUDGET_MS} | - | - |`,
		"| budget | Decimator + VoiceFrameMeter + ToneEvidence (desktop) | 25 kHz | both | <= 0.001 + 0.001 + 0.003 | - | - | - |",
		"| budget | Judge + PreRoll copy (desktop) | 25 kHz | both | < 0.001 each | - | - | - |",
		"| budget | Fast path (closed, FIFO empty) | any | both | as today (one fill(0)) | - | - | - |",
	)
	return lines.join("\n")
}

function arg(name: string, fallback: number): number {
	const index = process.argv.indexOf(`--${name}`)
	return index < 0 ? fallback : Number(process.argv[index + 1])
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	const rows = runBench({ seconds: arg("seconds", 30) })
	if (process.argv.includes("--json"))
		process.stdout.write(`${JSON.stringify(rows)}\n`)
	else process.stdout.write(`${formatTable(rows)}\n`)
}
