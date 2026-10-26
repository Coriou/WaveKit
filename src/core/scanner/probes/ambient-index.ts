import { CentreIndex } from "../store/frequency-index.js"
import type { ChannelCandidate } from "./ambient-channel.js"

/** Updated on track changes, never rebuilt on a decode. The sorted centre index gives
 * O(log n + k) reads for the k observations in a source frequency window. Track updates
 * pay sorted-array insertion/removal; ended observations remain until the pairing retention
 * expires. References preserve current discovery IDs after merges. */
export class AmbientObservationIndex<T extends ChannelCandidate> {
	private readonly centres = new CentreIndex()
	private readonly entries = new Map<
		string,
		{ observation: T; hz: number; sourceId: string }
	>()
	/** Largest measured half width; a conservative query envelope, never an attachment rule. */
	private halfWidth = 0

	upsert(observation: T): void {
		this.remove(observation.observationId)
		const hz = observation.lastTrack?.centreHz
		if (hz === undefined || !Number.isFinite(hz)) return
		this.entries.set(observation.observationId, {
			observation,
			hz,
			sourceId: observation.sourceId,
		})
		this.centres.add(
			observation.sourceId,
			"ambient",
			hz,
			observation.observationId,
		)
		const width = observation.lastTrack?.obwHz ?? 0
		if (Number.isFinite(width))
			this.halfWidth = Math.max(this.halfWidth, width / 2)
	}

	remove(id: string): void {
		const entry = this.entries.get(id)
		if (!entry) return
		this.centres.remove(entry.sourceId, "ambient", entry.hz, id)
		this.entries.delete(id)
		if (this.entries.size === 0) this.halfWidth = 0
	}

	window(
		sourceId: string,
		hz: number,
		reachHz: number,
		includeSpan = false,
	): T[] {
		const radius = includeSpan ? Math.max(reachHz, this.halfWidth) : reachHz
		const result: T[] = []
		this.centres.range(sourceId, "ambient", hz - radius, hz + radius, entry => {
			const observation = this.entries.get(entry.id)?.observation
			if (observation) result.push(observation)
		})
		return result
	}
}

/** A live map indexes every insertion, including restored/injected observations. */
export class AmbientObservationMap<T extends ChannelCandidate> extends Map<
	string,
	T
> {
	constructor(private readonly index: AmbientObservationIndex<T>) {
		super()
	}

	override set(key: string, value: T): this {
		const previous = this.get(key)
		if (previous) this.index.remove(previous.observationId)
		super.set(key, value)
		this.index.upsert(value)
		return this
	}

	override delete(key: string): boolean {
		const previous = this.get(key)
		if (previous) this.index.remove(previous.observationId)
		return super.delete(key)
	}

	override clear(): void {
		for (const value of this.values()) this.index.remove(value.observationId)
		super.clear()
	}
}
