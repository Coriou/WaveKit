/**
 * The scanner hears an analog admission's eviction (B3) as it hears retention's deletions: the
 * recordings catalogue gets `recordings-removed` with the folder ids, and ownership of recordings
 * listed elsewhere is pruned. Admission eviction reads the operator's keep live through the
 * evidence store (M-2), not only the last retention pass's keep set. Synthetic ids only.
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { serviceHarness } from "../../../mocks/scanner/service-fakes.js"

interface AnalogContext {
	evicted?: (artifacts: readonly string[]) => void
	discoveryKept?: (discoveryId: string) => boolean
}
interface Internals {
	evidence: { analog: { context: AnalogContext } | null }
	store: {
		get(id: string): unknown
		aliasOwner(id: string): string | undefined
		pruneHeldRecordings(...args: unknown[]): number
	}
}

const stops: (() => Promise<void>)[] = []
afterEach(async () => {
	for (const stop of stops.splice(0)) await stop()
	vi.restoreAllMocks()
})

const settle = async (): Promise<void> => {
	for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r))
}

describe("an analog admission's eviction reaches the scanner like retention's deletions", () => {
	it("emits recordings-removed with the evicted files' folder ids and prunes held recordings", async () => {
		const h = serviceHarness({
			patch: st => void (st.passive.enabled = false),
		})
		await h.service.start()
		stops.push(() => h.service.stop())
		const svc = h.service as unknown as Internals
		const context = svc.evidence.analog?.context
		expect(context?.evicted).toBeTypeOf("function")
		const prune = vi.spyOn(svc.store, "pruneHeldRecordings")
		const removed: string[][] = []
		h.service.on("recordings-removed", (ids: string[]) => removed.push(ids))
		context!.evicted!([
			"recordings/analog/d_evict1/analog-11111111-1111-4111-8111-111111111111.wav",
			"recordings/analog/d_evict2/analog-22222222-2222-4222-8222-222222222222.wav",
		])
		await settle()
		expect(removed).toEqual([["d_evict1", "d_evict2"]])
		expect(prune).toHaveBeenCalledTimes(1)
	})

	it("admission eviction's live keep is the discovery's operator keep now", async () => {
		const h = serviceHarness({
			patch: st => void (st.passive.enabled = false),
		})
		const svc = h.service as unknown as Internals
		const kept = svc.evidence.analog?.context.discoveryKept
		expect(kept).toBeTypeOf("function")
		const operators = new Map<string, unknown>([
			["d_kept", { operator: { keep: true } }],
			["d_plain", { operator: { keep: false } }],
			["d_none", {}],
		])
		vi.spyOn(svc.store, "get").mockImplementation(id => operators.get(id))
		expect(kept!("d_kept")).toBe(true)
		expect(kept!("d_plain")).toBe(false)
		expect(kept!("d_none")).toBe(false)
		expect(kept!("d_missing")).toBe(false)
	})

	it("an alias folder of a kept survivor is kept (the live keep resolves the alias owner)", async () => {
		const h = serviceHarness({
			patch: st => void (st.passive.enabled = false),
		})
		const svc = h.service as unknown as Internals
		const kept = svc.evidence.analog?.context.discoveryKept
		expect(kept).toBeTypeOf("function")
		const operators = new Map<string, unknown>([
			["d_survivor", { operator: { keep: true } }],
			["d_other", { operator: { keep: false } }],
		])
		const owners = new Map([
			["d_merged", "d_survivor"],
			["d_mergedPlain", "d_other"],
		])
		vi.spyOn(svc.store, "get").mockImplementation(id => operators.get(id))
		vi.spyOn(svc.store, "aliasOwner").mockImplementation(id => owners.get(id))
		expect(kept!("d_merged")).toBe(true)
		expect(kept!("d_survivor")).toBe(true)
		expect(kept!("d_mergedPlain")).toBe(false)
		expect(kept!("d_unknownAlias")).toBe(false)
	})
})
