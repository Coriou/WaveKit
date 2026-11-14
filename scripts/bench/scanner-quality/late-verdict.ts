/**
 * Late-verdict scenes (synthetic, offline): the analog recorder (WidebandAnalogRecorder) in the
 * loop on stream time, with its discovery's evidence changing as identify would change it.
 *
 *   pnpm exec esbuild scripts/bench/scanner-quality/late-verdict.ts --bundle \
 *     --platform=node --format=esm --packages=external \
 *     --outfile=output/bench/late-verdict.mjs
 *   node output/bench/late-verdict.mjs [--policy on|off]
 *
 * --policy off runs the recorder without its standing-prior lookup (voicePrior), which is how
 * the recorder behaved before the provisional-recording policy (recording-verdict.ts); --policy
 * on (the default) wires it as scanner-service does.
 *
 * Scenes:
 * - pager-burst: a 4 s 2FSK burst (1 200 Bd, ±4.5 kHz, a POCSAG-like alternating preamble) whose
 *   snapshots read analog-fm, on a discovery whose stored class is fsk2-wide from the spectrum
 *   only. Its POCSAG decode lands DECODE_AT_S = 12 s after the onset (the burst ends at 4 s, its
 *   2 s hang at 6 s; identify answers within 26 s), so after the file's finish was asked.
 *   Expected: kept (finalized) with --policy off, discarded with --policy on.
 * - voice-control: six synthetic NFM voice overs (speech-like syllables, no CTCSS) of 3 to 12 s,
 *   8 to 15 s apart, on a channel whose prior is a spectral-only 4FSK class (suspect). Expected
 *   either way: one finalized recording per over, each holding the whole over.
 *
 * Prints one JSON line per scene. Nothing touches the network or a device.
 */
import process from "node:process"
import type { VoicePrior } from "../../../src/core/scanner/channel/recording-verdict.js"
import type { DecodedLabel } from "../../../src/core/scanner/channel/voice-veto.js"
import {
	CENTRE,
	LOW_FS,
	LOW_OFFSET,
	harness,
	input,
	snapshot,
} from "../../../tests/unit/core/scanner/wideband-recorder-harness.js"
import { FskSource } from "../../../tests/unit/core/scanner/wideband-nfm-fixtures.js"

const DECODE_AT_S = 12
const TAIL_S = 40

const policy = (() => {
	const i = process.argv.indexOf("--policy")
	return i >= 0 ? process.argv[i + 1] : "on"
})()

interface Due {
	at: number
	t: { run: () => void; live: boolean }
}

function rig(
	prior: () => VoicePrior | null,
	decoded: () => DecodedLabel | null,
) {
	const h = harness({
		fs: LOW_FS,
		offset: LOW_OFFSET,
		liveClock: true,
		source: { ctcssHz: null, syllables: true },
		decodedLabel: () => decoded(),
		...(policy === "on" ? { voicePrior: () => prior() } : {}),
	})
	const timers = (
		h as { timers?: { ms: number; run: () => void; live: boolean }[] }
	).timers
	const due: Due[] = []
	let seen = 0
	/** Grace timers fire on stream time (the harness collects them; the base harness has none). */
	const tick = (): void => {
		if (timers === undefined) return
		for (; seen < timers.length; seen++) {
			const t = timers[seen]!
			due.push({ at: h.now() + t.ms, t })
		}
		for (const d of due.splice(0))
			if (d.at <= h.now()) {
				if (d.t.live) d.t.run()
			} else due.push(d)
	}
	return { h, tick }
}

const track = (id: string, start: number, last: number) =>
	snapshot(id, start, last, { centreHz: CENTRE + LOW_OFFSET })

