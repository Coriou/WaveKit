/**
 * Speech-content measure (src/core/scanner/channel/speech-content.ts), offline: synthetic signals
 * through WidebandNfmChain (tests/unit/core/scanner/speech-content-fixtures.ts), or WAV files.
 *
 *   pnpm exec esbuild scripts/bench/scanner-quality/speech-content.ts --bundle \
 *     --platform=node --format=esm --packages=external \
 *     --outfile=output/bench/speech-content.mjs
 *   node output/bench/speech-content.mjs                 # the synthetic table
 *   node output/bench/speech-content.mjs --short         # the short-file table only
 *   node output/bench/speech-content.mjs --burst         # the burst-veto table only
 *   node output/bench/speech-content.mjs a.wav b.wav     # 8 kHz s16 mono files
 *
 * One JSON line per signal or file: its largest envelope range (dB), periodic share, frames,
 * whether it measures clearly not speech, and the measure's cost (ms per second of audio). Then
 * short files (`short: true`, 94, 125, 188, 250 and 375 frames, 3 to 12 s; speech-content.ts
 * SPEECH_NOISE_MIN_FRAMES): each case cut from a 16 s run at every 0.5 s start (from 0.5 s), the
 * smallest, median and largest of the cuts' largest-window ranges, and how many cuts the strict
 * bounds alone (no length floor) would call clear noise (`noiseCuts`); a single word (0.3 to
 * 0.5 s) at the file's start or followed by a 3 s carrier tail at its end. The burst table
 * (`burst: true`; SPEECH_NOISE_MAX_BURST_FRAMES): a single word (0.3 to 0.5 s) at the start,
 * middle or tail of an 8 or 12 s file and sparse speech (four words of 0.3 to 0.4 s over 10 s) on
 * a quiet carrier, and the synthetic data and noise, each with its longest burst
 * (`maxBurstFrames`) and clear noise with (`noise`) and without (`noiseNoVeto`) the burst veto.
 * Files print the same two columns and close with a count line (`summary: true`). A
 * file is named by a short hash of its path only, so private paths are not printed.
 */
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import process from "node:process"
import {
	SPEECH_FRAME_SAMPLES,
	SPEECH_NOISE_MAX_PERIODIC_SHARE,
	SPEECH_NOISE_MAX_RANGE_DB,
	SPEECH_NOISE_MIN_FRAMES,
	SpeechContentMeter,
	clearlyNoise,
	clearlyNotSpeech,
	type SpeechContent,
} from "../../../src/core/scanner/channel/speech-content.js"
import {
	CONTENT_CASES,
	HARD_SPEECH_CASES,
	HARD_SPEECH_WAVES,
	contentAudio,
	type ContentSignal,
} from "../../../tests/unit/core/scanner/speech-content-fixtures.js"

const SECONDS = 12
/** Short-file lengths (frames): 3.008, 4, 6.016, 8 and 12 s. */
const SHORT_FRAMES = [94, 125, 188, 250, 375] as const
const round2 = (x: number): number => Math.round(x * 100) / 100

function measure(pcm: Int16Array): Record<string, number | boolean> {
	const t0 = process.hrtime.bigint()
	const meter = new SpeechContentMeter()
	// The recorder's push size (PUSH_FRAMES-like chunks).
	for (let at = 0; at < pcm.length; at += 4_000)
		meter.push(pcm.subarray(at, at + 4_000))
	const c = meter.result()
	const ms = Number(process.hrtime.bigint() - t0) / 1e6
	return {
		frames: c.frames,
		maxRangeDb: Math.round(c.maxRangeDb * 100) / 100,
		periodicShare: Math.round(c.periodicShare * 1000) / 1000,
		maxBurstFrames: c.maxBurstFrames,
		notSpeech: clearlyNotSpeech(c),
		noise: clearlyNoise(c),
		noiseNoVeto: noiseNoVeto(c),
		msPerSecond: Math.round((ms / (pcm.length / 8_000)) * 1000) / 1000,
	}
}

/** clearlyNoise without its burst veto (the bound before SPEECH_NOISE_MAX_BURST_FRAMES). */
function noiseNoVeto(c: SpeechContent): boolean {
	return (
		c.frames >= SPEECH_NOISE_MIN_FRAMES &&
		c.maxRangeDb < SPEECH_NOISE_MAX_RANGE_DB &&
		c.periodicShare < SPEECH_NOISE_MAX_PERIODIC_SHARE
	)
}

function wavPcm(path: string): Int16Array {
	const b = readFileSync(path)
	let at = 12
	while (at + 8 <= b.length) {
		const id = b.toString("ascii", at, at + 4)
		const size = b.readUInt32LE(at + 4)
		if (id === "data") {
			const n = Math.floor(Math.min(size, b.length - at - 8) / 2)
			const out = new Int16Array(n)
			for (let i = 0; i < n; i++) out[i] = b.readInt16LE(at + 8 + 2 * i)
			return out
		}
		at += 8 + size + (size % 2)
	}
	return new Int16Array(0)
}

