import { describe, expect, it, vi } from "vitest"
import { ScannerService } from "../../../../src/core/scanner/scanner-service.js"

const GROUPS = [{ survivor: "d_b", absorbed: ["d_a"] }]

type Read =
	| { kind: "ok"; plan: { groups: typeof GROUPS } }
	| { kind: "none" }
	| { kind: "invalid" }

/**
 * Runs the start-up step alone, on a stand-in for the service: what each case proves is the order
 * of the ownership checks around the persistence calls.
 */
function harness(read: Read, loseAt?: "plan" | "snapshot" | "read" | "slice") {
	let lost = false
	const order: string[] = []
	const persistence = {
		readConsolidationPlan: vi.fn(async () => {
			order.push("read")
			if (loseAt === "read") lost = true
			return read
		}),
		writeConsolidationPlan: vi.fn(async () => {
			order.push("plan")
			if (loseAt === "plan") lost = true
		}),
		writeSnapshotOf: vi.fn(async () => {
			order.push("snapshot")
			if (loseAt === "snapshot") lost = true
		}),
		removeConsolidationPlan: vi.fn(async () => {
			order.push("remove")
		}),
	}
	const self = {
		ownershipLost: () => lost,
		now: () => 0,
		persistence,
		store: {
			consolidationPlan: () => ({ groups: GROUPS, truncated: 0 }),
			applyConsolidation: () => {
				order.push("apply")
				if (loseAt === "slice") lost = true
				return { groups: 1, absorbed: 1, merges: [] }
			},
			get: () => undefined,
		},
		log: { info: () => undefined, warn: () => undefined },
	}
	const run = (
		ScannerService.prototype as unknown as {
			consolidateAtLoad: (this: unknown) => Promise<void>
		}
	).consolidateAtLoad
	return {
		order,
		lose: () => {
			lost = true
		},
		go: () => run.call(self),
	}
}

describe("discovery consolidation around a lost ownership", () => {
	it("with no loss: plan, apply, snapshot, removal", async () => {
		const h = harness({ kind: "none" })
		await h.go()
		expect(h.order).toEqual(["read", "plan", "apply", "snapshot", "remove"])
	})

	it("lost before the load: touches nothing", async () => {
		const h = harness({ kind: "none" })
		h.lose()
		await h.go()
		expect(h.order).toEqual([])
	})

	it("lost during the read: writes no new plan", async () => {
		const h = harness({ kind: "none" }, "read")
		await h.go()
		expect(h.order).toEqual(["read"])
	})

	it("lost during the plan write: the plan stays, with no snapshot and no removal", async () => {
		const h = harness({ kind: "none" }, "plan")
		await h.go()
		expect(h.order).toEqual(["read", "plan", "apply"])
	})

	it("lost during the snapshot write: the plan is not removed", async () => {
		const h = harness({ kind: "none" }, "snapshot")
		await h.go()
		expect(h.order).toEqual(["read", "plan", "apply", "snapshot"])
	})

	it("resuming, lost during the read: applied in memory only, the plan kept", async () => {
		const h = harness({ kind: "ok", plan: { groups: GROUPS } }, "read")
		await h.go()
		expect(h.order).toEqual(["read", "apply"])
	})

	it("lost during the slices: no snapshot and no removal", async () => {
		const h = harness({ kind: "none" }, "slice")
		await h.go()
		expect(h.order).toEqual(["read", "plan", "apply"])
	})

	it("an unreadable plan is left alone", async () => {
		const h = harness({ kind: "invalid" })
		await h.go()
		expect(h.order).toEqual(["read"])
	})
})