async function pagerBurst(): Promise<Record<string, unknown>> {
	let decodedAt: number | null = null
	const prior = (): VoicePrior => ({
		labels:
			decodedAt === null ? [] : [{ protocol: "pocsag", confidence: "decoded" }],
		class: "fsk2-wide",
		analogVoice: () => false,
	})
	const { h, tick } = rig(prior, () =>
		decodedAt === null
			? null
			: { protocol: "pocsag", at: decodedAt, observationId: "decode:d_1" },
	)
	const fsk = new FskSource({
		fs: h.fs,
		offsetHz: LOW_OFFSET,
		baud: 1200,
		levelsHz: [-4500, 4500],
		preambleSymbols: 576,
		amp: 0.4,
	})
	const chunk = h.fs / 40
	await h.feed(1, false, tick)
	const onset = h.engine.liveEdge()
	const onsetMs = h.now()
	const end = onset + 4 * h.fs
	for (let i = 0; i < 160; i++) {
		h.engine.write(fsk.next(chunk, true))
		const edge = h.engine.liveEdge()
		if (edge - onset >= 0.1 * h.fs)
			h.rec.track(input("o", track("o", onset, Math.min(edge, end))))
		tick()
		await h.pump()
	}
	await h.feed(0.6, false, tick)
	h.rec.closed("o", track("o", onset, end), null, {
		analogFm: true,
		discoveryId: "d_1",
	})
	let finishAskedAtS: number | null = null
	for (let s = 4.6; s < TAIL_S; s += 0.025) {
		if (decodedAt === null && h.now() - onsetMs >= DECODE_AT_S * 1000)
			decodedAt = h.now()
		if (finishAskedAtS === null && h.ops[0]?.cut != null)
			finishAskedAtS = (h.now() - onsetMs) / 1000
		h.engine.write(fsk.next(chunk, false))
		tick()
		await h.pump()
	}
	await h.rec.stop()
	return {
		scene: "pager-burst",
		policy,
		decodeAtS: DECODE_AT_S,
		finishAskedAtS,
		outcomes: h.ops.map(o => o.outcome),
		kept: h.ops.filter(o => o.outcome === "finalized").length,
		decisions: h.rec.diagnostics().recent.map(d => d.code),
	}
}

async function voiceControl(): Promise<Record<string, unknown>> {
	const prior = (): VoicePrior => ({
		labels: [],
		class: "fsk4-12k5",
		analogVoice: () => false,
	})
	const { h, tick } = rig(prior, () => null)
	const overs = [3, 7, 12, 4, 9, 5]
	const gaps = [8, 15, 10, 12, 9, 11]
	await h.feed(1, false, tick)
	for (let k = 0; k < overs.length; k++) {
		const id = `o${k}`
		const seconds = overs[k]!
		const onset = h.engine.liveEdge()
		const end = onset + seconds * h.fs
		await h.feed(seconds, true, () => {
			const edge = h.engine.liveEdge()
			if (edge - onset >= 0.1 * h.fs)
				h.rec.track(input(id, track(id, onset, Math.min(edge, end))))
			tick()
		})
		await h.feed(0.6, false, tick)
		h.rec.closed(id, track(id, onset, end), null, {
			analogFm: true,
			discoveryId: "d_1",
		})
		await h.feed(gaps[k]!, false, tick)
	}
	await h.feed(30, false, tick)
	await h.rec.stop()
	const seconds = h.ops.map(o => Math.round((o.frames / 8000) * 10) / 10)
	// A whole over: its length + the 0.3 s pre-roll + up to the 2 s hang (+ the 0.6 s close lag).
	const whole = h.ops.every(
		(o, k) =>
			o.outcome === "finalized" &&
			o.frames / 8000 >= overs[k]! + 0.3 - 0.05 &&
			o.frames / 8000 <= overs[k]! + 0.3 + 2.6 + 0.05,
	)
	return {
		scene: "voice-control",
		policy,
		overs: overs.length,
		recordings: h.ops.length,
		outcomes: h.ops.map(o => o.outcome),
		seconds,
		oneWholeRecordingPerOver: h.ops.length === overs.length && whole,
	}
}

for (const scene of [pagerBurst, voiceControl])
	process.stdout.write(`${JSON.stringify(await scene())}\n`)
