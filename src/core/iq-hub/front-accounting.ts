/**
 * Pure accounting of one hub front (one attempt's stream as Node reads it): where it started, the
 * whole-frame skips the hub reported (start and lag gaps), the end counts, and the byte identity
 * (I-S3) `U = N + G + D + K`: the stream's whole-frame payload from `startSourcePos` (U) is what
 * Node counted (N), the gaps (G), the tail discarded at a front EOF (D) and what the hub sent but
 * Node abandoned at its own close (K = sinkBytes - N).
 */
import type { HubEventOf, HubSinkGap } from "./protocol.js"

/** Gaps kept in detail per front (totals cover every gap). */
export const FRONT_GAPS_KEPT = 64

export interface FrontGap {
	atSinkByte: number
	atSourcePos: number
	droppedBytes: number
	cause: HubSinkGap["cause"]
}

export interface FrontEnd {
	sinkBytes: number
	headerSent: number
	droppedBytes: number
	discardedBytes: number
	reason: HubEventOf<"front-ended">["reason"]
}

export interface FrontCheck {
	/** U: whole-frame payload of the stream as the caller measured it independently. */
	upstream: number
	/** N: payload bytes Node counted (its header excluded). */
	node: number
	/** G: bytes the hub skipped for this front. */
	gaps: number
	/** D: bytes the front's EOF cut off. */
	discarded: number
	/** K: bytes the hub sent that Node abandoned at its close. */
	abandoned: number
	holds: boolean
}

export class FrontAccounting {
	startSourcePos: number | null = null
	gapCount = 0
	droppedBytes = 0
	readonly gaps: FrontGap[] = []
	end: FrontEnd | null = null

	noteStarted(startSourcePos: number): void {
		if (this.startSourcePos === null) this.startSourcePos = startSourcePos
	}

	noteGap(gap: FrontGap): void {
		this.gapCount += 1
		this.droppedBytes += gap.droppedBytes
		if (this.gaps.length >= FRONT_GAPS_KEPT) this.gaps.shift()
		this.gaps.push({ ...gap })
	}

	noteEnded(end: FrontEnd): void {
		this.end = { ...end }
	}

	/**
	 * The sink byte that carries `sourcePos`, from the start and the gaps kept: a position inside
	 * a gap maps to that gap's `atSinkByte`. Null before the start, before it, or when gaps were
	 * evicted from the detail list (the map is then unknown).
	 */
	sinkByteOf(sourcePos: number): number | null {
		if (this.startSourcePos === null || sourcePos < this.startSourcePos)
			return null
		if (this.gapCount !== this.gaps.length) return null
		let dropped = 0
		for (const gap of this.gaps) {
			if (sourcePos < gap.atSourcePos) break
			if (sourcePos < gap.atSourcePos + gap.droppedBytes) return gap.atSinkByte
			dropped += gap.droppedBytes
		}
		return sourcePos - this.startSourcePos - dropped
	}

	/** I-S3 at the front's end. Null before `front-ended`. */
	check(
		upstreamPayloadBytes: number,
		nodePayloadBytes: number,
	): FrontCheck | null {
		if (this.end === null) return null
		const abandoned = this.end.sinkBytes - nodePayloadBytes
		return {
			upstream: upstreamPayloadBytes,
			node: nodePayloadBytes,
			gaps: this.end.droppedBytes,
			discarded: this.end.discardedBytes,
			abandoned,
			holds:
				abandoned >= 0 &&
				this.end.droppedBytes === this.droppedBytes &&
				upstreamPayloadBytes ===
					nodePayloadBytes +
						this.end.droppedBytes +
						this.end.discardedBytes +
						abandoned,
		}
	}
}
