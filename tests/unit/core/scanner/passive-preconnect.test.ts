/**
 * WG10 req 4.2: the recovery path the pre-connect change relies on, verified on the frozen code:
 * a source that connects after the passive attempt gets its passive job from `connected`
 * (`onSourceConnected` -> `refreshPassive` -> `ensurePassiveJobs`) and its spectrum engine works.
 */
import { rm } from "node:fs/promises"
import { afterEach, describe, expect, it, vi } from "vitest"
import { serviceHarness } from "../../../mocks/scanner/service-fakes.js"

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
	for (const c of cleanups.splice(0).reverse()) await c()
})

describe("passive job recovery after a pre-connect attempt (WG10 req 4.2)", () => {
	it("builds the passive job and starts the spectrum engine when the source connects", async () => {
		const h = serviceHarness({ liveCaps: false })
		cleanups.push(async () => {
			await h.service.stop()
			await rm(h.dir, { recursive: true, force: true })
		})
		await h.service.start()
		expect(h.service.getJob("passive-rtl")).toBeUndefined()
		h.sources.caps.set("rtl", h.configCaps)
		h.sources.emit("connected", "rtl")
		await vi.waitFor(
			() => expect(h.service.getJob("passive-rtl")?.state).toBe("running"),
			{ timeout: 5000 },
		)
		const spectrum = (
			h.service as unknown as {
				spectrum: { engine(id: string): unknown }
			}
		).spectrum
		expect(spectrum.engine("rtl")).toBeDefined()
	})
})