const files = process.argv.slice(2)
if (files.length === 1 && files[0] === "--short") {
	shortFiles()
} else if (files.length === 1 && files[0] === "--burst") {
	burstTable()
} else if (files.length > 0) {
	let noise = 0
	let noVeto = 0
	for (const f of files) {
		const id = createHash("sha1").update(f).digest("hex").slice(0, 6)
		const row = measure(wavPcm(f))
		if (row["noise"] === true) noise++
		if (row["noiseNoVeto"] === true) noVeto++
		console.log(JSON.stringify({ file: id, ...row }))
	}
	console.log(
		JSON.stringify({
			summary: true,
			files: files.length,
			noise,
			noiseNoVeto: noVeto,
		}),
	)
} else {
	const extra: { name: string; signal: ContentSignal; speech: boolean }[] = []
	for (const cnrDb of [6, 5, 4])
		for (const pauses of ["short", "none"] as const)
			extra.push({
				name: `speech-${pauses === "none" ? "no-pause-" : ""}cnr-${cnrDb}`,
				signal: { waveform: { kind: "speech", pauses }, cnrDb },
				speech: true,
			})
	// Hard speech (low deviation, shallow syllables, no pauses) at a CNR of 5 to 10 dB.
	for (const c of HARD_SPEECH_CASES) extra.push({ ...c, speech: true })
	extra.push(
		{
			name: "dmr-4fsk-cnr-9",
			signal: {
				waveform: {
					kind: "fsk",
					baud: 4_800,
					levelsHz: [-1_944, -648, 648, 1_944],
				},
				cnrDb: 9,
			},
			speech: false,
		},
		{
			name: "tone-1000",
			signal: { waveform: { kind: "tone", hz: 1_000 }, cnrDb: 30 },
			speech: false,
		},
		{
			name: "tone-2400",
			signal: { waveform: { kind: "tone", hz: 2_400 }, cnrDb: 30 },
			speech: false,
		},
		{
			name: "silent-carrier",
			signal: { waveform: { kind: "silent" }, cnrDb: 30 },
			speech: false,
		},
		{
			name: "noise-open-squelch-seed-9",
			signal: {
				waveform: { kind: "silent" },
				cnrDb: 30,
				carrier: false,
				seed: 9,
			},
			speech: false,
		},
	)
	for (const c of [...CONTENT_CASES, ...extra])
		console.log(
			JSON.stringify({
				signal: c.name,
				speech: c.speech,
				...measure(contentAudio(c.signal, SECONDS)),
			}),
		)
	shortFiles()
}

/** One cut's measure: its largest-window range and whether the strict bounds call it noise. */
function cutOf(pcm: Int16Array): { range: number; noiseBounds: boolean } {
	const meter = new SpeechContentMeter()
	meter.push(pcm)
	const c = meter.result()
	return {
		range: c.maxRangeDb,
		// The strict bounds alone (clearlyNoise without its length floor).
		noiseBounds:
			c.maxRangeDb < SPEECH_NOISE_MAX_RANGE_DB &&
			c.periodicShare < SPEECH_NOISE_MAX_PERIODIC_SHARE,
	}
}

/** Every cut of `frames` frames of `pcm` starting at 0.5 s and then every 0.5 s. */
function cuts(pcm: Int16Array, frames: number): ReturnType<typeof cutOf>[] {
	const n = frames * SPEECH_FRAME_SAMPLES
	const out: ReturnType<typeof cutOf>[] = []
	for (let at = 4_000; at + n <= pcm.length; at += 4_000)
		out.push(cutOf(pcm.subarray(at, at + n)))
	return out
}

function shortRow(
	signal: string,
	speech: boolean,
	cnrDb: number,
	frames: number,
	all: ReturnType<typeof cutOf>[],
): void {
	const ranges = all.map(c => c.range).sort((a, b) => a - b)
	console.log(
		JSON.stringify({
			short: true,
			signal,
			speech,
			cnrDb,
			frames,
			seconds: round2(frames * 0.032),
			cuts: all.length,
			minRangeDb: round2(ranges[0] ?? 0),
			medianRangeDb: round2(ranges[Math.floor(ranges.length / 2)] ?? 0),
			maxRangeDb: round2(ranges[ranges.length - 1] ?? 0),
			noiseCuts: all.filter(c => c.noiseBounds).length,
		}),
	)
}

