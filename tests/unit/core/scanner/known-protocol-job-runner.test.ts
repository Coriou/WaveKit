import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { KnownProtocolMemory } from "../../../../src/core/scanner/known-protocol-contract.js"
import { createKnownProtocolMemory } from "../../../../src/core/scanner/known-protocol.js"
import type { DecodeEvidence } from "../../../../src/core/scanner/types.js"
import { testSettings } from "../../../mocks/scanner/engine-fakes.js"
import {
	jobHarness,
	makeLive,
	makeTrack,
	type HarnessOptions,
} from "./cancel-ended-harness.js"

const HOLD_MS = 1_800 // spec confirmHoldMs["tdma-ms"] + start latency 0

function recordingMemory() {
	const log: string[] = []
	const inner = createKnownProtocolMemory({
		discovery: id =>
			id === "d_1" ? { protocol: "dmr", confidence: "decoded" } : undefined,
	})
	const memory: KnownProtocolMemory = {
		known: id => inner.known(id),
		recordMiss: (id, p) => {
			log.push(`miss:${id}:${p}`)
			inner.recordMiss(id, p)
		},
		recordDecode: id => {
			log.push(`decode:${id}`)
			inner.recordDecode(id)
		},
		forget: id => inner.forget(id),
	}
	return { memory, log, inner }
}

async function running(opts: HarnessOptions = {}) {
	const h = jobHarness(opts)
	await h.runner.start()
	await vi.advanceTimersByTimeAsync(0)
	await h.runner.idle()
	expect(h.record.state).toBe("running")
	return h
}

const evidence = (probeId: string): DecodeEvidence => ({
	protocol: "dmr",
	identity: { kind: "dmr-cc", value: "1" } as DecodeEvidence["identity"] &
		object,
	metadata: {},
	crcClean: true,
	at: 0,
	epoch: 1,
	origin: "probe",
	probeId,
})

