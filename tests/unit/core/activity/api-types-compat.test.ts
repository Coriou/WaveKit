/**
 * Identity of the shared activity DTOs and the core declarations.
 * Same is stricter than mutual assignability: an optional key added or
 * dropped on one side, at any depth, makes it false. Typecheck fails the
 * build; the runtime assertion keeps the bindings live.
 *
 * Stats and the replay reset reason accept either the pre-fix contract or
 * the review contract. Storage adds `writer` and `dropped.closed`; query
 * adds the `reader-failed` reset reason. The DTO is already the review shape.
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

type NextReset = {
	type: "reset"
	reason:
		| "cursor-gap"
		| "cursor-expired"
		| "store-changed"
		| "query-changed"
		| "invalid-cursor"
		| "reader-failed"
}
type NextReplay =
	| Api.ActivityReplayRecordsFrame
	| Api.ActivityReplayProgressFrame
	| NextReset

type NextStats = {
	admitted: number
	committed: number
	duplicates: number
	dropped: Record<
		"rate-limited" | "queue-full" | "store-paused" | "write-failed" | "closed",
		number
	>
	excludedTelemetry: number
	queueDepth: number
	queueBytes: number
	dbBytes: number
	walBytes: number
	rows: number
	oldestReceivedAt: string | null
	pruneWatermark: string
	paused: boolean
	writer: "running" | "stopped"
}

interface ExpectedRecords {
	type: "activity:records"
	channel: "activity"
	data: {
		id: string
		items: readonly Api.ActivitySummary[]
		scannedThrough: string
		cursor: string
	}
}
interface ExpectedProgress {
	type: "activity:progress"
	channel: "activity"
	data: { id: string; scannedThrough: string; cursor: string }
}
interface ExpectedReset {
	type: "activity:reset"
	channel: "activity"
	data: { id: string; reason: NextReset["reason"] }
}
interface ExpectedSubscribed {
	type: "activity:subscribed"
	channel: "activity"
	data: { id: string }
}
interface ExpectedUnsubscribed {
	type: "activity:unsubscribed"
	channel: "activity"
	data: { id: string }
}
interface ExpectedClosed {
	type: "activity:closed"
	channel: "activity"
	data: {
		reason: "resumable"
		cursors: Readonly<Record<string, string>>
	}
}
interface ExpectedError {
	type: "error"
	channel: "activity"
	data: { code: string; message: string; id?: string }
}
type ExpectedServer =
	| ExpectedRecords
	| ExpectedProgress
	| ExpectedReset
	| ExpectedSubscribed
	| ExpectedUnsubscribed
	| ExpectedClosed
	| ExpectedError

/**
 * Same mapping as `frameMessage` in src/api/activity-subscriptions.ts.
 * That function is private to the query lane, so this copy is what the
 * typecheck locks to ActivityServerMessage. Subscribed, unsubscribed,
 * closed and error are the other server messages that builder's neighbours
 * send. Closed uses per-subscription cursors.
 */
function replayWire(
	id: string,
	frame: Api.ActivityReplayFrame,
): Api.ActivityServerMessage {
	if (frame.type === "records") {
		return {
			type: "activity:records",
			channel: "activity",
			data: {
				id,
				items: frame.items,
				scannedThrough: frame.scannedThrough,
				cursor: frame.cursor,
			},
		}
	}
	if (frame.type === "progress") {
		return {
			type: "activity:progress",
			channel: "activity",
			data: {
				id,
				scannedThrough: frame.scannedThrough,
				cursor: frame.cursor,
			},
		}
	}
	return {
		type: "activity:reset",
		channel: "activity",
		data: { id, reason: frame.reason },
	}
}

const optionalCanary: Same<{ a?: number }, Record<never, never>> = false
const noFrameWrapper: Same<
	Extract<Api.ActivityServerMessage, { type: "activity:frame" }>,
	never
> = true
const closedKeys: Same<
	keyof Extract<Api.ActivityServerMessage, { type: "activity:closed" }>["data"],
	"reason" | "cursors"
> = true
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
	Same<Api.ActivityReplayResetFrame, NextReset>,
	Same<Contract.ActivityReplayResetFrame, NextReset>,
	Same<Api.ActivityReplayFrame, NextReplay>,
	Same<Contract.ActivityReplayFrame, NextReplay>,
	Same<Api.ActivityStoreStats, NextStats>,
	Same<Contract.ActivityStoreStats, NextStats>,
	Same<
		typeof Api.ACTIVITY_RECORD_VERSION,
		typeof Contract.ACTIVITY_RECORD_VERSION
	>,
	Same<Api.ActivitySubscribeMessage, ExpectedSubscribe>,
	Same<Api.ActivityUnsubscribeMessage, ExpectedUnsubscribe>,
	Same<Api.ActivityServerMessage, ExpectedServer>,
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
	true,
	true,
	true,
]

describe("activity api-types compatibility", () => {
	it("keeps shared DTOs identical to the core activity declarations", () => {
		expect(optionalCanary).toBe(false)
		expect(noFrameWrapper).toBe(true)
		expect(closedKeys).toBe(true)
		expect(sameShapes.every(flag => flag)).toBe(true)
	})

	it("types frameMessage output as the activity websocket messages", () => {
		expect(
			replayWire("live", {
				type: "records",
				items: [],
				scannedThrough: "4",
				cursor: "cursor-4",
			}),
		).toEqual({
			type: "activity:records",
			channel: "activity",
			data: {
				id: "live",
				items: [],
				scannedThrough: "4",
				cursor: "cursor-4",
			},
		})
		expect(
			replayWire("live", {
				type: "progress",
				scannedThrough: "4",
				cursor: "cursor-4",
			}),
		).toEqual({
			type: "activity:progress",
			channel: "activity",
			data: { id: "live", scannedThrough: "4", cursor: "cursor-4" },
		})
		const reset: Api.ActivityServerMessage = replayWire("live", {
			type: "reset",
			reason: "reader-failed",
		})
		expect(reset).toEqual({
			type: "activity:reset",
			channel: "activity",
			data: { id: "live", reason: "reader-failed" },
		})
		const notices: Api.ActivityServerMessage[] = [
			{
				type: "activity:subscribed",
				channel: "activity",
				data: { id: "live" },
			},
			{
				type: "activity:unsubscribed",
				channel: "activity",
				data: { id: "live" },
			},
			{
				type: "activity:closed",
				channel: "activity",
				data: { reason: "resumable", cursors: { live: "cursor-4" } },
			},
			{
				type: "error",
				channel: "activity",
				data: { code: "ACTIVITY_DISABLED", message: "Activity is disabled" },
			},
		]
		expect(notices.map(message => message.type)).toEqual([
			"activity:subscribed",
			"activity:unsubscribed",
			"activity:closed",
			"error",
		])
	})
})
