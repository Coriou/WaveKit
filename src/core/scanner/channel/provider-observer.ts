import type {
	ChannelProvider,
	DecoderChannelRequest,
} from "../../channelizer/types.js"
import type {
	ConsumerComponent,
	ObservedAcquisitionHandle,
} from "../../channelizer/settlement-observer.js"
import { prepareChannelAdmission } from "../plan/resource-admission.js"
import type {
	ScannerChannelAttempt,
	ScannerChannelOwnership,
	ScannerChannelProfile,
} from "./consumer-types.js"
import { GrantLifecycle } from "./grant-lifecycle.js"

export interface PreparedScannerChannel {
	readonly handle: ObservedAcquisitionHandle
	readonly classifier: ConsumerComponent
	readonly analog: ConsumerComponent
	readonly lifecycle: GrantLifecycle
	readonly request: Readonly<DecoderChannelRequest>
}

/** Uses the composition's SAME provider and registry; owns no native settlement authority. */
export function prepareDirectChannel(input: {
	readonly channels: ChannelProvider | null | undefined
	readonly ownership: ScannerChannelOwnership | undefined
	readonly profile: ScannerChannelProfile | null | undefined
	readonly attempt: ScannerChannelAttempt
	readonly request: DecoderChannelRequest
	readonly current: () => boolean
	readonly ended: () => void
}): PreparedScannerChannel | undefined {
	const { ownership, channels, attempt } = input
	// Default/missing profile denies BEFORE even bounded acquisition/arm metadata.
	if (
		!channels ||
		!ownership?.ledger ||
		!input.profile ||
		ownership.construction.admissionSealed ||
		!input.current()
	)
		return undefined
	const handle = ownership.observer.allocateAcquisition({
		activation: "direct",
		sourceId: attempt.sourceId,
		decoderId: attempt.decoderId,
		expectedRequest: Object.freeze({ ...input.request }),
		scannerAttempt: attempt.identity,
		expectedInputCaps: Object.freeze({
			kind: "iq",
			format: "U8_IQ",
			sampleRate: attempt.captureRateHz,
			centerFreq: attempt.captureCentreHz,
		}),
	})
	if (!handle) return undefined
	const permit = prepareChannelAdmission({
		handle,
		ledger: ownership.ledger,
		profile: input.profile,
		captureRateHz: attempt.captureRateHz,
		request: input.request,
		activation: "direct",
	})
	const decoder = handle.retainComponent("decoder")
	const classifier = handle.retainComponent("classifier")
	const analog = handle.retainComponent("analog")
	if (
		!permit ||
		!decoder ||
		!classifier ||
		!analog ||
		!handle.attachPermit(permit) ||
		!decoder.sealNeverStarted()
	) {
		handle.cancel()
		decoder?.sealNeverStarted()
		classifier?.sealNeverStarted()
		analog?.sealNeverStarted()
		handle.revokeUnclaimedArm()
		return undefined
	}
	const lifecycle = new GrantLifecycle(
		attempt,
		handle,
		channels,
		input.current,
		input.ended,
	)
	if (!input.current() || !handle.arm()) {
		lifecycle.invalidate()
		classifier.sealNeverStarted()
		analog.sealNeverStarted()
		handle.revokeUnclaimedArm()
		return undefined
	}
	return Object.freeze({
		handle,
		classifier,
		analog,
		lifecycle,
		request: Object.freeze({ ...input.request }),
	})
}
