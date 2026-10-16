import type {
	BandPlansChangedEventData,
	BandPlanStackView,
	BandPlansServerMessage,
} from "@wavekit/api-types"
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
	createBandPlansBroadcastPort,
	createBandPlansCommitSink,
	sendBandPlansSnapshot,
} from "../../../src/api/websocket/bandplans-broadcast-adapter.js"
import type { BandPlansBroadcastTransport } from "../../../src/api/websocket/bandplans-broadcast-adapter.js"
import type {
	BandPlansBroadcastPort,
	BandPlanService,
} from "../../../src/core/bandplans/contract.js"

interface Sent {
	readonly channel: "bandplans"
	readonly clientIds: readonly string[] | undefined
	readonly message: BandPlansServerMessage
}

function recording(accept: number | (() => number) = 1): {
	sent: Sent[]
	transport: BandPlansBroadcastTransport
} {
	const sent: Sent[] = []
	const count = () => (typeof accept === "function" ? accept() : accept)
	return {
		sent,
		transport: {
			broadcast(channel, message) {
				sent.push({ channel, clientIds: undefined, message })
			},
			sendToClients(channel, clientIds, message) {
				sent.push({ channel, clientIds: [...clientIds], message })
				return count()
			},
		},
	}
}

const arbToken: fc.Arbitrary<BandPlansChangedEventData> = fc.record({
	storeId: fc.oneof(fc.constant(null), fc.string()),
	revision: fc.integer(),
})

function envelope(token: BandPlansChangedEventData): BandPlansServerMessage {
	return {
		type: "bandplans:changed",
		channel: "bandplans",
		data: { storeId: token.storeId, revision: token.revision },
	}
}

function assertExactEnvelope(
	message: BandPlansServerMessage,
	token: BandPlansChangedEventData,
) {
	expect(message).toEqual(envelope(token))
	expect(Object.keys(message).sort()).toEqual(["channel", "data", "type"])
	expect(Object.keys(message.data).sort()).toEqual(["revision", "storeId"])
	expect(JSON.parse(JSON.stringify(message))).toEqual(message)
}

function serviceWith(
	store: BandPlanStackView["store"],
): Pick<BandPlanService, "view"> {
	return {
		view: () => ({ store }) as BandPlanStackView,
	}
}

describe("bandplans broadcast adapter", () => {
	// Feature: band-plans, Property 22: Change notice
	// Validates: Requirements 9.3, 11.9
	it("publishes an exact detached JSON envelope for every token, including a null storeId", () => {
		fc.assert(
			fc.property(arbToken, token => {
				const { sent, transport } = recording()
				const port = createBandPlansBroadcastPort(transport, () => {
					throw new Error("publish failure is not a transport failure")
				})
				const input = {
					storeId: token.storeId,
					revision: token.revision,
					leaked: true,
				}
				port.publishChanged(input)
				input.storeId = input.storeId === null ? "mutated" : null
				input.revision += 1
				expect(sent).toHaveLength(1)
				const broadcast = sent[0]!
				expect(broadcast.channel).toBe("bandplans")
				expect(broadcast.clientIds).toBeUndefined()
				assertExactEnvelope(broadcast.message, token)
				expect(broadcast.message.data).not.toBe(input)

				const sinkInput = {
					storeId: token.storeId,
					revision: token.revision,
				}
				expect(createBandPlansCommitSink(port)(sinkInput)).toBeUndefined()
				sinkInput.storeId = "after-sink"
				sinkInput.revision = token.revision + 7
				expect(sent).toHaveLength(2)
				assertExactEnvelope(sent[1]!.message, token)
				expect(sent[1]!.message.data).not.toBe(sinkInput)
			}),
			{ numRuns: 100 },
		)
	})

	// Feature: band-plans, Property 22: Change notice
	// Validates: Requirements 9.3, 11.9
	it("sends the current token on subscribe and accepts only exactly one client", () => {
		fc.assert(
			fc.property(
				arbToken,
				fc.integer({ min: -3, max: 5 }),
				fc.string(),
				(token, accepted, clientId) => {
					const { sent, transport } = recording(accepted)
					const port = createBandPlansBroadcastPort(transport, () => {
						throw new Error("snapshot transport failure is not swallowed here")
					})
					const store = {
						state: "available" as const,
						storeId: token.storeId,
						revision: token.revision,
					}
					const outcome = sendBandPlansSnapshot(
						serviceWith(store),
						port,
						clientId,
					)
					store.storeId = "mutated-store"
					store.revision = token.revision + 1
					expect(outcome).toBe(accepted === 1 ? "sent" : "rejected")
					expect(sent).toHaveLength(1)
					expect(sent[0]!.channel).toBe("bandplans")
					expect(sent[0]!.clientIds).toEqual([clientId])
					assertExactEnvelope(sent[0]!.message, token)
					expect(sent[0]!.message.data).not.toBe(store)
				},
			),
			{ numRuns: 100 },
		)
	})

	it("swallows a throwing broadcast and a throwing failure callback", () => {
		const transport = recording().transport
		transport.broadcast = () => {
			throw new Error("transport down")
		}
		let failures = 0
		const port = createBandPlansBroadcastPort(transport, () => {
			failures += 1
			throw new Error("invalidate failed")
		})
		const sink = createBandPlansCommitSink(port)
		expect(() =>
			port.publishChanged({ storeId: null, revision: 0 }),
		).not.toThrow()
		expect(sink({ storeId: "store", revision: 2 })).toBeUndefined()
		expect(failures).toBe(2)
	})

	it("lets a throwing port escape the commit sink", () => {
		const port: BandPlansBroadcastPort = {
			publishChanged() {
				throw new Error("port failed")
			},
			sendSnapshot() {
				return false
			},
		}
		expect(() =>
			createBandPlansCommitSink(port)({ storeId: null, revision: 1 }),
		).toThrow("port failed")
	})

	it("lets a throwing snapshot transport escape", () => {
		const { transport } = recording()
		transport.sendToClients = () => {
			throw new Error("snapshot transport down")
		}
		const port = createBandPlansBroadcastPort(transport, () => {
			throw new Error("publish callback must not run for snapshots")
		})
		expect(() =>
			port.sendSnapshot("client", { storeId: null, revision: 0 }),
		).toThrow("snapshot transport down")
		expect(() =>
			sendBandPlansSnapshot(
				serviceWith({ state: "available", storeId: null, revision: 0 }),
				port,
				"client",
			),
		).toThrow("snapshot transport down")
	})

	it("sends nothing when the service is absent, the store is unavailable, or view() throws", () => {
		const { sent, transport } = recording()
		const port = createBandPlansBroadcastPort(transport, () => undefined)
		expect(sendBandPlansSnapshot(undefined, port, "client")).toBe("unavailable")
		expect(
			sendBandPlansSnapshot(
				serviceWith({ state: "unavailable" }),
				port,
				"client",
			),
		).toBe("unavailable")
		expect(sent).toEqual([])
		const failing: Pick<BandPlanService, "view"> = {
			view() {
				throw new Error("view failed")
			},
		}
		expect(() => sendBandPlansSnapshot(failing, port, "client")).toThrow(
			"view failed",
		)
		expect(sent).toEqual([])
	})
})
