// What is decoded on the tuned frequency: decoders whose configured targets sit in the tuned channel.
import type { DecoderInfo } from "@wavekit/api-types"
import type { DataLayer } from "../../data/index.ts"
import { errorMessage, Store } from "../../data/index.ts"

/** Running or wanted decoders with a target within `toleranceHz` of `hz`, nearest first. */
export function decodersAt(
	decoders: readonly DecoderInfo[],
	hz: number,
	toleranceHz: number,
): DecoderInfo[] {
	const dist = (d: DecoderInfo) =>
		Math.min(...(d.targetFrequenciesHz ?? []).map(f => Math.abs(f - hz)))
	return decoders
		.filter(d => dist(d) <= toleranceHz)
		.sort((a, b) => dist(a) - dist(b))
}

export interface DecodersState {
	decoders: readonly DecoderInfo[]
	loaded: boolean
	error: string | null
}

/** GET /api/decoders, kept fresh by `decoder:*` events on the `decoders` channel. */
export class DecodersFeed extends Store<DecodersState> {
	private readonly data: Pick<DataLayer, "api" | "events">
	private readonly cleanup: (() => void)[]

	constructor(data: Pick<DataLayer, "api" | "events">) {
		super({ decoders: [], loaded: false, error: null })
		this.data = data
		const { events } = data
		this.cleanup = [
			events.subscribe(["decoders"]),
			events.on("decoder:status", status =>
				this.update(s => ({
					...s,
					decoders: s.decoders.map(d =>
						d.id === status.id ? { ...d, ...status } : d,
					),
				})),
			),
			events.on("decoder:created", () => void this.load()),
			events.on("decoder:removed", () => void this.load()),
			events.onReconnected(() => void this.load()),
		]
	}

	/** Never rejects. */
	async load(): Promise<void> {
		try {
			const decoders = await this.data.api.get<DecoderInfo[]>("/api/decoders")
			this.set({ decoders, loaded: true, error: null })
		} catch (error) {
			this.update(s => ({ ...s, error: errorMessage(error) }))
		}
	}

	dispose(): void {
		for (const fn of this.cleanup.splice(0)) fn()
	}
}
