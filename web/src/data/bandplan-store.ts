/** The resolved band plan (GET /api/bandplans/resolved) and the client-side band lookup. */
import type {
	BandChannel,
	ResolvedBand,
	ResolvedBandPlanView,
} from "@wavekit/api-types"
import type { ApiClient } from "./api-client.ts"
import { errorMessage } from "./api-client.ts"
import type { EventsClient } from "./events-client.ts"
import { Store } from "./store.ts"

export interface BandplanState {
	view: ResolvedBandPlanView | null
	loaded: boolean
	error: string | null
}

/** Every resolved band with a segment containing `hz`, narrowest first (then layer, then key). */
export function bandsAt(
	view: ResolvedBandPlanView | null,
	hz: number,
): ResolvedBand[] {
	if (!view) return []
	return view.bands
		.filter(b => b.segments.some(s => hz >= s.startHz && hz <= s.endHz))
		.sort((a, b) => {
			const width =
				a.band.endHz - a.band.startHz - (b.band.endHz - b.band.startHz)
			if (width !== 0) return width
			if (a.layer !== b.layer) return a.layer - b.layer
			return a.key < b.key ? -1 : a.key > b.key ? 1 : 0
		})
}

/** The band that names `hz`: the narrowest visible band whose uncovered segments contain it. */
export function bandAt(
	view: ResolvedBandPlanView | null,
	hz: number,
): ResolvedBand | null {
	return bandsAt(view, hz)[0] ?? null
}

/** The plan channel nearest `hz` within `toleranceHz` (default half the band's bandwidth, else 3 kHz). */
export function channelAt(
	band: ResolvedBand | null,
	hz: number,
	toleranceHz?: number,
): BandChannel | null {
	if (!band) return null
	const tolerance =
		toleranceHz ??
		(band.band.bandwidthHz !== null ? band.band.bandwidthHz / 2 : 3000)
	let best: BandChannel | null = null
	for (const channel of band.band.channels) {
		const d = Math.abs(channel.frequencyHz - hz)
		if (d <= tolerance && (!best || d < Math.abs(best.frequencyHz - hz)))
			best = channel
	}
	return best
}

export class BandplanStore extends Store<BandplanState> {
	private readonly api: ApiClient
	private readonly cleanup: (() => void)[]
	private inflight: Promise<void> | null = null

	constructor(api: ApiClient, events: EventsClient) {
		super({ view: null, loaded: false, error: null })
		this.api = api
		this.cleanup = [
			events.subscribe(["bandplans"]),
			events.on("bandplans:changed", ({ storeId, revision }) => {
				const store = this.get().view?.store
				if (
					store?.state === "available" &&
					store.storeId === storeId &&
					store.revision >= revision
				)
					return
				void this.load()
			}),
			events.onReconnected(() => void this.load()),
		]
	}

	bandAt(hz: number): ResolvedBand | null {
		return bandAt(this.get().view, hz)
	}

	/** Never rejects: a failure lands in `error`. Concurrent calls share one request. */
	load(): Promise<void> {
		this.inflight ??= this.fetch().finally(() => {
			this.inflight = null
		})
		return this.inflight
	}

	private async fetch(): Promise<void> {
		try {
			const view = await this.api.get<ResolvedBandPlanView>(
				"/api/bandplans/resolved",
			)
			this.set({ view, loaded: true, error: null })
		} catch (error) {
			this.update(s => ({ ...s, error: errorMessage(error) }))
		}
	}

	dispose(): void {
		for (const fn of this.cleanup.splice(0)) fn()
	}
}
