/** WG11 req 1.7 / 1.8, identify side: the known protocol's run first, miss and decode counting. */
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { knownFirst } from "../../../../src/core/scanner/identify.js"
import type {
	Discovery,
	ScannerProtocol,
} from "../../../../src/core/scanner/types.js"
import { DecoderSpawnError } from "../../../../src/utils/errors.js"
import { trackOf } from "../../../mocks/scanner/identify-fakes.js"
import { flushAsync, linkLine } from "../../../mocks/scanner/probe-fakes.js"
import { FakeMemory, harness } from "./identify-heard-fakes.js"

const dmrTrack = () => trackOf({ acf30: -0.94, acf60: 0.99 })
const PROTOCOLS: ScannerProtocol[] = ["dmr", "nxdn96"]

function discovery(confidence: string, protocol: ScannerProtocol = "nxdn96") {
	return { id: "d_1", protocol, confidence } as unknown as Discovery
}

function spawnError(errno: string): DecoderSpawnError {
	const cause = new Error("spawn failed") as NodeJS.ErrnoException
	cause.code = errno
	return new DecoderSpawnError("probe", "/bin/sh", cause)
}

type Outcome =
	| "miss"
	| "decode"
	| "cut-short"
	| "unavailable"
	| "cancelled"
	| "closed-at-start"
	| "closed-during"

async function runOnce(opts: {
	confidence: string
	misses: number
	memory?: boolean
	outcome: Outcome
}) {
	const mem = new FakeMemory(
		new Map([["d_1", { protocol: "nxdn96", confidence: opts.confidence }]]),
	)
	if (opts.misses > 0) mem.misses.set("d_1", opts.misses)
	const h = harness({
		port: null,
		discovery: discovery(opts.confidence),
		request: { protocols: PROTOCOLS },
		...(opts.memory === false ? {} : { knownProtocols: mem }),
	})
	h.engine.push(1_100_000)
	if (opts.outcome === "unavailable") h.decoders.failNext = spawnError("ENOENT")
	if (opts.outcome === "cut-short") h.decoders.failNext = new Error("boom")
	await h.start(dmrTrack())
	const trying = h.events.find(e => e.state === "trying")!
	if (opts.outcome === "decode") {
		const id = [...h.decoders.created.values()][0]?.id ?? ""
		h.decoders.emitLink(id, linkLine(1, h.clock.now))
		h.decoders.emitLink(id, linkLine(1, h.clock.now + 30))
		await flushAsync()
	}
	// Review m2: the transmission ends before the known run's hold does.
	if (opts.outcome === "closed-at-start") h.tracks.splice(0)
	if (opts.outcome === "closed-during") {
		await h.advance(500)
		h.tracks.splice(0)
	}
	if (opts.outcome === "cancelled") {
		await h.advance(500)
		await h.runner.dispatch({ type: "cancel" })
	}
	await h.settle(3000, 10)
	return { h, mem, trying }
}

describe("known protocol first (WG11 1.7)", () => {
	it("pure: moves the known protocol first, stable otherwise, never removes", () => {
		const s = [
			{ protocol: "dmr" as const, score: 0.9 },
			{ protocol: "ysf" as const, score: 0.4 },
			{ protocol: "nxdn96" as const, score: 0.2 },
		]
		expect(knownFirst(s, "nxdn96", {}, []).map(h => h.protocol)).toEqual([
			"nxdn96",
			"dmr",
			"ysf",
		])
		// Not scored: added first at score 0, unless explicitly excluded or no probe mode.
		expect(knownFirst(s, "dpmr", {}, [])[0]).toEqual({
			protocol: "dpmr",
			score: 0,
		})
		expect(knownFirst(s, "dpmr", { dpmr: 0 }, [])[0]?.protocol).toBe("dpmr")
		expect(knownFirst(s, "dpmr", {}, ["dmr"])).toEqual(s)
		expect(knownFirst(s, "analog-fm", {}, [])).toEqual(s)
	})

	it("absent dep: today's order (dmr's run first)", async () => {
		const { trying } = await runOnce({
			confidence: "decoded",
			misses: 0,
			memory: false,
			outcome: "miss",
		})
		expect(trying.trials.map(t => t.protocol)).toEqual(["dmr", "nxdn96"])
	})

	for (const misses of [0, 1, 2, 3]) {
		it(`${misses} misses: known first iff fewer than 2`, async () => {
			const { trying, mem } = await runOnce({
				confidence: "decoded",
				misses,
				outcome: "miss",
			})
			const order = trying.trials.map(t => t.protocol)
			expect(order).toEqual(misses < 2 ? ["nxdn96", "dmr"] : ["dmr", "nxdn96"])
			// A full-hold miss of the known run counts one; a decayed memory counts none.
			expect(mem.misses.get("d_1")).toBe(misses < 2 ? misses + 1 : misses)
		})
	}

	it("a non-decoded discovery has no known protocol", async () => {
		const { trying, mem } = await runOnce({
			confidence: "classified",
			misses: 0,
			outcome: "miss",
		})
		expect(trying.trials.map(t => t.protocol)).toEqual(["dmr", "nxdn96"])
		expect(mem.calls).toEqual([])
	})

	it("a decode resets the count", async () => {
		const { mem } = await runOnce({
			confidence: "decoded",
			misses: 1,
			outcome: "decode",
		})
		expect(mem.calls).toContain("decode:d_1")
		expect(mem.calls.filter(c => c.startsWith("miss"))).toEqual([])
		expect(mem.misses.get("d_1")).toBe(0)
	})

	for (const outcome of [
		"cut-short",
		"unavailable",
		"cancelled",
		"closed-at-start",
		"closed-during",
	] as const)
		it(`${outcome} is never a miss`, async () => {
			const { mem, h } = await runOnce({
				confidence: "decoded",
				misses: 1,
				outcome,
			})
			const nx = h.last()?.trials.find(t => t.protocol === "nxdn96")
			// A closed track still runs its trials to the hold on its last snapshot.
			if (!outcome.startsWith("closed")) expect(nx?.outcome).not.toBe("no-sync")
			expect(mem.calls.filter(c => c.startsWith("miss"))).toEqual([])
			expect(mem.misses.get("d_1")).toBe(1)
		})

	// Feature: web-gaps-11, Property 14: Known first, decays safely
	// Validates: Requirements 1.7, 1.8
	it("property: known first iff decoded with < 2 misses; every trial still planned; counts follow outcomes", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.record({
					confidence: fc.constantFrom("decoded", "classified", "candidate"),
					misses: fc.integer({ min: 0, max: 3 }),
					outcome: fc.constantFrom<Outcome>(
						"miss",
						"decode",
						"cut-short",
						"unavailable",
					),
				}),
				async c => {
					const { trying, mem } = await runOnce(c)
					const known = c.confidence === "decoded" && c.misses < 2
					const order = trying.trials.map(t => t.protocol)
					expect([...order].sort()).toEqual(["dmr", "nxdn96"])
					expect(order[0]).toBe(known ? "nxdn96" : "dmr")
					const after = mem.misses.get("d_1") ?? 0
					if (c.outcome === "decode") expect(after).toBe(0)
					else if (c.outcome === "miss" && known)
						expect(after).toBe(c.misses + 1)
					else expect(after).toBe(c.misses)
				},
			),
			{ numRuns: 100 },
		)
	}, 20_000) // load headroom: about 1.5-3 s on an idle machine
})
