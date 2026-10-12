/**
 * Identity of the shared activity DTOs and the core declarations.
 * Same is stricter than mutual assignability: an optional key added or
 * dropped on one side, at any depth, makes it false. Typecheck fails the
 * build; the runtime assertion keeps the bindings live.
 */
import { describe, expect, it } from "vitest"
import type * as Api from "@wavekit/api-types"
import type * as Contract from "../../../../src/core/activity/storage/contract.js"
import type * as Core from "../../../../src/core/activity/types.js"

type Same<A, B> =
	(<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
		? true
		: false

type ExpectedSubscribe = {
	type: "activity:subscribe"
	id: string
	query: Api.ActivityQuery
	cursor?: string
}
type ExpectedUnsubscribe = {
	type: "activity:unsubscribe"
	id: string
}
type ExpectedFrame = {
	type: "activity:frame"
	id: string
	frame: Api.ActivityReplayFrame
}

const optionalCanary: Same<{ a?: number }, Record<never, never>> = false
const sameShapes: [
	Same<Api.JsonScalar, Core.JsonScalar>,
	Same<Api.JsonValue, Core.JsonValue>,
	Same<Api.DecodeField, Core.DecodeField>,
	Same<Api.DecodeProvenance, Core.DecodeProvenance>,
	Same<Api.DecodeReferences, Core.DecodeReferences>,
	Same<Api.DecodePosition, Core.DecodePosition>,
	Same<Api.DecodePresentation, Core.DecodePresentation>,
	Same<Api.DecodeEnvelopeContext, Core.DecodeEnvelopeContext>,
	Same<Api.DecodeEnvelope, Core.DecodeEnvelope>,
	Same<Api.ActivityKind, Contract.ActivityKind>,
	Same<Api.ActivityCategory, Contract.ActivityCategory>,
	Same<Api.IngestionGapPayload, Contract.IngestionGapPayload>,
	Same<Api.ActivityRecordBase, Contract.ActivityRecordBase>,
	Same<Api.DecoderReceptionRecord, Contract.DecoderReceptionRecord>,
	Same<Api.IngestionGapRecord, Contract.IngestionGapRecord>,
	Same<Api.ActivityRecord, Contract.ActivityRecord>,
	Same<Api.ActivitySummary, Contract.ActivitySummary>,
	Same<Api.ActivityRefType, Contract.ActivityRefType>,
	Same<Api.ActivityQuery, Contract.ActivityQuery>,
	Same<Api.ActivitySearchPage, Contract.ActivitySearchPage>,
	Same<Api.ActivityFacetRequest, Contract.ActivityFacetRequest>,
	Same<Api.ActivityFacetResult, Contract.ActivityFacetResult>,
	Same<Api.ActivityReplayRecordsFrame, Contract.ActivityReplayRecordsFrame>,
	Same<Api.ActivityReplayProgressFrame, Contract.ActivityReplayProgressFrame>,
	Same<Api.ActivityReplayResetFrame, Contract.ActivityReplayResetFrame>,
	Same<Api.ActivityReplayFrame, Contract.ActivityReplayFrame>,
	Same<Api.ActivityStoreStats, Contract.ActivityStoreStats>,
	Same<
		typeof Api.ACTIVITY_RECORD_VERSION,
		typeof Contract.ACTIVITY_RECORD_VERSION
	>,
	Same<Api.ActivitySubscribeMessage, ExpectedSubscribe>,
	Same<Api.ActivityUnsubscribeMessage, ExpectedUnsubscribe>,
	Same<Api.ActivityFrameMessage, ExpectedFrame>,
] = [
	true,
	true,
	true,
	true,
	true,
	true,
	true,
	true,
	true,
	true,
	true,
	true,
	true,
	true,
	true,
	true,
	true,
	true,
	true,
	true,
	true,
	true,
	true,
	true,
	true,
	true,
	true,
	true,
	true,
	true,
	true,
]

describe("activity api-types compatibility", () => {
	it("keeps shared DTOs identical to the core activity declarations", () => {
		expect(optionalCanary).toBe(false)
		expect(sameShapes.every(flag => flag)).toBe(true)
	})
})
