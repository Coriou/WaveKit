/**
 * Block-script harness for the WG10 req 3.8 carrier path of the analog transmission tracker:
 * a source with a real CarrierBlockLog, a scripted 10 ms block sequence (squelch open,
 * carried) with its PCM, and three delivery orders (per block, batched blocks after their PCM,
 * PCM split at random byte offsets).
 */
import type { AnalogTransmissionPayload } from "@wavekit/api-types"
import {
	AnalogTransmissionTracker,
	CarrierBlockLog,
} from "../../../src/core/analog-transmission.js"
import type {
	AnalogTransmissionTrackerOptions,
	ToneDetectorPort,
} from "../../../src/core/analog-transmission.js"
import { HygieneSource } from "./analog-transmission-hygiene-fakes.js"
import { mulberry32 } from "./audio-tones/synth.js"

export const RATE = 8000
/** Samples per 10 ms block at RATE. */
export const BLOCK = 80
export const T0 = 1_700_000_000_000

export class CarrierSource extends HygieneSource {
	readonly log = new CarrierBlockLog()
	hasLog = true
	carrierBlockLog(): CarrierBlockLog | null {
		return this.hasLog ? this.log : null
	}
}

export interface BlockScript {
	open: boolean[]
	carried: boolean[]
	/** One audio sample array, BLOCK samples per block. */
	audio: number[]
}

export function emptyScript(): BlockScript {
	return { open: [], carried: [], audio: [] }
}

/** Appends `blocks` blocks; `audio(i)` gives sample i of this stretch. */
export function addBlocks(
	script: BlockScript,
	blocks: number,
	open: boolean | ((b: number) => boolean),
	carried: boolean | ((b: number) => boolean),
	audio: (i: number) => number,
): void {
	for (let b = 0; b < blocks; b++) {
		const o = typeof open === "function" ? open(b) : open
		const c = typeof carried === "function" ? carried(b) : carried
		script.open.push(o)
		script.carried.push(c)
		for (let s = 0; s < BLOCK; s++) script.audio.push(audio(b * BLOCK + s))
	}
}

export function noise(seed: number, std: number): (i: number) => number {
	const rand = mulberry32(seed)
	return () => std * (rand() * 2 - 1) * 1.7
}

export function tone(hz: number, amplitude = 0.15): (i: number) => number {
	return i => amplitude * Math.sin((2 * Math.PI * hz * i) / RATE)
}

export function fromArray(samples: ArrayLike<number>, offset = 0) {
	return (i: number): number => samples[offset + i] ?? 0
}

/** Interference: opens of `openMs` every `periodMs`, carried only in runs of at most `maxRun`. */
export function flicker(
	script: BlockScript,
	ms: number,
	seed: number,
	options: { openMs?: number; periodMs?: number; maxRun?: number } = {},
): void {
	const openBlocks = (options.openMs ?? 500) / 10
	const period = (options.periodMs ?? 1000) / 10
	const maxRun = options.maxRun ?? 3
	addBlocks(
		script,
		ms / 10,
		b => b % period < openBlocks,
		b => b % period < openBlocks && b % 7 < maxRun,
		noise(seed, 0.3),
	)
}

export type Delivery = "block" | "batched" | "split"

export interface RunResult {
	rows: AnalogTransmissionPayload[]
	tracker: AnalogTransmissionTracker
	source: CarrierSource
	pushed: number[]
}

/**
 * Plays a script into a tracker. `format` f32le lets a recording detector read sample values
 * exactly (Property 14). Ends with a stop after the script.
 */
