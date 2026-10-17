/**
 * WG10 req 3 / 4.2 wiring in the scanner service: `deps.analogEvidence` reaches the identify
 * runner's deps; the passive attempt is skipped (debug) while the source has no caps and a start
 * failure with caps keeps its warn; the `connected` retry builds the job.
 */
import { rm } from "node:fs/promises"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { JobDriver } from "../../../../src/core/scanner/job-runner.js"
import type { IdentifyAnalogEvidence } from "../../../../src/core/scanner/identify-analog-contract.js"
import { CENTRE, serviceHarness } from "../../../mocks/scanner/service-fakes.js"

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
	for (const c of cleanups.splice(0).reverse()) await c()
})
function harness(opts: Parameters<typeof serviceHarness>[0] = {}) {
	const h = serviceHarness(opts)
	cleanups.push(async () => {
		await h.service.stop()
		await rm(h.dir, { recursive: true, force: true })
	})
	return h
}
interface Internals {
	log: {
		debug(...a: unknown[]): void
		warn(...a: unknown[]): void
	}
	deps: { analogEvidence?: IdentifyAnalogEvidence }
	drivers: Map<string, JobDriver>
}
const internals = (h: ReturnType<typeof harness>): Internals =>
	h.service as unknown as Internals

const port: IdentifyAnalogEvidence = {
	transmissionsNear: () => [],
	monitoring: () => false,
}
const noPassive = (s: { passive: { enabled: boolean } }): void => {
	s.passive.enabled = false
}

async function identifyDriverDeps(h: ReturnType<typeof harness>) {
	await h.service.start()
	const job = await h.service.identify({
		sourceId: "rtl",
		target: { frequencyHz: CENTRE + 100_000 },
		timeoutMs: 1000,
	})
	const driver = internals(h).drivers.get(job.id)!
	return (driver as unknown as { deps: Record<string, unknown> }).deps
}

describe("ScannerService analog evidence wiring (WG10 req 3)", () => {
	it("passes deps.analogEvidence into the identify runner deps", async () => {
		const h = harness({ patch: noPassive })
		internals(h).deps.analogEvidence = port
		const deps = await identifyDriverDeps(h)
		expect(deps["analogEvidence"]).toBe(port)
	})

	it("passes nothing without the port (no key at all)", async () => {
		const h = harness({ patch: noPassive })
		const deps = await identifyDriverDeps(h)
		expect("analogEvidence" in deps).toBe(false)
	})
})

describe("ScannerService passive attempt before the source has caps (WG10 req 4.2)", () => {
	it("skips the attempt at debug (no warn) while the source has no caps", async () => {
		const h = harness({ liveCaps: false })
		const warn = vi.spyOn(internals(h).log, "warn")
		const debug = vi.spyOn(internals(h).log, "debug")
		await h.service.start()
		expect(h.service.getJob("passive-rtl")).toBeUndefined()
		expect(
			warn.mock.calls.filter(c => String(c[1]).includes("Passive job")),
		).toEqual([])
		expect(
			debug.mock.calls.some(c => String(c[1]).includes("Passive job")),
		).toBe(true)
		// no engine start was attempted
		expect(h.decoders.held.size).toBe(0)
	})

	it("the connected retry builds the job after the skip", async () => {
		const h = harness({ liveCaps: false })
		await h.service.start()
		h.sources.caps.set("rtl", h.configCaps)
		h.sources.emit("connected", "rtl")
		await vi.waitFor(
			() => expect(h.service.getJob("passive-rtl")?.state).toBe("running"),
			{ timeout: 5000 },
		)
	})

	it("a start failure with caps present keeps the warn", async () => {
		const h = harness()
		const svc = h.service as unknown as {
			createDriver(r: unknown): { start(): Promise<void> }
		}
		const createDriver = svc.createDriver.bind(h.service)
		svc.createDriver = r => {
			const d = createDriver(r)
			d.start = () => Promise.reject(new Error("start refused"))
			return d
		}
		const warn = vi.spyOn(internals(h).log, "warn")
		await h.service.start()
		expect(
			warn.mock.calls.some(c =>
				String(c[1]).startsWith("Passive job failed to start"),
			),
		).toBe(true)
	})
})
