// What is decoded on the tuned frequency: decoders whose configured targets sit in the tuned channel.
import type { DecoderInfo } from "@wavekit/api-types"
import type { DataLayer } from "../../data/index.ts"
import { errorMessage, Store } from "../../data/index.ts"
import { fixedTargetsHz } from "./decoder-protocols.ts"

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

/** A decoder's fixed channel targets: its band assessment's, else its configured ones that do not follow the tuner. */
function channelTargetsHz(d: DecoderInfo): number[] {
	const band = d.bandAssessment?.targetsHz
	return Array.isArray(band) && band.length > 0 ? band : fixedTargetsHz(d)
}

/**
 * Half the width of the signal a wideband decoder reads around its target, when wider than a channel: ADS-B fills
 * the core's ADS-B window, 1090 MHz ±1 MHz, so anywhere readsb covers is its channel.
 */
const SIGNAL_HALF_WIDTH_HZ: Readonly<Record<string, number>> = {
	readsb: 1_000_000,
}

/**
 * Of the decoders whose band holds the frequency (`here`, decodersHere), those that decode the tuned channel itself:
 * a fixed target within `toleranceHz`, or within a wideband decoder's signal (decodersAt), in `here`'s order. A band
 * that merely spans the frequency is not enough: an FM carrier at 434.000 MHz inside rtl433's 433 MHz band is not on
 * its 433.920 MHz channel.
 */
export function decodersOnChannel(
	here: readonly DecoderInfo[],
	hz: number,
	toleranceHz: number,
): DecoderInfo[] {
	return here.filter(
		d =>
			decodersAt(
				[{ ...d, targetFrequenciesHz: channelTargetsHz(d) }],
				hz,
				Math.max(
					toleranceHz,
					Object.hasOwn(SIGNAL_HALF_WIDTH_HZ, d.type)
						? SIGNAL_HALF_WIDTH_HZ[d.type]!
						: 0,
				),
			).length > 0,
	)
}

/**
 * The decoders whose band holds the tuned frequency (`ids`, the core's `coversHz`: band-table.ts coveringIds),
 * nearest target first. A decoder whose channel only follows the tuner is not among them.
 */
export function decodersHere(
	decoders: readonly DecoderInfo[],
	ids: ReadonlySet<string>,
	hz: number,
): DecoderInfo[] {
	const dist = (d: DecoderInfo) =>
		Math.min(
			...(d.bandAssessment?.targetsHz ?? d.targetFrequenciesHz ?? []).map(f =>
				Math.abs(f - hz),
			),
		)
	return decoders
		.filter(d => ids.has(d.id))
		.sort((a, b) => dist(a) - dist(b) || a.id.localeCompare(b.id, "en"))
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
