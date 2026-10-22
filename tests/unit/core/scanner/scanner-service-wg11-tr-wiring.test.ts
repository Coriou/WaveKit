/**
 * WG11 req 5.3 wiring in the scanner service: `trackIdentity` answers from the live observation
 * map and the discovery store, and never throws.
 */
import { rm } from "node:fs/promises"
import { afterEach, describe, expect, it } from "vitest"
import type { LiveObservation } from "../../../../src/core/scanner/job-runner.js"
import { serviceHarness } from "../../../mocks/scanner/service-fakes.js"

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
	for (const c of cleanups.splice(0).reverse()) await c()
})

interface Internals {
	live: Map<string, LiveObservation>
	store: {
		discoveryIdOf(observationId: string): string | undefined
		identityOf(id: string): unknown
	}
}

function setup(discovery: unknown) {
	const h = serviceHarness()
	cleanups.push(async () => {
		await h.service.stop()
		await rm(h.dir, { recursive: true, force: true })
	})
	const internals = h.service as unknown as Internals
	const survivors: Record<string, string> = { o_1: "d_1", o_3: "d_gone" }
	internals.store = {
		discoveryIdOf: o => survivors[o],
		identityOf: id => (id === "d_1" ? discovery : undefined),
	}
	const obs = (over: Partial<LiveObservation> = {}): LiveObservation =>
		({
			observationId: "o_1",
			sourceId: "rtl",
			trackId: "t1",
			epoch: 1,
			jobIds: [],
			discoveryId: "d_1",
			startedAt: 0,
			...over,
		}) as LiveObservation
	return { service: h.service, internals, obs }
}

const DISCOVERY = { id: "d_1", protocol: "dmr", confidence: "classified" }

describe("ScannerService.trackIdentity", () => {
	it("returns the identity of a live observation of the same source with a discovery", () => {
		const { service, internals, obs } = setup(DISCOVERY)
		internals.live.set("t1", obs())
		expect(service.trackIdentity("rtl", "t1")).toEqual({
			discoveryId: "d_1",
			protocol: "dmr",
			confidence: "classified",
		})
	})

	it("is null for another source, an unknown track, no discovery or an unknown discovery", () => {
		const { service, internals, obs } = setup(DISCOVERY)
		internals.live.set("t1", obs())
		internals.live.set("t2", obs({ trackId: "t2", discoveryId: null }))
		internals.live.set(
			"t3",
			obs({ trackId: "t3", observationId: "o_3", discoveryId: "d_gone" }),
		)
		expect(service.trackIdentity("other", "t1")).toBeNull()
		expect(service.trackIdentity("rtl", "nope")).toBeNull()
		expect(service.trackIdentity("rtl", "t2")).toBeNull()
		expect(service.trackIdentity("rtl", "t3")).toBeNull()
	})

	it("is null after the track closed", () => {
		const { service, internals, obs } = setup(DISCOVERY)
		internals.live.set("t1", obs())
		internals.live.delete("t1")
		expect(service.trackIdentity("rtl", "t1")).toBeNull()
	})

	it("is null when the discovery lacks protocol or confidence", () => {
		const { service, internals, obs } = setup({ id: "d_1", protocol: "dmr" })
		internals.live.set("t1", obs())
		expect(service.trackIdentity("rtl", "t1")).toBeNull()
	})

	it("never throws when the store throws", () => {
		const { service, internals, obs } = setup(DISCOVERY)
		internals.live.set("t1", obs())
		internals.store = {
			discoveryIdOf: () => "d_1",
			identityOf: () => {
				throw new Error("boom")
			},
		}
		expect(service.trackIdentity("rtl", "t1")).toBeNull()
	})
})
