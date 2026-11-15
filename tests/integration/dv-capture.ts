/**
 * Digital voice capture harness (dv-capture.test.ts), decoder tier: the
 * channel is already open at key-up. One point is a scene of
 * scripts/fixtures/dv-plan.mjs (its overs with true key-up and key-down) at a
 * CNR, carrier frequency error and transmitter symbol clock phase:
 *
 * 1. the plan's FM trace as cu8 IQ (fmCu8, the margin harness's capture and
 *    offset), noise only while keyed off;
 * 2. wavekit-chan with the adapter's own channel request (channelize), then
 *    the csdr FM head in-process (csdrFmHead: the same arithmetic as csdr) at
 *    the adapter's gain (channelCommand);
 * 3. the adapter's sox | dsd-fme tail, fed the discriminator audio at real
 *    time in 20 ms chunks, every output line stamped on arrival: so line times
 *    carry sox's and dsd-fme's own buffering;
 * 4. the lines through the production adapter on a fake clock at their
 *    arrival times (dv-replay.ts), and its calls scored against the plan
 *    (dv-metrics.ts).
 *
 * Timeline: plan ms t is audio ms t + LEAD_MS + the channel's group delay;
 * a line that arrives w ms after the first chunk was written is at audio ms w.
 *
 * Variant "settle-replay" (design option 4b, an experiment): each over's
 * first frames are fed twice, the copy just before the over, so dsd-fme can
 * settle on real symbols and still see the header. The repeat is whole frames
 * of the protocol (DMR: whole 60 ms TDMA frames, so slot parity holds).
 */
import { spawn } from "node:child_process"
import pino from "pino"
import {
	DV_SCENES,
	scenePlan,
	type DvScene,
	type SentOver,
} from "../../scripts/fixtures/dv-plan.mjs"
import { fmCu8 } from "../../scripts/fixtures/fsk-iq.mjs"
import {
	scoreOvers,
	type DvLine,
	type DvOver,
	type DvOverScore,
} from "../../scripts/bench/scanner-quality/dv-metrics.js"
import {
	DV_MODES,
	checkedLine,
	replayDvLines,
} from "../../scripts/bench/scanner-quality/dv-replay.js"
import type { DecoderChannelRequest } from "../../src/core/channelizer/types.js"
import {
	DsdMarginProbe,
	MARGIN_CAPTURE,
	MARGIN_CENTRE_HZ,
	channelCommand,
	plain,
} from "./dsd-fme-margin.js"
import { SYNTH_IMAGE, csdrFmHead } from "./synthetic-chain.js"

/** The design's grid (section B). */
export const DVCAP_CNR_DB = [10, 15, 20, 30]
export const DVCAP_ERRORS_HZ = [0, 600, -600]
/** Transmitter symbol clock phases (fractions of a symbol). */
export const DVCAP_PHASES = [0, 0.25, 0.5, 0.75]
export const DVCAP_VARIANTS = ["baseline", "settle-replay"] as const
export type DvVariant = (typeof DVCAP_VARIANTS)[number]

/** fmCu8's lead of noise before the trace (its default leadSeconds, 0.1 s). */
export const LEAD_MS = 100
/** Discriminator audio rate (the channel rate) and the feed chunk. */
export const AUDIO_RATE_HZ = 48_000
export const CHUNK_MS = 20

/**
 * Settle replay: repeat length and frame per protocol. The repeat is one
 * superframe where it fits the shortest over (DMR 6 x 60 ms = 360 ms; P25
 * LDU1 + LDU2 2 x 180 ms; NXDN48 and dPMR 4 x 80 ms; D-STAR one 420 ms
 * superframe), YSF two 100 ms frames (its header and first V/D frame).
 */
export const SETTLE_FRAME_MS: Readonly<Record<string, number>> = {
	dmr: 60,
	p25: 180,
	ysf: 100,
	nxdn48: 80,
	dpmr: 80,
	dstar: 420,
}
export const SETTLE_REPEAT_MS: Readonly<Record<string, number>> = {
	dmr: 360,
	p25: 360,
	ysf: 200,
	nxdn48: 320,
	dpmr: 320,
	dstar: 420,
}

/** One measurement point. */
export interface DvPointSpec {
	scene: DvScene
	variant: DvVariant
	cnrDb: number
	errorHz: number
	phase: number
	seed: number
}

