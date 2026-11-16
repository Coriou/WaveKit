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
import { spawn, type ChildProcessByStdio } from "node:child_process"
import { renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Readable, Writable } from "node:stream"
import pino from "pino"
import {
	DV_SCENES,
	scenePlan,
	type DvScene,
	type SentOver,
} from "../../scripts/fixtures/dv-plan.mjs"
import { fmCu8 } from "../../scripts/fixtures/fsk-iq.mjs"
import {
	dvTable,
	scoreOvers,
	type DvLine,
	type DvPoint,
	type DvOver,
	type DvOverScore,
} from "../../scripts/bench/scanner-quality/dv-metrics.js"
import {
	DV_MODES,
	checkedLine,
	replayDvLines,
} from "../../scripts/bench/scanner-quality/dv-replay.js"
import { parseDvSeed } from "../../scripts/bench/scanner-quality/truth-dv.js"
import type { DecoderChannelRequest } from "../../src/core/channelizer/types.js"
import {
	DsdMarginProbe,
	MARGIN_CAPTURE,
	MARGIN_CENTRE_HZ,
	channelCommand,
	plain,
} from "./dsd-fme-margin.js"
import { SYNTH_IMAGE, csdrFmHead } from "./synthetic-chain.js"
import { WaveKitError } from "../../src/utils/errors.js"

/** The design's grid (section B). */
export const DVCAP_CNR_DB = [10, 12, 15, 20, 30]
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
 * Wall time of one point beyond feeding its scene at real time:
 * POINT_FIXED_S plus POINT_PER_SCENE_S per second of IQ (scene and lead).
 * Fixed 5 s: a container start (about 2 s), its stop and removal after EOF
 * (about 2 s), the adapter replay and scoring (well under 1 s). Per scene
 * second 0.35 s: the IQ (fmCu8 at 1.024 Msps, measured at about 0.29 s per
 * scene second) and wavekit-chan with the in-process csdr head (about
 * 0.06 s, from the earlier 4 s for a 45 s scene less its IQ share).
 */
export const POINT_FIXED_S = 5
export const POINT_PER_SCENE_S = 0.35
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

/**
 * Estimated wall seconds of `points`: each scene (with its lead and any
 * settle-replay copies) fed at real time, plus POINT_FIXED_S and
 * POINT_PER_SCENE_S per second of its IQ.
 */
export function gridSeconds(points: readonly DvPointSpec[]): number {
	return points.reduce((s, p) => {
		const plan = shapeOf(p.scene)
		const repeat =
			p.variant === "settle-replay"
				? (plan.overs * (SETTLE_REPEAT_MS[p.scene.protocol] ?? 0)) / 1000
				: 0
		const iq = plan.durationMs / 1000 + LEAD_MS / 1000
		return s + iq + repeat + POINT_FIXED_S + POINT_PER_SCENE_S * iq
	}, 0)
}

/**
 * The capture test's timeout for `points`: twice gridSeconds (a loaded host
 * may run the IQ and channelizer at half the estimated speed) plus 600 s
 * (READY_TIMEOUT_MS and POST_EOF_TIMEOUT_MS of one point that fails slowly,
 * 40 s, and the table writes, with room), in ms.
 */