/** Short files: every voice case at 3 to 12 s, the worst cut of a 16 s run. */
function shortFiles(): void {
	const RUN = 16
	const voice: { name: string; signal: ContentSignal }[] = []
	for (const cnrDb of [4, 5, 6]) {
		for (const [name, w] of HARD_SPEECH_WAVES)
			voice.push({
				name: `${name}-cnr-${cnrDb}`,
				signal: { waveform: { kind: "speech", ...w }, cnrDb },
			})
		for (const pauses of ["short", "none"] as const)
			voice.push({
				name: `speech-${pauses === "none" ? "no-pause-" : ""}cnr-${cnrDb}`,
				signal: { waveform: { kind: "speech", pauses }, cnrDb },
			})
	}
	for (const cnrDb of [4, 5, 6, 8, 10, 20])
		voice.push({
			name: `lowdev-500-cnr-${cnrDb}`,
			signal: {
				waveform: { kind: "speech", pauses: "short", peakHz: 500 },
				cnrDb,
			},
		})
	for (const v of voice) {
		const pcm = contentAudio(v.signal, RUN)
		for (const frames of SHORT_FRAMES)
			shortRow(v.name, true, v.signal.cnrDb, frames, cuts(pcm, frames))
	}
	// A single word, then an unmodulated carrier: at the file's start, or ending 3 s before its
	// end (its carrier tail). Half a second of lead-in, cut off, skips the demodulator's settling.
	for (const cnrDb of [4, 5, 6, 10, 20])
		for (const wordS of [0.3, 0.4, 0.5])
			for (const frames of SHORT_FRAMES)
				for (const at of ["start", "tail"] as const) {
					const seconds = frames * 0.032
					const wordAtS = at === "start" ? 0 : seconds - 3 - wordS
					if (wordAtS < 0) continue
					const pcm = contentAudio(
						{
							waveform: {
								kind: "speech",
								pauses: "none",
								wordAtS: wordAtS + 0.5,
								wordS,
							},
							cnrDb,
						},
						seconds + 0.5,
					)
					const n = frames * SPEECH_FRAME_SAMPLES
					shortRow(`word-${wordS}s-${at}`, true, cnrDb, frames, [
						cutOf(pcm.subarray(4_000, 4_000 + n)),
					])
				}
	for (const c of CONTENT_CASES.filter(c => !c.speech)) {
		const pcm = contentAudio(c.signal, RUN)
		for (const frames of SHORT_FRAMES)
			shortRow(c.name, false, c.signal.cnrDb, frames, cuts(pcm, frames))
	}
}

/** The burst veto: words on a quiet carrier (kept) against data and noise (still caught). */
function burstTable(): void {
	const rows: {
		name: string
		signal: ContentSignal
		seconds: number
		speech: boolean
	}[] = []
	for (const cnrDb of [5, 6, 8, 10, 12, 20, 30])
		for (const seconds of [8, 12])
			for (const wordS of [0.3, 0.4, 0.5])
				for (const at of ["start", "middle", "tail"] as const) {
					const wordAtS =
						at === "start"
							? 0.6
							: at === "middle"
								? seconds / 2
								: seconds - 0.2 - wordS
					rows.push({
						name: `word-${wordS}s-${at}-${seconds}s-cnr-${cnrDb}`,
						signal: {
							waveform: { kind: "speech", pauses: "none", wordAtS, wordS },
							cnrDb,
						},
						seconds,
						speech: true,
					})
				}
	const sparse: readonly (readonly [number, number])[] = [
		[1, 0.35],
		[4, 0.3],
		[7.5, 0.4],
		[10.6, 0.3],
	]
	for (const cnrDb of [5, 6, 8, 10, 12, 20, 30]) {
		rows.push({
			name: `sparse-4-words-cnr-${cnrDb}`,
			signal: {
				waveform: { kind: "speech", pauses: "none", words: sparse },
				cnrDb,
			},
			seconds: 12,
			speech: true,
		})
		rows.push({
			name: `sparse-3-words-cnr-${cnrDb}`,
			signal: {
				waveform: { kind: "speech", pauses: "none", words: sparse.slice(0, 3) },
				cnrDb,
			},
			seconds: 12,
			speech: true,
		})
	}
	// The accepted exception (speech-content.ts SPEECH_NOISE_MIN_FRAMES): 500 Hz peak deviation.
	for (const cnrDb of [8, 10])
		rows.push({
			name: `lowdev-500-cnr-${cnrDb}`,
			signal: {
				waveform: { kind: "speech", pauses: "short", peakHz: 500 },
				cnrDb,
			},
			seconds: 12,
			speech: true,
		})
	for (const c of CONTENT_CASES.filter(c => !c.speech))
		rows.push({ ...c, seconds: SECONDS })
	for (const cnrDb of [5, 6, 8, 10, 12, 20, 30])
		rows.push({
			name: `silent-carrier-cnr-${cnrDb}`,
			signal: { waveform: { kind: "silent" }, cnrDb },
			seconds: SECONDS,
			speech: false,
		})
	for (const seed of [1, 2, 3, 9])
		rows.push({
			name: `noise-open-squelch-seed-${seed}`,
			signal: { waveform: { kind: "silent" }, cnrDb: 30, carrier: false, seed },
			seconds: SECONDS,
			speech: false,
		})
	for (const r of rows)
		console.log(
			JSON.stringify({
				burst: true,
				signal: r.name,
				speech: r.speech,
				...measure(contentAudio(r.signal, r.seconds + 0.5).subarray(4_000)),
			}),
		)
}
