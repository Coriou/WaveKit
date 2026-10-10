import {
	dutyFromEnvelope,
	envelopeAcf,
	obwAtDb,
	spectralShape,
} from "./spectral-features.js"
import type {
	ObservationEndReason,
	PipelineEvent,
	TrackFlags,
	TrackSnapshot,
	TuningTrust,
} from "../types.js"
import type { Segment } from "./segmenter.js"

/**
 * Per-epoch emission tracks (spec §4.2, §6.2): matches each block's segments to open tracks by bin
 * overlap, keeps a 1 ms envelope (first 1 s) for the TDMA features, accumulates the mean PSD for
 * OBW and shape, and closes tracks after a hang, on a new epoch, on a long gap or at maxTrackMs.
 */
export interface TrackerOptions {
	sourceId: string
	binHz: number
	blockMs: number
	hangBlocks: number
	maxTracks: number
	maxTrackBlocks: number
	idPrefix: string
}

export interface TrackerBlock {
	endSample: number
	powerDb: Float32Array
	floorDb: Float32Array
	blockFloorDb: number
	thresholdDb: number
	gap: boolean
	overload: boolean
	/** Segments of this block that are short-path bursts (spec § 4.10). */
	burstSegments?: ReadonlySet<Segment>
}

interface EpochInfo {
	stream: number
	epoch: number
	centreHz: number
	tuningTrust: TuningTrust
}

const ENV_MAX_MS = 1000
const ACF_MIN_MS = 300
const SPEC_PAD_BINS = 2
const OBW_MIN_SNR_DB = 20
const MATCH_TOLERANCE_BINS = 1
const FIRST_UPDATE_BLOCKS = 2

class SpectrumAccumulator {
	lo = 0
	hi = 0
	private sum = new Float64Array(0)
	private count = new Uint32Array(0)

	add(powerDb: Float32Array, lo: number, hi: number): void {
		if (this.hi === this.lo) {
			this.lo = lo
			this.hi = hi
			this.sum = new Float64Array(hi - lo)
			this.count = new Uint32Array(hi - lo)
		} else if (lo < this.lo || hi > this.hi) {
			const nlo = Math.min(lo, this.lo)
			const nhi = Math.max(hi, this.hi)
			const sum = new Float64Array(nhi - nlo)
			const count = new Uint32Array(nhi - nlo)
			sum.set(this.sum, this.lo - nlo)
			count.set(this.count, this.lo - nlo)
			this.lo = nlo
			this.hi = nhi
			this.sum = sum
			this.count = count
		}
		for (let i = lo; i < hi; i++) {
			const j = i - this.lo
			this.sum[j] = (this.sum[j] ?? 0) + 10 ** ((powerDb[i] ?? -200) / 10)
			this.count[j] = (this.count[j] ?? 0) + 1
		}
	}

	/** Mean PSD in dB over the window; index 0 is bin `lo`. */
	meanDb(): Float32Array {
		const out = new Float32Array(this.hi - this.lo)
		for (let j = 0; j < out.length; j++) {
			const c = this.count[j] ?? 0
			out[j] =
				c > 0 ? 10 * Math.log10(Math.max((this.sum[j] ?? 0) / c, 1e-20)) : -200
		}
		return out
	}
}

interface Features {
	acf30?: number
	acf60?: number
	duty: number | null
}

interface OpenTrack {
	id: string
	epoch: EpochInfo
	openedAtBlock: number
	lastOnBlock: number
	startSample: number
	lastSample: number
	startBin: number
	endBin: number
	lastSeg: Segment
	onMin: number
	onMax: number
	maxWidthBins: number
	blocks: number
	misses: number
	peakDbfs: number
	maxBlockSnrDb: number
	bandLinSum: number
	floorLinSum: number
	floorDbSum: number
	centroidNum: number
	centroidDen: number
	thresholdDb: number
	spectrum: SpectrumAccumulator
	env: Float32Array
	envLen: number
	envOrigin: number
	envBucket: number
	envSum: number
	envFrames: number
	frozen: Features | null
	flags: TrackFlags
	flagsChanged: boolean
	justOpened: boolean
}

export class Tracker {
	private open: OpenTrack[] = []
	private seq = 0
	private blockNo = 0
	private n = 0 // fft size, learned from the first frame or block
	private epoch: EpochInfo = {
		stream: 0,
		epoch: 0,
		centreHz: 0,
		tuningTrust: "unverified",
	}
	private readonly updateEvery: number