/** The scenes the quick subset runs: DMR direct and repeater, every one. */
export const QUICK_SCENES: readonly DvScene[] = DV_SCENES.filter(
	s => s.protocol === "dmr",
)

/**
 * The points to run. Full: every scene x CNR x error x phase. Quick: the DMR
 * scenes at 20 dB, 0 Hz, phase 0. `only` narrows each axis.
 */
export function dvGrid({
	quick = false,
	variant = "baseline",
	scenes,
	cnrDb,
	errorsHz,
	phases,
}: {
	quick?: boolean
	variant?: DvVariant
	scenes?: readonly string[]
	cnrDb?: readonly number[]
	errorsHz?: readonly number[]
	phases?: readonly number[]
} = {}): DvPointSpec[] {
	const pool = (quick ? QUICK_SCENES : DV_SCENES).filter(
		s => scenes === undefined || scenes.includes(s.name),
	)
	const cnrs = cnrDb ?? (quick ? [20] : DVCAP_CNR_DB)
	const errors = errorsHz ?? (quick ? [0] : DVCAP_ERRORS_HZ)
	const ph = phases ?? (quick ? [0] : DVCAP_PHASES)
	const out: DvPointSpec[] = []
	for (const scene of pool)
		for (const errorHz of errors)
			for (const c of cnrs)
				ph.forEach((phase, i) =>
					out.push({
						scene,
						variant,
						cnrDb: c,
						errorHz,
						phase,
						seed: 1000 * (i + 1) + c,
					}),
				)
	return out
}

/**
 * Wall time of one point beyond its scene's length: a container start (about
 * 2 s), the IQ and channelizer for up to a 45 s scene (fmCu8 and wavekit-chan
 * at 1.024 Msps, about 4 s), the adapter replay (well under 1 s), rounded up
 * to 10 s. A guess until the first in-image run reports its own.
 */
export const POINT_OVERHEAD_S = 10
/** The quick subset must finish in this (WAVEKIT_DVCAP_QUICK=1). */
export const QUICK_BUDGET_S = 600

/** A scene's length and over count (its plan without the trace), by scene. */
const sceneShape = new WeakMap<DvScene, { durationMs: number; overs: number }>()
function shapeOf(scene: DvScene): { durationMs: number; overs: number } {
	let s = sceneShape.get(scene)
	if (s === undefined) {
		const plan = scenePlan(scene, { trace: false })
		s = { durationMs: plan.durationMs, overs: plan.overs.length }
		sceneShape.set(scene, s)
	}
	return s
}

/** Estimated wall seconds of `points`: each scene fed at real time plus the overhead. */
export function gridSeconds(points: readonly DvPointSpec[]): number {
	return points.reduce((s, p) => {
		const plan = shapeOf(p.scene)
		const repeat =
			p.variant === "settle-replay"
				? (plan.overs * (SETTLE_REPEAT_MS[p.scene.protocol] ?? 0)) / 1000
				: 0
		return (
			s + plan.durationMs / 1000 + LEAD_MS / 1000 + repeat + POINT_OVERHEAD_S
		)
	}, 0)
}

const bytesOf = (ms: number) => 2 * Math.round((ms / 1000) * AUDIO_RATE_HZ)

/**
 * Settle replay on s16 audio: before each over (`startMs` on the audio
 * timeline, ascending), the over's first `repeatMs` again, cut to whole
 * `frameMs` frames that fit the over. Returns the audio and `shift`, which
 * maps a time of the input onto the output: every copy before it moves it.
 */
export function settleReplay(
	pcm: Buffer,
	overs: readonly { startMs: number; endMs: number }[],
	repeatMs: number,
	frameMs: number,
): { pcm: Buffer; shift: (ms: number) => number; repeatsMs: number[] } {
	const sorted = [...overs].sort((a, b) => a.startMs - b.startMs)
	const parts: Buffer[] = []
	const repeatsMs: number[] = []
	let at = 0
	for (const o of sorted) {
		const len =
			Math.floor(Math.min(repeatMs, o.endMs - o.startMs) / frameMs) * frameMs
		const from = Math.min(pcm.length, bytesOf(o.startMs))
		parts.push(pcm.subarray(at, from))
		parts.push(pcm.subarray(from, Math.min(pcm.length, from + bytesOf(len))))
		repeatsMs.push(len)
		at = from
	}
	parts.push(pcm.subarray(at))
	const shift = (ms: number) => {
		let out = ms
		sorted.forEach((o, i) => {
			if (o.startMs <= ms) out += repeatsMs[i]!
		})
		return out
	}
	return { pcm: Buffer.concat(parts), shift, repeatsMs }
}

