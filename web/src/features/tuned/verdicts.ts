// The core's decoder verdicts (GET /api/decoders/summary?hz=) for the tuned card's header and "On this band". The
// summary is not pushed, so it is read on attach, when the card's frequency changes, shortly after any `decoder:*`
// event, after a reconnect, and every POLL_MS while attached. A core without the route (404) or without verdicts
// leaves `verdicts` and `items` null: the card reads statuses only. Any other failed read (a 5xx, 401/403, a
// timeout, the network) for a frequency with no answer yet reads statuses for it too, until a read succeeds.
import type { DataLayer } from "../../data/index.ts"
import { ApiError, Store } from "../../data/index.ts"
import { verdictsById, type BandVerdict } from "./band-decoders.ts"
import { parseSummary, summaryPath, type SummaryItem } from "./band-table.ts"

export const VERDICTS_POLL_MS = 15_000
/** Statuses arrive in bursts on a retune: one read after they settle. */
export const VERDICTS_SETTLE_MS = 400
/** A new frequency is read once the card has rested on it this long: a sweep of the dial asks once, not per step. */
export const VERDICTS_FOLLOW_MS = 150

export interface VerdictsState {
	verdicts: ReadonlyMap<string, BandVerdict> | null
	/** The summary's items as last read for `hz`; null before the first read or from a core without verdicts. */
	items: readonly SummaryItem[] | null
	/** The frequency `items` answer for (their `coversHz`); null when asked without one. */
	hz: number | null
	/** The core has no summary (404) or sent no verdicts: read statuses instead. */
	legacy: boolean
	/** The last read for `hz` failed with nothing read for it before: statuses stand in until one succeeds. */
	failed: boolean
}

/**
 * The items for `hz`: the read for that frequency; null when the core has no summary (statuses only); empty
 * while the read for a new frequency is on its way, so a stale answer never lists another frequency's decoders.
 */
export function itemsFor(
	s: VerdictsState,
	hz: number,
): readonly SummaryItem[] | null {
	if (s.legacy || (s.failed && s.hz === hz)) return null
	return s.hz === hz && s.items !== null ? s.items : []
}

/** Whether the answer for `hz` is still on its way (nothing is claimed about its decoders yet). */
export function pendingFor(s: VerdictsState, hz: number): boolean {
	return !s.legacy && s.hz !== hz
}

export class DecoderVerdictsFeed extends Store<VerdictsState> {
	private readonly data: Pick<DataLayer, "api" | "events">
	private attached = 0
	private cleanup: (() => void)[] = []
	private settle: ReturnType<typeof setTimeout> | null = null
	private following: ReturnType<typeof setTimeout> | null = null
	private poll: ReturnType<typeof setInterval> | null = null
	private unavailable = false
	private seq = 0
	private hz: number | null = null

	constructor(data: Pick<DataLayer, "api" | "events">) {
		super({
			verdicts: null,
			items: null,
			hz: null,
			legacy: false,
			failed: false,
		})
		this.data = data
	}

	/**
	 * Asks for the decoders covering `hz` from now on; while attached, a new frequency is read VERDICTS_FOLLOW_MS
	 * after the last change (each change restarts the wait). Until then the new frequency reads as pending.
	 */
	follow(hz: number | null): void {
		const next = hz !== null && Number.isFinite(hz) && hz > 0 ? hz : null
		if (next === this.hz) return
		this.hz = next
		if (this.attached === 0) return
		if (this.following !== null) clearTimeout(this.following)
		this.following = setTimeout(() => {
			this.following = null
			void this.load()
		}, VERDICTS_FOLLOW_MS)
	}

	/** Starts reading while someone shows verdicts; returns the detach. */
	attach(): () => void {
		this.attached += 1
		if (this.attached === 1) {
			const { events } = this.data
			const soon = () => this.soon()
			this.cleanup = [
				events.subscribe(["decoders"]),
				events.on("decoder:status", soon),
				events.on("decoder:created", soon),
				events.on("decoder:removed", soon),
				events.onReconnected(soon),
			]
			this.poll = setInterval(() => void this.load(), VERDICTS_POLL_MS)
			void this.load()
		}
		let done = false
		return () => {
			if (done) return
			done = true
			this.attached -= 1
			if (this.attached === 0) this.stop()
		}
	}

	/** Reads again after VERDICTS_SETTLE_MS (after an action, or a burst of statuses). */
	soon(): void {
		if (this.attached === 0 || this.settle !== null) return
		this.settle = setTimeout(() => {
			this.settle = null
			void this.load()
		}, VERDICTS_SETTLE_MS)
	}

	/**
	 * Never rejects. A failed read keeps the last verdicts for the same frequency; for a frequency with no
	 * answer yet it records the frequency as failed, so the card reads statuses instead of waiting forever.
	 */
	async load(): Promise<void> {
		if (this.unavailable) return
		const seq = ++this.seq
		const hz = this.hz
		try {
			const body = await this.data.api.get<unknown>(summaryPath(hz))
			if (seq !== this.seq) return
			const verdicts = verdictsById(body)
			const items = verdicts.size > 0 ? parseSummary(body) : null
			this.set({
				verdicts: verdicts.size > 0 ? verdicts : null,
				items,
				hz,
				legacy: items === null,
				failed: false,
			})
		} catch (error) {
			if (seq !== this.seq) return
			// a core older than the summary route: statuses only, never asked again
			if (error instanceof ApiError && error.status === 404) {
				this.unavailable = true
				this.set({
					verdicts: null,
					items: null,
					hz,
					legacy: true,
					failed: false,
				})
				return
			}
			// the last answer for this frequency still stands; a new frequency reads statuses until a read succeeds
			const s = this.get()
			if (s.hz === hz && s.items !== null && !s.failed) return
			this.set({ verdicts: null, items: null, hz, legacy: false, failed: true })
		}
	}

	private stop(): void {
		for (const fn of this.cleanup.splice(0)) fn()
		if (this.settle !== null) clearTimeout(this.settle)
		if (this.following !== null) clearTimeout(this.following)
		if (this.poll !== null) clearInterval(this.poll)
		this.settle = null
		this.following = null
		this.poll = null
		this.seq += 1
	}

	dispose(): void {
		this.attached = 0
		this.stop()
	}
}