	constructor(private readonly opts: TrackerOptions) {
		this.updateEvery = Math.max(1, Math.round(1000 / opts.blockMs))
	}

	get openCount(): number {
		return this.open.length
	}

	beginEpoch(e: {
		stream: number
		epoch: number
		centreHz: number
		tuningTrust: TuningTrust
	}): PipelineEvent[] {
		const events = this.closeAll("retune")
		this.epoch = { ...e }
		return events
	}

	frame(framePowerDb: Float32Array, sample: number): void {
		this.n = framePowerDb.length
		const samplesPerMs = (this.opts.binHz * framePowerDb.length) / 1000
		for (const t of this.open) {
			if (t.frozen) continue
			let sum = 0
			for (let i = t.startBin; i < t.endBin; i++)
				sum += 10 ** ((framePowerDb[i] ?? -200) / 10)
			if (t.envOrigin < 0) t.envOrigin = sample
			const bucket = Math.floor((sample - t.envOrigin) / samplesPerMs)
			if (bucket !== t.envBucket) this.flushEnvelope(t, bucket)
			if (t.frozen) continue
			t.envSum += sum
			t.envFrames++
		}
	}

	block(segments: Segment[], b: TrackerBlock): PipelineEvent[] {
		this.blockNo++
		this.n = b.floorDb.length
		const n = b.floorDb.length
		const blockSamples = Math.round(
			(this.opts.blockMs * this.opts.binHz * n) / 1000,
		)
		const events: PipelineEvent[] = []
		const matched = new Set<OpenTrack>()
		const order = segments
			.map((_, i) => i)
			.sort((x, y) => (segments[y]?.peakDb ?? 0) - (segments[x]?.peakDb ?? 0))
		for (const idx of order) {
			const s = segments[idx]
			if (s === undefined) continue
			const t = this.bestMatch(s, matched)
			if (t) {
				matched.add(t)
				this.extend(t, s, b, n)
				continue
			}
			if (b.gap) continue
			if (s.flags.truncated || this.open.length >= this.opts.maxTracks) {
				events.push({
					kind: "transient",
					centreHz: this.rf(s.centroidBin, n),
					epoch: this.epoch.epoch,
					sample: b.endSample - blockSamples,
				})
				continue
			}
			const nt = this.openTrack(s, b, n, blockSamples)
			matched.add(nt)
			events.push({ kind: "track-open", track: this.snapshot(nt, n) })
		}
		for (const t of [...this.open]) {
			if (matched.has(t)) continue
			t.misses++
			if (t.misses >= this.opts.hangBlocks)
				events.push(this.close(t, b.gap ? "gap" : "quiet", n))
		}
		for (const t of matched) {
			if (t.justOpened) {
				t.justOpened = false
				continue
			}
			if (this.blockNo - t.openedAtBlock + 1 >= this.opts.maxTrackBlocks) {
				const seg = t.lastSeg
				events.push(this.close(t, "max-duration", n))
				const nt = this.openTrack(seg, b, n, blockSamples)
				nt.justOpened = false
				events.push({ kind: "track-open", track: this.snapshot(nt, n) })
				continue
			}
			if (
				t.blocks === FIRST_UPDATE_BLOCKS ||
				t.blocks % this.updateEvery === 0 ||
				t.flagsChanged
			) {
				t.flagsChanged = false
				events.push({ kind: "track-update", track: this.snapshot(t, n) })
			}
		}
		return events
	}

	closeAll(reason: ObservationEndReason): PipelineEvent[] {
		const events: PipelineEvent[] = []
		for (const t of [...this.open]) events.push(this.close(t, reason, this.n))
		return events
	}

	/** Sets 1 on the current bins of open tracks with ≥ minBlocks on-blocks that were on in the last block. */
	trackBinsMask(out: Uint8Array, minBlocks: number): void {
		out.fill(0)
		for (const t of this.open) {
			if (t.blocks < minBlocks || t.misses > 0) continue
			for (let i = t.startBin; i < t.endBin; i++) out[i] = 1
		}
	}