/** Runs a shell command, feeding it `input` chunks and handing back every output line. */
export type DvRunner = (
	command: string,
	input: AsyncIterable<Buffer>,
	onLine: (text: string) => void,
) => Promise<void>

/**
 * The default runner: /bin/sh here, or the core image (`docker run -i
 * --network none`) with WAVEKIT_SYNTH_IMAGE. `cat` reads stdin first: sox
 * stops early when it reads node's stdin socket itself (synthetic-chain.ts).
 */
export const shellRunner: DvRunner = async (command, input, onLine) => {
	const script = `(cat | ${command}) 2>&1`
	const child =
		SYNTH_IMAGE === ""
			? spawn("/bin/sh", ["-c", script], {
					stdio: ["pipe", "pipe", "ignore"],
				})
			: spawn(
					"docker",
					[
						"run",
						"-i",
						"--rm",
						"--network",
						"none",
						"--entrypoint",
						"/bin/sh",
						SYNTH_IMAGE,
						"-c",
						script,
					],
					{ stdio: ["pipe", "pipe", "ignore"] },
				)
	let rest = ""
	child.stdout.on("data", (chunk: Buffer) => {
		rest += chunk.toString("latin1")
		let nl: number
		while ((nl = rest.indexOf("\n")) >= 0) {
			onLine(rest.slice(0, nl).replace(/\r$/, ""))
			rest = rest.slice(nl + 1)
		}
	})
	const exited = new Promise<void>((done, fail) => {
		child.once("error", fail)
		child.once("close", () => done())
	})
	child.stdin.on("error", () => {
		// The command exited before reading everything: its lines still count.
	})
	for await (const chunk of input)
		if (!child.stdin.write(chunk))
			await new Promise(resume => child.stdin.once("drain", resume))
	child.stdin.end()
	await exited
	if (rest !== "") onLine(rest)
}

/**
 * Feeds `pcm` (s16, AUDIO_RATE_HZ) to `command` at `speed` times real time in
 * CHUNK_MS chunks (chunk k is due k x CHUNK_MS / speed after the first), and
 * returns every line with its arrival time in audio ms (wall ms x speed).
 */
export async function feedRealTime(
	command: string,
	pcm: Buffer,
	{ run = shellRunner, speed = 1 }: { run?: DvRunner; speed?: number } = {},
): Promise<DvLine[]> {
	const lines: DvLine[] = []
	const chunk = bytesOf(CHUNK_MS)
	let t0 = 0
	async function* chunks(): AsyncGenerator<Buffer> {
		t0 = performance.now()
		for (let k = 0; k * chunk < pcm.length; k++) {
			const due = t0 + (k * CHUNK_MS) / speed
			const wait = due - performance.now()
			if (wait > 0) await new Promise(r => setTimeout(r, wait))
			yield pcm.subarray(k * chunk, (k + 1) * chunk)
		}
	}
	await run(command, chunks(), text => {
		if (text.trim() === "") return
		lines.push({ atMs: (performance.now() - t0) * speed, text: plain(text) })
	})
	return lines
}

/** The plan's overs on the audio timeline (`offsetMs`: lead plus group delay, `shift`: a variant's). */
export function audioOvers(
	overs: readonly SentOver[],
	offsetMs: number,
	shift: (ms: number) => number = ms => ms,
): DvOver[] {
	return overs.map(o => ({
		index: o.index,
		protocol: o.protocol,
		slot: o.slot,
		startMs: shift(o.startMs + offsetMs),
		endMs: shift(o.endMs + offsetMs),
		frames: o.frames,
		terminator: o.terminator,
		clear: true,
		ids: o.ids as Record<string, unknown>,
	}))
}

/** Splits `cf32`-producing work out so a test can stand in for wavekit-chan. */
export type DvChannelize = (
	iq: Buffer,
	request: DecoderChannelRequest,
) => Promise<{ cf32: Buffer; groupDelaySamples: number }>