export function runScript(
	script: BlockScript,
	options: {
		delivery?: Delivery
		seed?: number
		format?: "s16le" | "f32le"
		recordPushes?: boolean
		/** No block log: the 3.7 path (the carrier counter still counts carried blocks). */
		legacy?: boolean
		/** Never start the tracker (harness cost baseline). */
		detached?: boolean
		/** "block" delivery: PCM arrives this many blocks after its block. */
		pcmLagBlocks?: number
		/** Called before block k is played (e.g. a reconfigure). */
		onBlock?: (k: number, source: CarrierSource) => void
		tracker?: Partial<AnalogTransmissionTrackerOptions>
	} = {},
): RunResult {
	const delivery = options.delivery ?? "block"
	const format = options.format ?? "s16le"
	const width = format === "s16le" ? 2 : 4
	const source = new CarrierSource()
	source.carrier = 0
	source.hasLog = options.legacy !== true
	const runToken = {}
	let now = T0
	const rows: AnalogTransmissionPayload[] = []
	const pushed: number[] = []
	const recording = (): ToneDetectorPort => ({
		push(pcm) {
			for (let i = 0; i + 4 <= pcm.length; i += 4)
				pushed.push(pcm.readFloatLE(i))
		},
		result: () => ({ ctcssHz: null, dtmf: null, dcs: null }),
		reset() {},
	})
	const tracker = new AnalogTransmissionTracker({
		source,
		frequencyAt: (_id, offsetHz) => ({
			hz: 446_068_750 + offsetHz,
			tuningTrust: "commanded",
		}),
		now: () => now,
		randomUUID: (() => {
			let n = 0
			return () => `tx-${++n}`
		})(),
		setTimer: () => () => undefined,
		...(options.recordPushes === true ? { createToneDetector: recording } : {}),
		...options.tracker,
	})
	tracker.on("closed", row => rows.push(row))
	if (options.detached !== true) tracker.start()
	const pcmFormat = { rate: RATE, format }
	const pcm = Buffer.alloc(script.audio.length * width)
	script.audio.forEach((v, i) => {
		if (format === "f32le") pcm.writeFloatLE(v, i * 4)
		else
			pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v)) * 32_767), i * 2)
	})
	const rand = mulberry32(options.seed ?? 7)
	let pcmSent = 0
	const sendPcm = (upTo: number): void => {
		while (pcmSent < upTo) {
			const size =
				delivery === "split"
					? Math.min(upTo - pcmSent, 1 + Math.floor(rand() * 700))
					: upTo - pcmSent
			const chunk = Buffer.from(pcm.subarray(pcmSent, pcmSent + size))
			pcmSent += size
			source.log.notePcm(runToken, RATE, chunk.length)
			source.emit("pcm", chunk, pcmFormat)
		}
	}
	let noted = 0
	const noteBlocks = (upTo: number): void => {
		for (; noted < upTo; noted++) {
			const open = script.open[noted] ?? false
			if (open !== source.open) source.gate(open)
			const carried = script.carried[noted] ?? false
			source.log.note(runToken, RATE, open, carried)
			if (carried && source.carrier !== null) source.carrier += 1
		}
	}
	const blocks = script.open.length
	const blockBytes = BLOCK * width
	for (let k = 0; k < blocks; k++) {
		now = T0 + (k + 1) * 10
		options.onBlock?.(k, source)
		if (delivery === "block") {
			noteBlocks(k + 1)
			sendPcm(Math.max(0, (k + 1 - (options.pcmLagBlocks ?? 0)) * blockBytes))
		} else if (delivery === "batched") {
			// PCM first; blocks in batches of ten, 100 ms late.
			sendPcm((k + 1) * blockBytes)
			if ((k + 1) % 10 === 0) noteBlocks(k + 1)
		} else {
			noteBlocks(k + 1)
			// PCM lags up to 30 ms behind its blocks, split at random offsets.
			sendPcm(Math.max(0, (k - 3) * blockBytes))
		}
		if (k % 10 === 9) {
			source.open = script.open[k] ?? false
			source.level()
		}
	}
	noteBlocks(blocks)
	sendPcm(pcm.length)
	source.level()
	tracker.stop()
	return { rows, tracker, source, pushed }
}

export const at = (block: number): string =>
	new Date(T0 + block * 10).toISOString()