	/**
	 * Raises the sticky `spur` flag (spec § 4.9, Task 7a) on open tracks whose current bins all lie on
	 * a spur line and returns their updates. Their segments are dropped from now on, so they close after the hang.
	 */
	flagSpurs(lineMask: Uint8Array): PipelineEvent[] {
		const events: PipelineEvent[] = []
		for (const t of this.open) {
			if (t.flags.spur || t.endBin <= t.startBin) continue
			let inside = true
			for (let i = t.startBin; i < t.endBin && inside; i++)
				inside = lineMask[i] === 1
			if (!inside) continue
			t.flags.spur = true
			events.push({ kind: "track-update", track: this.snapshot(t, this.n) })
		}
		return events
	}

	private bestMatch(
		s: Segment,
		taken: ReadonlySet<OpenTrack>,
	): OpenTrack | undefined {
		let best: OpenTrack | undefined
		let bestOverlap = 0
		for (const t of this.open) {
			if (taken.has(t)) continue
			const overlap =
				Math.min(s.endBin + MATCH_TOLERANCE_BINS, t.endBin) -
				Math.max(s.startBin - MATCH_TOLERANCE_BINS, t.startBin)
			if (overlap > bestOverlap) {
				bestOverlap = overlap
				best = t
			}
		}
		return best
	}

	private openTrack(
		s: Segment,
		b: TrackerBlock,
		n: number,
		blockSamples: number,
	): OpenTrack {
		const t: OpenTrack = {
			id: `${this.opts.idPrefix}${(++this.seq).toString(36)}`,
			epoch: { ...this.epoch },
			openedAtBlock: this.blockNo,
			lastOnBlock: this.blockNo,
			startSample: b.endSample - blockSamples,
			lastSample: b.endSample,
			startBin: s.startBin,
			endBin: s.endBin,
			lastSeg: s,
			onMin: s.startBin,
			onMax: s.endBin,
			maxWidthBins: 0,
			blocks: 0,
			misses: 0,
			peakDbfs: -Infinity,
			maxBlockSnrDb: -Infinity,
			bandLinSum: 0,
			floorLinSum: 0,
			floorDbSum: 0,
			centroidNum: 0,
			centroidDen: 0,
			thresholdDb: b.thresholdDb,
			spectrum: new SpectrumAccumulator(),
			env: new Float32Array(ENV_MAX_MS),
			envLen: 0,
			envOrigin: -1,
			envBucket: 0,
			envSum: 0,
			envFrames: 0,
			frozen: null,
			flags: {
				overload: false,
				gap: false,
				truncated: false,
				edge: false,
				skirt: false,
				obwBiased: false,
				spur: false,
				burst: false,
			},
			flagsChanged: false,
			justOpened: true,
		}
		this.open.push(t)
		this.extend(t, s, b, n)
		t.flagsChanged = false
		return t
	}

	private extend(t: OpenTrack, s: Segment, b: TrackerBlock, n: number): void {
		t.startBin = s.startBin
		t.endBin = s.endBin
		t.lastSeg = s
		t.blocks++
		t.misses = 0
		t.lastOnBlock = this.blockNo
		t.lastSample = b.endSample
		t.thresholdDb = b.thresholdDb
		let band = 0
		let floor = 0
		let maxSnr = -Infinity
		for (let i = s.startBin; i < s.endBin; i++) {
			const p = b.powerDb[i] ?? -200
			const f = b.floorDb[i] ?? -200
			band += 10 ** (p / 10)
			floor += 10 ** (f / 10)
			maxSnr = Math.max(maxSnr, p - f)
		}
		t.bandLinSum += band
		t.floorLinSum += floor
		t.floorDbSum += b.blockFloorDb
		t.peakDbfs = Math.max(t.peakDbfs, s.peakDb)
		t.maxBlockSnrDb = Math.max(t.maxBlockSnrDb, maxSnr)
		const weight = Math.max(band - floor, 1e-30)
		t.centroidNum += s.centroidBin * weight
		t.centroidDen += weight
		t.onMin = Math.min(t.onMin, s.startBin)
		t.onMax = Math.max(t.onMax, s.endBin)
		t.maxWidthBins = Math.max(t.maxWidthBins, s.endBin - s.startBin)
		t.spectrum.add(
			b.powerDb,
			Math.max(0, s.startBin - SPEC_PAD_BINS),
			Math.min(n, s.endBin + SPEC_PAD_BINS),
		)
		this.raise(t, "overload", b.overload)
		this.raise(t, "gap", b.gap)
		this.raise(t, "truncated", s.flags.truncated)
		this.raise(t, "edge", s.flags.edge)
		this.raise(t, "skirt", s.flags.skirt)
		// Burst is AND over the track's blocks: one continuous block makes it an ordinary track.
		const isBurst = b.burstSegments?.has(s) ?? false
		const wasBurst = t.flags.burst
		t.flags.burst = t.blocks === 1 ? isBurst : wasBurst && isBurst
		if (wasBurst && !t.flags.burst) t.flagsChanged = true
	}

