/**
 * Speech-content measure (src/core/scanner/channel/speech-content.ts), offline: synthetic signals
 * through WidebandNfmChain (tests/unit/core/scanner/speech-content-fixtures.ts), or WAV files.
 *
 *   pnpm exec esbuild scripts/bench/scanner-quality/speech-content.ts --bundle \
 *     --platform=node --format=esm --packages=external \
 *     --outfile=output/bench/speech-content.mjs
 *   node output/bench/speech-content.mjs                 # the synthetic table
 *   node output/bench/speech-content.mjs a.wav b.wav     # 8 kHz s16 mono files
 *
 * One JSON line per signal or file: its largest envelope range (dB), periodic share, frames,
 * whether it measures clearly not speech, and the measure's cost (ms per second of audio). A
 * file is named by a short hash of its path only, so private paths are not printed.
 */
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import process from "node:process"
import {
	SpeechContentMeter,
	clearlyNotSpeech,
} from "../../../src/core/scanner/channel/speech-content.js"
import {
	CONTENT_CASES,
	HARD_SPEECH_CASES,
	contentAudio,
	type ContentSignal,
} from "../../../tests/unit/core/scanner/speech-content-fixtures.js"

const SECONDS = 12

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
		notSpeech: clearlyNotSpeech(c),
		msPerSecond: Math.round((ms / (pcm.length / 8_000)) * 1000) / 1000,
	}
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
if (files.length > 0) {
	for (const f of files) {
		const id = createHash("sha1").update(f).digest("hex").slice(0, 6)
		console.log(JSON.stringify({ file: id, ...measure(wavPcm(f)) }))
	}
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
}
