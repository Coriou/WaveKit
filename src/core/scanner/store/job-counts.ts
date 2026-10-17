/**
 * WG11 req 3.3 (lane SC): per-job discovery counts by confidence, maintained incrementally. A
 * discovery counts once for every distinct job id in its `jobIds` (as `list({ jobId })` matches).
 */
import type { ScannerConfidence } from "../types.js"

export type ConfidenceCounts = Record<ScannerConfidence, number>

const zero = (): ConfidenceCounts => ({
	activity: 0,
	candidate: 0,
	classified: 0,
	decoded: 0,
})

interface Counted {
	confidence: ScannerConfidence
	jobs: string[]
}

export class JobCounts {
	private readonly byJob = new Map<string, ConfidenceCounts>()
	private readonly counted = new Map<string, Counted>()

	/** Brings one discovery's contribution up to date (`undefined`: it left the store). */
	sync(
		id: string,
		current:
			| { confidence: ScannerConfidence; jobIds: readonly string[] }
			| undefined,
	): void {
		const prev = this.counted.get(id)
		if (
			prev !== undefined &&
			current !== undefined &&
			prev.confidence === current.confidence &&
			sameJobs(prev.jobs, current.jobIds)
		)
			return
		if (prev !== undefined) {
			for (const job of prev.jobs) {
				const c = this.byJob.get(job)
				if (c === undefined) continue
				c[prev.confidence] -= 1
				if (
					c.activity === 0 &&
					c.candidate === 0 &&
					c.classified === 0 &&
					c.decoded === 0
				)
					this.byJob.delete(job)
			}
			this.counted.delete(id)
		}
		if (current === undefined) return
		const jobs = [...new Set(current.jobIds)]
		for (const job of jobs) {
			let c = this.byJob.get(job)
			if (c === undefined) {
				c = zero()
				this.byJob.set(job, c)
			}
			c[current.confidence] += 1
		}
		this.counted.set(id, { confidence: current.confidence, jobs })
	}

	/** A copy; zeros for a job no discovery carries. */
	get(jobId: string): ConfidenceCounts {
		const c = this.byJob.get(jobId)
		return c === undefined ? zero() : { ...c }
	}

	/** Jobs with a non-zero count (bound check: never more than the discoveries' distinct jobs). */
	jobs(): number {
		return this.byJob.size
	}

	clear(): void {
		this.byJob.clear()
		this.counted.clear()
	}
}

/** `prev` is deduplicated; `next` may repeat (a replayed record), so compare as sets. */
function sameJobs(prev: readonly string[], next: readonly string[]): boolean {
	if (prev.length === next.length) {
		for (let i = 0; i < prev.length; i++) if (prev[i] !== next[i]) return false
		return true
	}
	if (next.length < prev.length) return false
	const set = new Set(next)
	if (set.size !== prev.length) return false
	for (const j of prev) if (!set.has(j)) return false
	return true
}