	private raise(t: OpenTrack, flag: keyof TrackFlags, value: boolean): void {
		if (!value || t.flags[flag]) return
		t.flags[flag] = true
		t.flagsChanged = true
	}

	private flushEnvelope(t: OpenTrack, nextBucket: number): void {
		if (t.envFrames > 0) {
			const value = t.envSum / t.envFrames
			const until = Math.min(Math.max(nextBucket, t.envLen + 1), ENV_MAX_MS)
			for (let i = t.envLen; i < until; i++) t.env[i] = value
			t.envLen = until
			if (t.envLen >= ENV_MAX_MS) t.frozen = this.features(t)
		}
		t.envSum = 0
		t.envFrames = 0
		t.envBucket = nextBucket
	}

	private features(t: OpenTrack): Features {
		if (t.frozen) return t.frozen
		const env = t.env.subarray(0, t.envLen)
		const f: Features = { duty: dutyFromEnvelope(env) }
		if (t.envLen >= ACF_MIN_MS) {
			f.acf30 = envelopeAcf(env, 30)
			f.acf60 = envelopeAcf(env, 60)
		}
		return f
	}

	private rf(bin: number, n: number): number {
		return this.epoch.centreHz + (bin - n / 2) * this.opts.binHz
	}

	private close(
		t: OpenTrack,
		reason: ObservationEndReason,
		n: number,
	): PipelineEvent {
		this.open = this.open.filter(o => o !== t)
		return {
			kind: "track-close",
			track: this.snapshot(t, n),
			endReason: reason,
		}
	}

	private snapshot(t: OpenTrack, n: number): TrackSnapshot {
		const binHz = this.opts.binHz
		const centroid =
			t.centroidDen > 0
				? t.centroidNum / t.centroidDen
				: (t.startBin + t.endBin - 1) / 2
		const mean = t.spectrum.meanDb()
		const a = Math.max(0, t.onMin - 1 - t.spectrum.lo)
		const e = Math.min(mean.length, t.onMax + 1 - t.spectrum.lo)
		const useDb = t.maxBlockSnrDb >= OBW_MIN_SNR_DB
		const f = this.features(t)
		const blocks = Math.max(1, t.blocks)
		const bandMean = t.bandLinSum / blocks
		const floorMean = t.floorLinSum / blocks
		const snap: TrackSnapshot = {
			trackId: t.id,
			sourceId: this.opts.sourceId,
			stream: t.epoch.stream,
			epoch: t.epoch.epoch,
			startSample: t.startSample,
			lastSample: t.lastSample,
			centreHz: t.epoch.centreHz + (centroid - n / 2) * binHz,
			obwHz: useDb ? obwAtDb(mean, a, e, binHz, 20) : t.maxWidthBins * binHz,
			obwMethod: useDb ? "-20dB" : "on-bins",
			peakDbfs: t.peakDbfs,
			meanDbfs: 10 * Math.log10(Math.max(bandMean, 1e-30)),
			snrDb:
				10 *
				Math.log10(
					Math.max(bandMean - floorMean, 1e-30) / Math.max(floorMean, 1e-30),
				),
			floorDbfs: t.floorDbSum / blocks,
			thresholdDb: t.thresholdDb,
			blocks: t.blocks,
			maxBlockSnrDb: t.maxBlockSnrDb,
			dutyCycle:
				f.duty ?? t.blocks / Math.max(1, t.lastOnBlock - t.openedAtBlock + 1),
			spectralShape: spectralShape(mean, a, e, binHz),
			flags: { ...t.flags },
			tuningTrust: t.epoch.tuningTrust,
		}
		if (f.acf30 !== undefined) snap.acf30 = f.acf30
		if (f.acf60 !== undefined) snap.acf60 = f.acf60
		return snap
	}
}
