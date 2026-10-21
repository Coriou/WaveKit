import type {
	DecoderMode,
	TunerRatePolicy,
	LinkAdvisory,
} from "@wavekit/api-types"
import type { TunerWriteOptions } from "./tuner-controller.js"

export { READSB_SAMPLE_RATE } from "../decoders/builtin/readsb.js" // 2_400_000, do not redefine
export const READSB_REACH_HZ = 200_000
export const ADSB_FREQUENCY_HZ = 1_090_000_000
export const LINK_SUSTAINED_WINDOW_MS = 10_000
export const LINK_SHORTFALL_PERCENT = 1
export const LINK_UPSTREAM_DROPS_BYTES_PER_SECOND = 10_000 // same value as HIGH_DROP_RATE_THRESHOLD in resource-aggregator.ts
export interface ReadsbRateFacts {
	mode: DecoderMode
	ownDevice: boolean
}
export interface RatePolicyPort {
	readsbOn(sourceId: string): ReadsbRateFacts | null
} // null: no readsb instance for the source
export interface RatePolicy {
	beforeOperatorRetune(
		sourceId: string,
		hz: number,
		opts: TunerWriteOptions,
	): Promise<void>
	onOperatorSampleRate(sourceId: string): void // REST rate write, or an accepted relay rate write (A9)
	onRelayRetune(sourceId: string, hz: number): void // A9: advice only, never writes
	recordFor(sourceId: string): TunerRatePolicy | undefined
	reset(sourceId: string): void
	dispose(): void // cancels every post-raise link re-check timer (A11)
}
export interface LinkAdvisoryInput {
	sourceId: string
	host: string
	sampleRateHz: number
}
export interface LinkAdvisor {
	observe(
		sourceId: string,
		receivedBytesPerSecond: number | null,
		sampleRateHz: number | null,
		atMs: number,
	): void
	classify(
		input: LinkAdvisoryInput,
		upstreamDropBytesPerSecond: number | null,
	): LinkAdvisory
	reset(sourceId: string): void
}
