// The core's decoder verdicts (GET /api/decoders/summary) for the tuned card's "On this band". The summary is not
// pushed, so it is read on attach, shortly after any `decoder:*` event, after a reconnect, and every POLL_MS while
// attached. A core without the route (404) or without verdicts leaves `verdicts` null: the card reads statuses only.
import type { DataLayer } from "../../data/index.ts"
import { ApiError, Store } from "../../data/index.ts"
import { verdictsById, type BandVerdict } from "./band-decoders.ts"

export const VERDICTS_POLL_MS = 15_000
/** Statuses arrive in bursts on a retune: one read after they settle. */
export const VERDICTS_SETTLE_MS = 400

export interface VerdictsState {
	verdicts: ReadonlyMap<string, BandVerdict> | null
}

export class DecoderVerdictsFeed extends Store<VerdictsState> {
	private readonly data: Pick<DataLayer, "api" | "events">
	private attached = 0
	private cleanup: (() => void)[] = []
	private settle: ReturnType<typeof setTimeout> | null = null
	private poll: ReturnType<typeof setInterval> | null = null
	private unavailable = false
	private seq = 0

	constructor(data: Pick<DataLayer, "api" | "events">) {
		super({ verdicts: null })
		this.data = data
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

	/** Never rejects; a failed read keeps the last verdicts. */
	async load(): Promise<void> {
		if (this.unavailable) return
		const seq = ++this.seq
		try {
			const body = await this.data.api.get<unknown>("/api/decoders/summary")
			if (seq !== this.seq) return
			const verdicts = verdictsById(body)
			this.set({ verdicts: verdicts.size > 0 ? verdicts : null })
		} catch (error) {
			// a core older than the summary route: statuses only, never asked again
			if (error instanceof ApiError && error.status === 404) {
				this.unavailable = true
				this.set({ verdicts: null })
			}
		}
	}

	private stop(): void {
		for (const fn of this.cleanup.splice(0)) fn()
		if (this.settle !== null) clearTimeout(this.settle)
		if (this.poll !== null) clearInterval(this.poll)
		this.settle = null
		this.poll = null
		this.seq += 1
	}

	dispose(): void {
		this.attached = 0
		this.stop()
	}
}
