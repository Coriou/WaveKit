/**
 * A fake digital-voice call tap source for the recorder tests (modelled on
 * src/core/dv-tap/types.ts; synthetic audio only).
 */
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import pino from "pino"
import type {
	DvCallTap,
	DvCallTapSource,
	DvTapCallEnd,
	DvTapCallState,
	DvTapEndReason,
} from "../../../../src/core/dv-tap/types.js"
import {
	createDvCallRecorder,
	nodeDvRecorderFs,
	type DvCallRecorder,
	type DvCallRecorderOptions,
	type DvRecorderFs,
	type DvRecorderSettings,
	type DvRecordingFinalized,
} from "../../../../src/core/dv-recorder/recorder.js"

export const logger = pino({ level: "silent" })
export const GIB = 1024 * 1024 * 1024
export const MIB = 1024 * 1024
/** 2023-11-14T22:13:20Z: a fixed synthetic start time. */
export const T0 = 1_700_000_000_000

export class FakeTapSource implements DvCallTapSource {
	tap: DvCallTap | null = null
	addCallTap(tap: DvCallTap): () => void {
		this.tap = tap
		return () => {
			this.tap = null
		}
	}
	get t(): DvCallTap {
		if (this.tap === null) throw new Error("no tap")
		return this.tap
	}
}

export interface CallOpts {
	decoderId?: string
	callId?: string
	slot?: 1 | 2 | null
	state?: DvTapCallState
	startedAtMs?: number
	/** The tap's protocol label; P25 unless set (DMR calls are not recorded yet). */
	protocol?: string | null
}

/** Drives one call through the fake tap, counting delivered samples as the service does. */
export class FakeCall {
	readonly decoderId: string
	readonly callId: string
	readonly slot: 1 | 2 | null
	delivered = 0
	lost = 0
	constructor(
		private readonly src: FakeTapSource,
		opts: CallOpts = {},
	) {
		this.decoderId = opts.decoderId ?? "dsd-fme"
		this.callId = opts.callId ?? "dsd-fme-c1-1"
		this.slot = opts.slot === undefined ? null : opts.slot
		src.t.start({
			decoderId: this.decoderId,
			callId: this.callId,
			slot: this.slot,
			channelKind: "main",
			probeId: null,
			channelHz: null,
			protocol: opts.protocol === undefined ? "P25" : opts.protocol,
			state: opts.state ?? "clear",
			startedAtMs: opts.startedAtMs ?? T0,
		})
	}
	private ref() {
		return { decoderId: this.decoderId, callId: this.callId, slot: this.slot }
	}
	state(state: DvTapCallState, heldSamples = 0): void {
		this.src.t.state({ ...this.ref(), state, heldSamples })
	}
	/** One block of `samples` samples, all equal to `value` (or the given array). */
	pcm(samples: number | Int16Array, value = 1000, held = false): void {
		const pcm =
			typeof samples === "number"
				? new Int16Array(samples).fill(value)
				: samples
		this.src.t.pcm({
			...this.ref(),
			pcm,
			firstSample: this.delivered,
			atMs: T0 + this.delivered / 8,
			held,
		})
		this.delivered += pcm.length
	}
	/** `ms` of voice in 200 ms blocks (1 600 samples), the last block shorter. */
	voice(ms: number, value = 1000, held = false): void {
		let left = ms * 8
		while (left > 0) {
			const n = Math.min(1600, left)
			this.pcm(n, value, held)
			left -= n
		}
	}
	drop(lostSamples: number): void {
		this.lost += lostSamples
		this.src.t.drop({
			...this.ref(),
			lostSamples,
			beforeSample: this.delivered,
		})
	}
	end(
		reason: DvTapEndReason = "end",
		finalState: DvTapCallState = "clear",
	): void {
		const e: DvTapCallEnd = {
			...this.ref(),
			reason,
			finalState,
			deliveredSamples: this.delivered,
			lostSamples: this.lost,
			discardedHeldSamples: 0,
			endedAtMs: T0 + 60_000,
		}
		this.src.t.end(e)
	}
}

/** The node fs with a fixed statfs figure (10 GiB free unless set). */
export function fsWithFree(
	freeBytes: () => number,
	base: DvRecorderFs = nodeDvRecorderFs,
): DvRecorderFs {
	return {
		...base,
		statfs: () => Promise.resolve({ bavail: freeBytes() / 4096, bsize: 4096 }),
	}
}

export interface Harness {
	dir: string
	src: FakeTapSource
	rec: DvCallRecorder
	finalized: DvRecordingFinalized[]
	settings: DvRecorderSettings
}

/** A deterministic stand-in for Math.random: 0.000 37, 0.137 37, 0.274 37, ... (mod 1). */
export function sequence(step = 0.137): () => number {
	let i = 0
	return () => (i++ * step + 0.00037) % 1
}

const roots: string[] = []

export async function tmpRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "wk-dvrec-"))
	roots.push(root)
	return root
}

export async function cleanupRoots(): Promise<void> {
	await Promise.all(
		roots.splice(0).map(r => rm(r, { recursive: true, force: true })),
	)
}

export async function harness(
	over: Partial<DvRecorderSettings> = {},
	opts: Partial<Omit<DvCallRecorderOptions, "settings" | "source">> = {},
	startIt = true,
): Promise<Harness> {
	const root = await tmpRoot()
	const settings: DvRecorderSettings = {
		enabled: true,
		dir: join(root, "recordings", "dv-calls"),
		minVoiceMs: 1000,
		maxCallMs: 300_000,
		retentionBytes: 2 * GIB,
		retentionDays: 7,
		...over,
	}
	const src = new FakeTapSource()
	const finalized: DvRecordingFinalized[] = []
	const rec = createDvCallRecorder({
		settings,
		source: src,
		logger,
		fs: fsWithFree(() => 10 * GIB),
		random: sequence(),
		onFinalized: r => finalized.push(r),
		// The core installs the protection port before the recorder; the wiring-safety tests
		// override this.
		protectionInstalled: () => true,
		...opts,
	})
	if (startIt) await rec.start()
	return { dir: settings.dir, src, rec, finalized, settings }
}
