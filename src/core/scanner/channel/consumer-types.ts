import type { DecoderConfig } from "../../../decoders/types.js"
import type { DecoderChannelRequest } from "../../channelizer/types.js"
import type {
	ChannelSettlementObserver,
	DownstreamEnvelopes,
	ObservedPermitLedger,
	ProviderLifetime,
	ResourceEnvelope,
} from "../../channelizer/settlement-observer.js"
import type { ScannerLifecycleOwner } from "./consumer-lifecycle.js"

export interface ScannerChannelTier {
	readonly enabled: boolean
	readonly minMs: number
}

/** Explicit private profile coverage; absent coverage is never a zero cost. */
export interface ScannerChannelShapeProfile {
	readonly captureRateHz: number
	readonly bandwidthHz: number
	readonly transitionHz: number
	readonly outputRateHz: number
	readonly format: "cu8" | "cf32"
	readonly nativeSend: ResourceEnvelope
	readonly process: ResourceEnvelope
	readonly downstream: DownstreamEnvelopes
}

export interface ScannerChannelProfile {
	readonly limits: ResourceEnvelope
	readonly baseline: ResourceEnvelope
	readonly baselineEngineCount: number
	readonly baselineOffsetCount: number
	readonly shapes: readonly ScannerChannelShapeProfile[]
}

export interface ScannerChannelOwnership {
	readonly observer: ChannelSettlementObserver
	readonly lifetime: ProviderLifetime
	/** Missing measured profile/ledger denies before an arm or effect. */
	readonly ledger?: ObservedPermitLedger
	readonly construction: ScannerLifecycleOwner
}

export interface ScannerChannelAttempt {
	readonly identity: object
	readonly sourceId: string
	readonly decoderId: string
	readonly engine: object
	readonly engineInstanceId: string
	readonly stream: number
	readonly epoch: number
	readonly captureRateHz: number
	readonly captureCentreHz: number
	readonly targetHz: number
	readonly tuningTrust: "commanded" | "relay" | "unverified"
	readonly gainKey: string
}

export interface ObservedDecoderEligibilityInput {
	readonly config: Readonly<DecoderConfig>
	readonly expectedRequest: Readonly<DecoderChannelRequest>
	readonly expectedInputCaps: Readonly<{
		kind: "iq"
		format: "U8_IQ"
		sampleRate: number
		centerFreq: number
	}>
	readonly scannerAttempt: object
}

/** Composition-only; production initial scope supplies no decoder capability. */
export type ObservedDecoderEligibility = (
	input: Readonly<ObservedDecoderEligibilityInput>,
) => boolean
