import type { DecoderChannelRequest } from "../../channelizer/types.js"
import type {
	ObservedAcquisitionHandle,
	ObservedPermitLedger,
	PreparedObservedPermit,
	ResourceEnvelope,
} from "../../channelizer/settlement-observer.js"
import type { ScannerChannelProfile } from "../channel/consumer-types.js"

function validEnvelope(value: ResourceEnvelope): boolean {
	return (
		Number.isFinite(value.cpu) &&
		value.cpu >= 0 &&
		Number.isSafeInteger(value.bytes) &&
		value.bytes >= 0
	)
}

/** Prepares immutable, UNCHARGED cells. The core atomically admits at dequeue. */
export function prepareChannelAdmission(input: {
	readonly handle: ObservedAcquisitionHandle
	readonly ledger: ObservedPermitLedger | undefined
	readonly profile: ScannerChannelProfile | null | undefined
	readonly captureRateHz: number
	readonly request: Readonly<DecoderChannelRequest>
	readonly activation: "decoder" | "direct"
}): PreparedObservedPermit | undefined {
	const { ledger, profile, request } = input
	if (
		!ledger ||
		!profile ||
		!validEnvelope(profile.limits) ||
		!validEnvelope(profile.baseline) ||
		!Number.isFinite(input.captureRateHz)
	)
		return undefined
	const coverage = profile.shapes.filter(
		shape =>
			shape.captureRateHz === input.captureRateHz &&
			shape.bandwidthHz === request.bandwidthHz &&
			shape.transitionHz === request.transitionHz &&
			shape.outputRateHz === request.outputRateHz &&
			shape.format === request.format,
	)
	if (coverage.length !== 1) return undefined
	const shape = coverage[0]!
	if (
		![
			shape.nativeSend,
			shape.process,
			shape.downstream.decoder,
			shape.downstream.classifier,
			shape.downstream.analog,
		].every(validEnvelope)
	)
		return undefined
	// Direct D=0 is accepted only when this exact reviewed shape explicitly covers it.
	if (
		input.activation === "direct" &&
		(shape.downstream.decoder.cpu !== 0 || shape.downstream.decoder.bytes !== 0)
	)
		return undefined
	return ledger.prepareObservedPermit(
		input.handle.requestToken,
		Array.from({ length: 6 }, () => Object.freeze({ ...shape.nativeSend })),
		Array.from({ length: 6 }, () => Object.freeze({ ...shape.process })),
		Object.freeze({
			decoder: Object.freeze({ ...shape.downstream.decoder }),
			classifier: Object.freeze({ ...shape.downstream.classifier }),
			analog: Object.freeze({ ...shape.downstream.analog }),
		}),
	)
}

/** One shared CURRENT baseline; preserves retained charges on an overlimit update. */
export function updateChannelAdmission(
	ledger: ObservedPermitLedger,
	expectedVersion: number,
	baseline: ResourceEnvelope,
	limits: ResourceEnvelope,
): boolean {
	if (!validEnvelope(baseline) || !validEnvelope(limits)) return false
	return ledger.updateAdmission(expectedVersion, baseline, limits)
}