export interface DvPointResult {
	spec: DvPointSpec
	rows: DvOverScore[]
	overs: DvOver[]
	lines: DvLine[]
}

const silent = pino({ level: "silent" })

function probe(mode: string, path: "channel" | "raw"): DsdMarginProbe {
	return new DsdMarginProbe(
		{
			id: "dsd-fme",
			type: "dsd-fme",
			enabled: true,
			options:
				path === "channel"
					? { mode, inputSampleRate: AUDIO_RATE_HZ, inputIqFormat: "cf32" }
					: {
							mode,
							inputSampleRate: MARGIN_CAPTURE.rateHz,
							offsetHz: MARGIN_CAPTURE.offsetHz,
						},
		},
		silent,
	)
}

/** The adapter's channel request for a mode (the raw path's request at the margin capture). */
export function channelRequest(mode: string): DecoderChannelRequest {
	return probe(mode, "raw").getChannelRequest({
		sampleRateHz: MARGIN_CAPTURE.rateHz,
		centerHz: MARGIN_CENTRE_HZ,
	}) as DecoderChannelRequest
}

/** Measures one point: plan, IQ, channel, real-time decoder, adapter replay, scores. */
export async function measureDvPoint(
	spec: DvPointSpec,
	{
		channelize,
		run = shellRunner,
		speed = 1,
	}: { channelize: DvChannelize; run?: DvRunner; speed?: number },
): Promise<DvPointResult> {
	const { scene } = spec
	const mode = DV_MODES[scene.protocol] ?? "auto"
	const plan = scenePlan(scene, {
		rateHz: AUDIO_RATE_HZ,
		shape: { delaySymbols: spec.phase },
	})
	const iq = fmCu8(plan.freq, {
		sampleRateHz: MARGIN_CAPTURE.rateHz,
		offsetHz: MARGIN_CAPTURE.offsetHz + spec.errorHz,
		cnrDb: spec.cnrDb,
		seed: spec.seed,
		envelope: plan.envelope,
	})
	const { cf32, groupDelaySamples } = await channelize(iq, channelRequest(mode))
	const { tail, gain } = channelCommand(probe(mode, "channel"))
	let pcm = csdrFmHead(cf32, gain)
	const offsetMs = LEAD_MS + (groupDelaySamples / AUDIO_RATE_HZ) * 1000
	let shift = (ms: number) => ms
	if (spec.variant === "settle-replay") {
		const replayed = settleReplay(
			pcm,
			audioOvers(plan.overs, offsetMs),
			SETTLE_REPEAT_MS[scene.protocol] ?? 0,
			SETTLE_FRAME_MS[scene.protocol] ?? 1,
		)
		pcm = replayed.pcm
		shift = replayed.shift
	}
	const lines = await feedRealTime(tail.join(" | "), pcm, { run, speed })
	const overs = audioOvers(plan.overs, offsetMs, shift)
	const calls = replayDvLines(lines, mode)
	return {
		spec,
		rows: scoreOvers(overs, calls, lines, checkedLine),
		overs,
		lines,
	}
}

/**
 * A point's lines and overs in the truth scorecard's seed format
 * (tests/mocks/fixtures/synthetic/dv-latency-*.json), recorded, not
 * provisional: what replaces a modelled seed once the baseline ran.
 */
export function recordedSeed(r: DvPointResult, frequencyHz: number): unknown {
	const round = (v: number) => Math.round(v * 10) / 10
	return {
		version: 1,
		provisional: false,
		note: `Recorded by tests/integration/dv-capture.test.ts: ${r.spec.variant}, ${r.spec.cnrDb} dB, ${r.spec.errorHz} Hz, phase ${r.spec.phase}.`,
		scene: r.spec.scene.name,
		protocol: r.spec.scene.protocol,
		frequencyHz,
		overs: r.overs.map(o => ({
			index: o.index,
			protocol: o.protocol,
			slot: o.slot,
			startMs: round(o.startMs),
			endMs: round(o.endMs),
			frames: o.frames,
			terminator: o.terminator,
			clear: o.clear ?? true,
			ids: o.ids ?? {},
		})),
		lines: r.lines.map(l => ({ atMs: round(l.atMs), text: l.text })),
	}
}
