import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import pino from "pino"
import { afterEach, expect, it, vi } from "vitest"
import { FanoutManager } from "../../../../src/core/fanout-manager.js"
import {
	RETIRED_GATES_MAX,
	RETIRED_GATE_READS,
	SourceFanoutRouter,
} from "../../../../src/core/source-fanout-router.js"
import type { SourceManager } from "../../../../src/core/source-manager.js"
import type {
	AbsorberCounters,
	BurstAbsorber,
	IngestRecorder,
	LinkBurstFactories,
} from "../../../../src/core/link-burst/contract.js"

/**
 * The real router over a fake absorber whose gate totals the test sets; like
 * the real one, the fake forgets a branch's total when the branch is removed.
 */
function harness() {
	const stream = new PassThrough()
	const sources = Object.assign(new EventEmitter(), {
		getAllStatus: () => [{ id: "s", connected: false }],
		getStatus: () => ({ connected: true }),
		getStream: () => stream,
		getCaps: () => ({ format: "U8_IQ", sampleRate: 2_048_000 }),
		getConfig: () => ({
			host: "example.invalid",
			type: "rtl_tcp",
			burstAbsorber: { seconds: 2 },
		}),
	})
	const gates = new Map<string, number>()
	const factories: LinkBurstFactories = {
		createRecorder: () =>
			({
				configure: vi.fn(),
				recovery: () => null,
				resetArrival: vi.fn(),
				observeChunk: vi.fn(),
				noteHolding: vi.fn(),
			}) as unknown as IngestRecorder,
		createAbsorber: (_id, deps) => {
			deps.fanout.on("branch-removed", (id: string) => gates.delete(id))
			const absorber: BurstAbsorber & {
				overflowGatedBy(): Readonly<Record<string, number>>
			} = {
				configure: () => {},
				ingest: () => {},
				flush: () => {},
				counters: () =>
					({
						overflowBytesTotal: 0,
						overflowChunksTotal: 0,
					}) as AbsorberCounters,
				dispose: () => {},
				overflowGatedBy: () => Object.fromEntries(gates),
			}
			return absorber
		},
		monoNow: () => 0,
	}
	const logger = pino({ level: "silent" })
	const primary = new FanoutManager(logger)
	const router = new SourceFanoutRouter(
		sources as unknown as SourceManager,
		primary,
		logger,
		"s",
		{ linkBurst: factories },
	)
	sources.emit("connected", "s")
	const read = () => {
		const counters = router.branchDropCounters("s")!
		const absorber = [...counters].find(([key]) => key.startsWith("@"))
		return absorber?.[1].overflowGatedBy ?? {}
	}
	return {
		gates,
		primary,
		read,
		close() {
			router.destroy()
			primary.destroy()
			stream.destroy()
		},
	}
}

let close: (() => void) | undefined
afterEach(() => {
	close?.()
	close = undefined
})

it(`a removed holder's gate total is reported for ${RETIRED_GATE_READS} reads under its old key, then dropped`, () => {
	// Monitor reads every 2000 ms: 2 reads ≈ 4000 ms of retention.
	expect(RETIRED_GATE_READS).toBe(2)
	const h = harness()
	close = h.close
	h.primary.addBranch({ id: "live" })
	h.gates.set("live", 72)
	const [key] = Object.keys(h.read())
	expect(key).toMatch(/^live#\d+$/)
	h.gates.set("live", 144)
	h.primary.removeBranch("live")
	// Re-added: a new instance from zero, beside the retired one.
	h.primary.addBranch({ id: "live" })
	for (let read = 1; read <= RETIRED_GATE_READS; read++)
		expect(h.read()[key!]).toBe(144)
	expect(h.read()).not.toHaveProperty(key!)
})

it("a removed branch with no gate total is not kept", () => {
	const h = harness()
	close = h.close
	h.primary.addBranch({ id: "quiet" })
	h.primary.removeBranch("quiet")
	expect(h.read()).toEqual({})
})

for (const removed of [RETIRED_GATES_MAX, RETIRED_GATES_MAX + 1])
	it(`${removed} removed holders keep the newest ${RETIRED_GATES_MAX}`, () => {
		expect(RETIRED_GATES_MAX).toBe(64)
		const h = harness()
		close = h.close
		for (let i = 0; i < removed; i++) {
			const id = `live-${i}`
			h.primary.addBranch({ id })
			h.gates.set(id, i + 1)
			h.primary.removeBranch(id)
		}
		const kept = Object.keys(h.read())
		expect(kept).toHaveLength(Math.min(removed, RETIRED_GATES_MAX))
		expect(kept.some(k => k.startsWith("live-0#"))).toBe(
			removed <= RETIRED_GATES_MAX,
		)
		expect(kept.some(k => k.startsWith(`live-${removed - 1}#`))).toBe(true)
	})
