import Fastify from "fastify"
import { afterEach, expect, it, vi } from "vitest"
import { decoderRoutes } from "../../../../src/api/routes/decoders.js"
import type {
	ChargedDrop,
	LateDropWindow,
} from "../../../../src/decoders/enablement/contract.js"
import { createEfficiencyGate } from "../../../../src/decoders/enablement/efficiency-gate.js"
import type { DecoderManager } from "../../../../src/decoders/manager.js"
import { channelPlacement, gateManager } from "./gate-manager-harness.js"

let manager: DecoderManager | undefined
afterEach(async () => {
	await manager?.destroy()
	manager = undefined
	vi.useRealTimers()
})

/**
 * A real manager and efficiency gate behind the decoder routes, with an
 * in-process drop reader: `windows` and `drops` are the loss evidence and
 * `state` the source's drop state.
 */
async function setup() {
	const evidence: {
		windows: LateDropWindow[]
		drops: ChargedDrop[]
		state: "ok" | "unknown" | "dropping"
	} = { windows: [], drops: [], state: "ok" }
	const gate = createEfficiencyGate(
		{ budgetCores: 10, cpuGuardPercent: 90 },
		{
			drops: {
				monoNow: () => performance.now(),
				sources: () => ["rtl"],
				dropState: () => ({ state: evidence.state, dropBytesPerSecond: 0 }),
				droppedSinceMono: () => false,
				droppedWithinMs: () => false,
				latestAttribution: () => "none",
				lateWindows: () => evidence.windows,
				lastSampleMono: () => performance.now(),
				coverageCompleteAtMono: (_id, since, amount) =>
					performance.now() >= since + amount ? since + amount : null,
				chargedDropsBetweenMono: (_id, from, to) =>
					evidence.drops.filter(d => d.atMono >= from && d.atMono <= to),
			},
		},
	)
	const probation = vi.spyOn(gate, "probation")
	const placement = channelPlacement("dec", 162_000_000)
	manager = gateManager(gate, ["dec"], [placement]).manager
	await manager.startAll()
	// Graduated, then shed for its own late drops (two condemning windows of
	// settled loss on its own branch).
	await vi.advanceTimersByTimeAsync(65_000)
	const branch = probation.mock.calls.at(-1)![0][0]!.inputBranch!
	const start = performance.now()
	evidence.drops = Array.from({ length: 10 }, (_, i) => ({
		atMono: start - 20_000 + 1_000 + i * 2_000,
		code: "consumer",
		branches: [branch],
	}))
	evidence.windows = [0, 1].map(index => ({
		startMono: start - 20_000 + index * 10_000,
		endMono: start - 20_000 + (index + 1) * 10_000,
		condemning: true,
		linkOrUnknownDrops: false,
		condemnedBranches: [branch],
	}))
	await vi.advanceTimersByTimeAsync(10_000)
	manager.notifyBandplansChanged()
	await vi.advanceTimersByTimeAsync(350)
	expect(manager.getStatus("dec")).toMatchObject({
		running: false,
		efficiency: { detail: "late-drops", cause: "decoder" },
	})
	evidence.windows = []
	evidence.drops = []
	const app = Fastify()
	await app.register(decoderRoutes, { decoderManager: manager })
	return { app, evidence }
}

it("an operator start that clears an own-loss shed answers that it is re-admitted on probation", async () => {
	const { app } = await setup()
	try {
		const response = await app.inject({
			method: "POST",
			url: "/api/decoders/dec/start",
		})
		expect(response.statusCode).toBe(200)
		const message: string = response.json().message
		expect(message).not.toContain("waiting for the source to settle")
		expect(message).toMatch(/started successfully|re-admitted on probation/)
	} finally {
		await app.close()
	}
})

it("an operator start that clears a shed the gate still refuses names the real reason", async () => {
	const { app, evidence } = await setup()
	// The source now drops for its own reasons (no host starvation): the gate
	// refuses the re-admission for drops.
	evidence.state = "dropping"
	try {
		const response = await app.inject({
			method: "POST",
			url: "/api/decoders/dec/start",
		})
		expect(response.statusCode).toBe(200)
		const message: string = response.json().message
		expect(message).not.toContain("waiting for the source to settle")
		expect(message).toContain("blocked")
		expect(message).toContain("the source is dropping samples")
	} finally {
		await app.close()
	}
})