export function gridTimeoutMs(points: readonly DvPointSpec[]): number {
	return Math.ceil((2 * gridSeconds(points) + 600) * 1000)
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

/** How a runner's command ended when that is not a failure (createShellRunner). */
export interface DvRunEnd {
	/** Its non-zero exit or signal after it read all its input ("exit 3", "SIGSEGV"). */
	exit?: string
}

/**
 * Runs a shell command, feeding it `input` chunks and handing back every
 * output line. A runner pulls the first chunk only once the command can read
 * it (feedRealTime starts its clock at that pull), and rejects when the
 * command fails.
 */
export type DvRunner = (
	command: string,
	input: AsyncIterable<Buffer>,
	onLine: (text: string) => void,
) => Promise<DvRunEnd | void>

/** Printed by the runner's script just before the command starts reading. */
export const DVCAP_READY = "__DVCAP_READY__"
/**
 * Longest wait for DVCAP_READY: a container start is about 2 s
 * (POINT_FIXED_S), 15 times that (30 s) covers a cold image cache on a
 * loaded host. Past it the point fails: a later start would only be hidden in
 * the first over's latency.
 */
export const READY_TIMEOUT_MS = 30_000
/**
 * Longest wait for the command to exit once its stdin ended: sox and dsd-fme
 * flush in well under 1 s after EOF and `docker run --rm` stops and removes
 * its container in about 2 s, so 10 s is five times what an exit takes. Past
 * it the point fails and the child is killed by its own handle: a command
 * that never exits would otherwise hold the run until the test's timeout.
 */
export const POST_EOF_TIMEOUT_MS = 10_000
/**
 * The most an error quotes of what the child printed (its stderr, and its
 * output: the command's stderr is merged into it), last characters first.
 */
export const STDERR_TAIL_CHARS = 1000

/** Starts the runner's /bin/sh script: here, or in the core image. */
export type DvSpawn = (
	script: string,
) => ChildProcessByStdio<Writable, Readable, Readable>

/**
 * /bin/sh here, or the core image (`docker run -i --init --network none`)
 * with WAVEKIT_SYNTH_IMAGE. `--init` runs a minimal init as PID 1 so a
 * SIGTERM from the docker client (forwarded by its signal proxy when the
 * runner kills it) stops the script and its pipeline instead of being
 * ignored by a shell running as PID 1.
 */
export const defaultSpawn: DvSpawn = script =>
	SYNTH_IMAGE === ""
		? spawn("/bin/sh", ["-c", script], { stdio: ["pipe", "pipe", "pipe"] })
		: spawn("docker", dockerArgs(SYNTH_IMAGE, script), {
				stdio: ["pipe", "pipe", "pipe"],
			})

/** The `docker run` arguments of defaultSpawn. */
export function dockerArgs(image: string, script: string): string[] {
	return [
		"run",
		"-i",
		"--init",
		"--rm",
		"--network",
		"none",
		"--entrypoint",
		"/bin/sh",
		image,
		"-c",
		script,
	]
}

/** Keeps the last `max` characters of what is appended. */
function keepTail(max: number): {
	add: (s: string) => void
	text: () => string
} {
	let kept = ""
	return {
		add: s => {
			kept = (kept + s).slice(-max)
		},
		text: () => kept.trim(),
	}
}

const runnerError = (message: string, output: string): WaveKitError =>
	new WaveKitError(
		output === "" ? message : `${message}; output tail: ${output}`,
		"DVCAP_RUNNER",
	)

/** Rejects with `error()` after `ms`; `clear` stops it. */
function deadline(
	ms: number,
	error: () => Error,
): { promise: Promise<never>; clear: () => void } {
	let timer: NodeJS.Timeout | undefined
	const promise = new Promise<never>((_, fail) => {
		timer = setTimeout(() => fail(error()), ms)
	})
	return { promise, clear: () => clearTimeout(timer) }
}

/**
 * A runner on `spawnChild`. The script prints DVCAP_READY, then runs
 * `(cat | command) 2>&1`: `cat` reads stdin first, as sox stops early when it
 * reads node's stdin socket itself (synthetic-chain.ts). The input is not
 * pulled until the marker arrives (at most `readyTimeoutMs`), and the marker
 * is not a decoder line. Once stdin ended the command has `postEofTimeoutMs`
 * to exit.
 *
 * Fails (with the last STDERR_TAIL_CHARS the child printed): a spawn error;
 * an exit before the marker; no marker in time; a non-zero exit or a signal
 * before all the input was written; no exit in time after EOF. A non-zero
 * exit or a signal AFTER all the input was written is not a failure: the
 * runner resolves with it (`exit`), and the caller keeps the lines it
 * printed (measureDvPoint fails the point only when there are none). dsd-fme
 * can exit non-zero at EOF after decoding everything it was fed, so its lines
 * are a measurement, and the exit is recorded next to them. On any failure
 * stdin is ended and the child killed by its own handle.
 */
export function createShellRunner({
	spawnChild = defaultSpawn,
	readyTimeoutMs = READY_TIMEOUT_MS,
	postEofTimeoutMs = POST_EOF_TIMEOUT_MS,
}: {
	spawnChild?: DvSpawn
	readyTimeoutMs?: number
	postEofTimeoutMs?: number
} = {}): DvRunner {
	return async (command, input, onLine) => {
		const child = spawnChild(`echo ${DVCAP_READY}; (cat | ${command}) 2>&1`)
		const stderr = keepTail(STDERR_TAIL_CHARS)
		let ready = false
		const readyNow = Promise.withResolvers<void>()
		let rest = ""
		const line = (text: string) => {
			if (!ready && text === DVCAP_READY) {
				ready = true
				readyNow.resolve()
				return
			}
			stderr.add(`${text}\n`)
			if (ready) onLine(text)
		}
		child.stdout.on("data", (chunk: Buffer) => {
			rest += chunk.toString("latin1")
			let nl: number
			while ((nl = rest.indexOf("\n")) >= 0) {
				line(rest.slice(0, nl).replace(/\r$/, ""))
				rest = rest.slice(nl + 1)
			}
		})
		child.stderr.on("data", (chunk: Buffer) =>
			stderr.add(chunk.toString("latin1")),
		)
		let gone = false
		const exited = new Promise<{
			code: number | null
			signal: NodeJS.Signals | null
		}>((done, fail) => {
			child.once("error", fail)
			child.once("close", (code, signal) => {
				gone = true
				done({ code, signal })
			})
		})
		// Seen by the awaits below; keeps an early rejection from going unhandled.
		exited.catch(() => {})
		const settled = exited.then(
			() => {},
			() => {},
		)
		child.stdin.on("error", () => {
			// The command exited before reading everything: decided at its exit.
		})
		let failed = true
		const readyWait = deadline(readyTimeoutMs, () =>
			runnerError(
				`no ${DVCAP_READY} within ${readyTimeoutMs} ms`,
				stderr.text(),
			),
		)
		let eofWait: ReturnType<typeof deadline> | undefined
		try {
			await Promise.race([
				readyNow.promise,
				// Settles only before the marker: once ready, `await exited` below
				// sees the exit (and a spawn error) instead.
				exited.then(
					({ code, signal }) => {
						if (!ready)
							throw runnerError(
								`the command exited (${signal ?? code}) before ${DVCAP_READY}`,
								stderr.text(),
							)
					},
					(error: unknown) => {
						if (!ready) throw error
					},
				),
				readyWait.promise,
			])
			readyWait.clear()
			let allWritten = true
			for await (const chunk of input) {
				if (gone) {
					allWritten = false
					break
				}
				if (!child.stdin.write(chunk))
					// A command that exits mid-stream never drains: its exit ends the wait.
					await Promise.race([
						new Promise(resume => child.stdin.once("drain", resume)),
						settled,
					])
			}
			child.stdin.end()
			eofWait = deadline(postEofTimeoutMs, () =>
				runnerError(
					`the command did not exit within ${postEofTimeoutMs} ms after its input ended`,
					stderr.text(),
				),
			)
			const { code, signal } = await Promise.race([exited, eofWait.promise])
			eofWait.clear()
			if (rest !== "") line(rest)
			const how = signal ?? `exit ${code}`
			if (code !== 0 && !allWritten)
				throw runnerError(
					`the command failed (${how}) before it read all its input`,
					stderr.text(),
				)
			failed = false
			return code === 0 ? {} : { exit: how }
		} finally {
			readyWait.clear()
			eofWait?.clear()
			if (failed) {
				child.stdin.end()
				if (child.exitCode === null && child.signalCode === null)
					child.kill("SIGTERM")
			}
		}
	}
}

/** The default runner (defaultSpawn). */
export const shellRunner: DvRunner = createShellRunner()

/** What feedRealTime heard: every line, and a recorded non-failing exit. */
export interface DvFeed {
	lines: DvLine[]
	exit?: string
}

/**
 * Feeds `pcm` (s16, AUDIO_RATE_HZ) to `command` at `speed` times real time in
 * CHUNK_MS chunks, and returns every line with its arrival time in audio ms
 * (wall ms x speed). Chunk k is due at its END, (k + 1) x CHUNK_MS / speed
 * after the clock starts (the last at the end of the audio): a receiver has a
 * chunk only once its last sample was on air, so a line never arrives before
 * the audio it decodes, and the line times carry no 0 to 20 ms early bias.
 */
export async function feedRealTime(
	command: string,
	pcm: Buffer,
	{ run = shellRunner, speed = 1 }: { run?: DvRunner; speed?: number } = {},
): Promise<DvFeed> {
	const lines: DvLine[] = []
	const chunk = bytesOf(CHUNK_MS)
	let t0 = 0
	// The clock starts at the runner's first pull (after its ready handshake),
	// not at its spawn: a container start is not decoder latency.
	async function* chunks(): AsyncGenerator<Buffer> {
		t0 = performance.now()
		for (let k = 0; k * chunk < pcm.length; k++) {
			const endByte = Math.min(pcm.length, (k + 1) * chunk)
			const endMs = (endByte / 2 / AUDIO_RATE_HZ) * 1000
			// A timer can fire a little early on the loop's cached clock: wait again.
			let wait: number
			while ((wait = t0 + endMs / speed - performance.now()) > 0)
				await new Promise(r => setTimeout(r, Math.ceil(wait)))
			yield pcm.subarray(k * chunk, endByte)
		}
	}
	const end = await run(command, chunks(), text => {
		if (text.trim() === "") return
		lines.push({ atMs: (performance.now() - t0) * speed, text: plain(text) })
	})
	return end?.exit === undefined ? { lines } : { lines, exit: end.exit }
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
		nominalMs: o.nominalMs,
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
	/** The decoder's non-zero exit after all its input (createShellRunner): recorded only. */
	exit?: string
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
	const { lines, exit } = await feedRealTime(tail.join(" | "), pcm, {
		run,
		speed,
	})
	if (lines.length === 0)
		throw new WaveKitError(
			`${scene.name} (${spec.variant}, ${spec.cnrDb} dB, ${spec.errorHz} Hz, phase ${spec.phase}): the decoder printed no line at all${exit === undefined ? "" : ` (${exit})`}`,
			"DVCAP_NO_LINES",
		)
	const overs = audioOvers(plan.overs, offsetMs, shift)
	const calls = replayDvLines(lines, mode)
	return {
		spec,
		rows: scoreOvers(overs, calls, lines, checkedLine),
		overs,
		lines,
		...(exit === undefined ? {} : { exit }),
	}
}

/**
 * A point's name in a recorded seed (its `scene`, so its case `dv-<name>`
 * and file `dv-latency-<name>.json`): the scene and the grid point, so two
 * points of one scene never collide. Lower case, digits and dashes (the
 * seed schema): `-m600hz` for -600 Hz, phase in hundredths of a symbol
 * (`p25` for 0.25). At most 24 + 14 + 6 + 7 + 5 = 56 characters, under the
 * schema's 64.
 */
export function recordedSceneName(spec: DvPointSpec): string {
	const hz = `${spec.errorHz < 0 ? "m" : ""}${Math.abs(spec.errorHz)}hz`
	const phase = `p${Math.round(spec.phase * 100)}`
	return `${spec.scene.name}-${spec.variant}-${spec.cnrDb}db-${hz}-${phase}`
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
		scene: recordedSceneName(r.spec),
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

/** Writes `text` to `path` through a temporary file and a rename: a reader never sees half of it. */
export function writeAtomic(path: string, text: string): void {
	const tmp = `${path}.${process.pid}.tmp`
	writeFileSync(tmp, text)
	renameSync(tmp, path)
}

/** The capture file: the table, then the points as JSON in a comment. */
export const captureText = (points: readonly DvPoint[]): string =>
	`${dvTable(points)}\n\n<!--\n${JSON.stringify(points, null, 1)}\n-->\n`

/**
 * Runs `grid` point by point with `measure`. After every point (measured or
 * failed) the table and JSON are rewritten to `out` (writeAtomic), so a run
 * stopped part way keeps every point done. A point that throws becomes a
 * point with its `error` and no rows, and the run goes on; the caller fails
 * on `failed` at the end. With `linesDir`, each measured point's seed
 * (recordedSeed) is checked against the scorecard's schema (parseDvSeed)
 * before it is written: a seed the scorecard would refuse fails its point.
 */
export async function runDvGrid(
	grid: readonly DvPointSpec[],
	{
		measure,
		out,
		linesDir,
		frequencyHz,
	}: {
		measure: (spec: DvPointSpec) => Promise<DvPointResult>
		out: string
		linesDir?: string
		frequencyHz: number
	},
): Promise<{ points: DvPoint[]; failed: DvPoint[] }> {
	const points: DvPoint[] = []
	for (const spec of grid) {
		const at = {
			scene: spec.scene.name,
			variant: spec.variant,
			cnrDb: spec.cnrDb,
			errorHz: spec.errorHz,
			phase: spec.phase,
		}
		try {
			const r = await measure(spec)
			if (linesDir !== undefined) {
				const file = join(
					linesDir,
					`dv-latency-${recordedSceneName(spec)}.json`,
				)
				const text = `${JSON.stringify(recordedSeed(r, frequencyHz), null, "\t")}\n`
				parseDvSeed(file, text)
				writeAtomic(file, text)
			}
			points.push({
				...at,
				rows: r.rows,
				...(r.exit === undefined ? {} : { exit: r.exit }),
			})
		} catch (err: unknown) {
			points.push({
				...at,
				rows: [],
				error: err instanceof Error ? err.message : String(err),
			})
		}
		writeAtomic(out, captureText(points))
	}
	return { points, failed: points.filter(p => p.error !== undefined) }
}
