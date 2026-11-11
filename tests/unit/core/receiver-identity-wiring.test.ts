/**
 * Lane RS: the production wiring of src/index.ts (src/core/receiver-identity-wiring.ts): the real
 * ReceiverIdentityTracker over a source event emitter -> the real ReceiverLearnedState -> the
 * tuner's noteReceiverBound -> the source status `receiver` field.
 */
import { EventEmitter } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import pino from "pino"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type {
	SourceCandidateStatus,
	SourceReceiverStatus,
} from "@wavekit/api-types"
import { ReceiverIdentityTracker } from "../../../src/core/receiver-identity-tracker.js"
import {
	ReceiverLearnedState,
	type ReceiverBinding,
} from "../../../src/core/receiver-identity-state.js"
import {
	receiverBoundToTuner,
	wireReceiverStatus,
	wireReceiverTracker,
	type ReceiverWiringTuner,
} from "../../../src/core/receiver-identity-wiring.js"
import type { ReceiverIdentity } from "../../../src/core/receiver-identity.js"

const silent = pino({ level: "silent" })
let stateDir: string
beforeEach(async () => {
	stateDir = await mkdtemp(join(tmpdir(), "wk-receiver-wiring-"))
})
afterEach(async () => {
	await rm(stateDir, { recursive: true, force: true })
})

const waitFor = async (check: () => boolean, ms = 3_000) => {
	const end = Date.now() + ms
	while (!check()) {
		if (Date.now() > end) throw new Error("timed out")
		await new Promise(resolve => setTimeout(resolve, 5))
	}
}

describe("receiver identity wiring", () => {
	it("tracker -> learned state -> tuner noteReceiverBound -> source status", async () => {
		const sources = new EventEmitter()
		const tracker = new ReceiverIdentityTracker({
			sources: sources as never,
			logger: silent,
			sdrHostApplies: () => false,
		})
		const bound: Array<{
			id: string
			binding: ReceiverBinding
			identity?: string
		}> = []
		const tuner: ReceiverWiringTuner = {
			noteReceiverBound: (id, binding, identity?: ReceiverIdentity) =>
				bound.push({
					id,
					binding,
					...(identity ? { identity: identity.key } : {}),
				}),
			receiverTuningRestore: () => ({
				restored: true,
				reason: "same receiver",
			}),
		}
		let tunerReady: ReceiverWiringTuner | undefined
		const learned = new ReceiverLearnedState({
			stateDir,
			logger: silent,
			tracked: id => id === "rtl",
			onBound: receiverBoundToTuner(tracker, () => tunerReady),
		})
		await learned.load()
		wireReceiverTracker(tracker, learned)
		tunerReady = tuner
		let status: ((id: string) => SourceReceiverStatus | undefined) | null = null
		const candidate: SourceCandidateStatus = {
			index: 1,
			count: 2,
			label: "usb",
			target: "127.0.0.1:1",
			selectedBecause: "previous failed: refused",
			delivering: true,
			failures: 0,
			retries: 3,
		}
		wireReceiverStatus(
			{
				setReceiverStatusSource: fn => (status = fn),
				getSelectedCandidate: () => candidate,
			},
			learned,
			tuner,
		)
		expect(status!("rtl")).toBeUndefined()

		sources.emit("connected", "rtl")
		sources.emit("rtl-tcp-header", "rtl", {
			magic: "RTL0",
			tunerType: 5,
			gainCount: 29,
		})
		await waitFor(() => bound.some(b => b.binding.key === "model:5:29"))
		await learned.idle("rtl")
		expect(bound.at(-1)).toEqual({
			id: "rtl",
			binding: { key: "model:5:29", adoptLegacy: false },
			identity: "model:5:29",
		})
		expect(status!("rtl")).toEqual({
			key: "model:5:29",
			strength: "model",
			tunerType: 5,
			candidateLabel: "usb",
			selectedBecause: "previous failed: refused",
			learnedStateNamespace: null,
			namespaceState: "fresh",
			restoredTuning: { restored: true, reason: "same receiver" },
		})

		// A disconnect unbinds the tuner until the next connection settles (the same receiver).
		sources.emit("disconnected", "rtl")
		await waitFor(() => bound.at(-1)?.binding.key === null)
		sources.emit("connected", "rtl")
		sources.emit("rtl-tcp-header", "rtl", {
			magic: "RTL0",
			tunerType: 5,
			gainCount: 29,
		})
		await waitFor(() => bound.at(-1)?.binding.key === "model:5:29")
		await learned.idle("rtl")
		expect(bound.map(b => b.binding.key)).toEqual([
			"model:5:29",
			null,
			"model:5:29",
		])
		expect(status!("rtl")?.namespaceState).toBe("resumed")
		tracker.stop()
	})
})