describe("job driver known-protocol counting (WG11 1.7, 1.8)", () => {
	beforeEach(() => {
		vi.useFakeTimers()
	})
	afterEach(() => {
		vi.useRealTimers()
	})

	it("counts a full-hold miss of the known protocol; two decay it", async () => {
		const { memory, log, inner } = recordingMemory()
		const h = await running({ knownProtocols: memory })
		for (let i = 0; i < 2; i++) {
			const track = makeTrack()
			h.runner.onTrack(makeLive(track), track, true)
			expect(h.probes.size).toBe(1)
			await vi.advanceTimersByTimeAsync(HOLD_MS)
			expect(h.probes.size).toBe(0)
		}
		expect(log).toEqual(["miss:d_1:dmr", "miss:d_1:dmr"])
		expect(inner.known("d_1")).toBeNull()
	})

	it("the passive job's reconfirm probe counts too", async () => {
		expect(testSettings().passive.offsetProbes).toBe(false)
		const { memory, log } = recordingMemory()
		const h = await running({
			knownProtocols: memory,
			passive: true,
			offsetProbes: true,
		})
		const track = makeTrack()
		h.runner.onTrack(makeLive(track, { decoded: true }), track, true)
		expect(h.requests[0]?.admission.kind).toBe("reconfirm")
		await vi.advanceTimersByTimeAsync(HOLD_MS)
		expect(log).toEqual(["miss:d_1:dmr"])
	})

	it("the memory ignores a full-hold miss of another protocol", async () => {
		const { memory, log, inner } = recordingMemory()
		const h = await running({ knownProtocols: memory })
		const track = makeTrack()
		h.runner.onTrack(makeLive(track), track, true)
		h.setProbeProtocol("p0", "nxdn48")
		await vi.advanceTimersByTimeAsync(HOLD_MS)
		expect(log).toEqual(["miss:d_1:nxdn48"])
		expect(inner.size()).toBe(0)
	})

	it("cut short (track closed), unavailable, dropped, still starting or cancelled: never a miss", async () => {
		const cases: [
			string,
			(h: Awaited<ReturnType<typeof running>>) => Promise<void> | void,
			HarnessOptions?,
		][] = [
			[
				"track closed",
				h => h.runner.onTrackClosed([...h.requests].at(-1)!.trackId),
			],
			["deferred", () => undefined, { defer: "cpu" }],
			["pool dropped it", h => h.dropProbe("p0")],
			["still starting", h => h.setProbeState("p0", "starting")],
			["stopping", h => h.setProbeState("p0", "stopping")],
			["cancelled", h => h.runner.dispatch({ type: "cancel" })],
			["paused", h => h.runner.dispatch({ type: "pause" })],
		]
		for (const [name, act, extra] of cases) {
			const { memory, log } = recordingMemory()
			const h = await running({ knownProtocols: memory, ...extra })
			const track = makeTrack()
			h.runner.onTrack(makeLive(track), track, true)
			await act(h)
			await vi.advanceTimersByTimeAsync(HOLD_MS + h.record.spec.hold.hangMs)
			expect(log, name).toEqual([])
		}
	})

	it("an identity accepted during the hold (ambient) is not a miss", async () => {
		const { memory, log } = recordingMemory()
		const h = await running({ knownProtocols: memory })
		const track = makeTrack()
		const live = makeLive(track)
		h.runner.onTrack(live, track, true)
		live.acceptedIdentity = {
			identity: { kind: "dmr-cc", value: "1" } as never,
			stream: 0,
			epoch: 1,
		}
		await vi.advanceTimersByTimeAsync(HOLD_MS)
		expect(log).toEqual([])
	})

	it("an accepted identity on a probe records a decode and resets the count", async () => {
		const { memory, log, inner } = recordingMemory()
		inner.recordMiss("d_1", "dmr")
		inner.recordMiss("d_1", "dmr")
		expect(inner.known("d_1")).toBeNull()
		const h = await running({ knownProtocols: memory })
		const track = makeTrack()
		const live = makeLive(track)
		h.runner.onTrack(live, track, true)
		// evidence the observation did not accept (trust refused it) is not a decode
		h.runner.onEvidence("p0", evidence("p0"))
		expect(log).toEqual([])
		live.acceptedIdentity = {
			identity: { kind: "dmr-cc", value: "1" } as never,
			stream: 0,
			epoch: 1,
		}
		h.runner.onEvidence("p0", evidence("p0"))
		expect(log).toEqual(["decode:d_1"])
		expect(inner.known("d_1")).toBe("dmr")
		await vi.advanceTimersByTimeAsync(HOLD_MS)
		expect(log).toEqual(["decode:d_1"])
	})

	it("without a memory the driver's calls are the same (golden)", async () => {
		const run = async (opts: HarnessOptions) => {
			const h = await running(opts)
			const track = makeTrack({ trackId: "t_fixed" })
			h.runner.onTrack(makeLive(track), track, true)
			await vi.advanceTimersByTimeAsync(HOLD_MS)
			const t2 = makeTrack({ trackId: "t_fixed2" })
			const live = makeLive(t2)
			h.runner.onTrack(live, t2, true)
			live.acceptedIdentity = {
				identity: { kind: "dmr-cc", value: "1" } as never,
				stream: 0,
				epoch: 1,
			}
			h.runner.onEvidence("p1", evidence("p1"))
			await vi.advanceTimersByTimeAsync(HOLD_MS)
			await h.runner.dispatch({ type: "cancel" })
			await vi.advanceTimersByTimeAsync(0)
			return { calls: h.calls, requests: h.requests }
		}
		const without = await run({})
		const withMemory = await run({ knownProtocols: recordingMemory().memory })
		expect(withMemory).toEqual(without)
		// frozen-code sequence (recorded at 14f2feaa with this harness)
		expect(without.calls).toEqual([
			"openEngine",
			"persist:starting",
			"changed:state",
			"persist:running",
			"changed:state",
			"releaseProbe:p0",
			"releaseJob",
			"closeEngine",
			"persist:cancelled",
			"changed:state",
		])
	})
})
