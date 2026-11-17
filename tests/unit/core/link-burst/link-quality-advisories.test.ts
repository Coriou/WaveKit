import { describe, it, expect, vi } from "vitest"
import type { LinkAdvisory } from "@wavekit/api-types"
import { createLinkQuality } from "../../../../src/core/link-burst/link-quality.js"
import type { LinkQualityDeps } from "../../../../src/core/link-burst/link-quality.js"
import { LINK_DROPPING_HOLD_MS } from "../../../../src/core/link-burst/contract.js"

const base = {
	transport: "network" as const,
	payloadBytesPerSecond: 4_800_000,
	sustainedBytesPerSecond: null,
	shortfallPercent: null,
	upstreamDropBytesPerSecond: null,
}
const none: LinkAdvisory = { ...base, level: "none" }
const source: LinkAdvisory = {
	...base,
	level: "dropping",
	lossReason: "source",
}
const busy: LinkAdvisory = {
	...base,
	level: "dropping",
	lossReason: "core-busy",
}
const iso = (ms: number) => new Date(ms).toISOString()

function setup() {
	let t = 0
	let current: LinkAdvisory | null = none
	const reportAdvisory = vi.fn()
	const deps: LinkQualityDeps = {
		sources: () => ["s"],
		handles: () => ({
			transport: "network",
			capacitySeconds: 0,
			recorder: null,
			absorber: null,
		}),
		attribution: () => null,
		upstreamDropRate: () => null,
		receiver: () => null,
		// Wall and monotonic clocks move together here.
		monoNow: () => t,
		now: () => t,
		advisory: () => current,
		reportAdvisory,
	}
	const quality = createLinkQuality(deps)
	return {
		deps,
		quality,
		reportAdvisory,
		at(ms: number, advisory: LinkAdvisory | null) {
			t = ms
			current = advisory
			quality.recheckAdvisories()
			return quality.advisories()
		},
	}
}

describe("advisory states", () => {
	it("re-reports once per level and cause change, records recovery without an alert", () => {
		const h = setup()
		expect(h.at(0, none)).toEqual([
			{ sourceId: "s", level: "none", since: iso(0) },
		])
		expect(h.at(2000, source)).toEqual([
			{
				sourceId: "s",
				level: "dropping",
				lossReason: "source",
				since: iso(2000),
				episodeSince: iso(2000),
			},
		])
		h.at(4000, source)
		expect(h.reportAdvisory).toHaveBeenCalledTimes(1)
		expect(h.at(6000, busy)).toEqual([
			{
				sourceId: "s",
				level: "dropping",
				lossReason: "core-busy",
				since: iso(6000),
				episodeSince: iso(2000),
			},
		])
		expect(h.reportAdvisory).toHaveBeenCalledTimes(2)
		expect(h.reportAdvisory).toHaveBeenLastCalledWith("s", busy)
		expect(h.at(8000, none)).toEqual([
			{
				sourceId: "s",
				level: "none",
				since: iso(8000),
				episodeSince: iso(2000),
			},
		])
		expect(h.reportAdvisory).toHaveBeenCalledTimes(2)
	})
	it("a dropping within the 60 s hold keeps the episode; a full hold ends it", () => {
		const h = setup()
		h.at(0, source)
		const cleared = 2000
		h.at(cleared, none)
		h.at(cleared + LINK_DROPPING_HOLD_MS - 1000, none)
		// Non-dropping for 59 s: the next dropping continues the episode.
		expect(
			h.at(cleared + LINK_DROPPING_HOLD_MS - 1000, source)[0],
		).toMatchObject({
			episodeSince: iso(0),
		})
		const again = cleared + LINK_DROPPING_HOLD_MS
		h.at(again, none)
		expect(h.at(again + LINK_DROPPING_HOLD_MS - 1, none)[0]).toMatchObject({
			episodeSince: iso(0),
		})
		// Non-dropping for exactly 60 s ends it.
		const ended = h.at(again + LINK_DROPPING_HOLD_MS, none)[0]
		expect(ended).toMatchObject({ level: "none" })
		expect(ended).not.toHaveProperty("episodeSince")
		const next = again + LINK_DROPPING_HOLD_MS + 2000
		expect(h.at(next, busy)[0]).toMatchObject({ episodeSince: iso(next) })
	})
	it("an unproven advisory is non-dropping for the hold", () => {
		const h = setup()
		h.at(0, source)
		h.at(1000, { ...base, level: "unproven" })
		const ended = h.at(1000 + LINK_DROPPING_HOLD_MS, {
			...base,
			level: "unproven",
		})[0]
		expect(ended).not.toHaveProperty("episodeSince")
		expect(ended?.since).toBe(iso(1000))
	})
	it("lists only network sources with an advisory, and drops vanished ones", () => {
		const h = setup()
		h.deps.sources = () => ["s", "local", "idle"]
		h.deps.handles = id => ({
			transport: id === "local" ? "loopback" : "network",
			capacitySeconds: 0,
			recorder: null,
			absorber: null,
		})
		const advise = h.deps.advisory
		h.deps.advisory = id => (id === "idle" ? null : (advise?.(id) ?? null))
		expect(h.at(0, source).map(entry => entry.sourceId)).toEqual(["s"])
		h.deps.sources = () => []
		expect(h.at(2000, source)).toEqual([])
	})
	it("throwing evidence keeps the last state", () => {
		const h = setup()
		h.at(0, source)
		h.deps.advisory = () => {
			throw new Error("unavailable")
		}
		h.quality.recheckAdvisories()
		expect(h.quality.advisories()).toHaveLength(1)
	})
	it("a listed source with no advisory keeps its episode for the hold", () => {
		const h = setup()
		h.at(0, source)
		const held = h.at(1000, null)
		expect(held).toEqual([
			{
				sourceId: "s",
				level: "none",
				since: iso(1000),
				episodeSince: iso(0),
			},
		])
		expect(h.at(1000 + LINK_DROPPING_HOLD_MS - 1, null)[0]).toMatchObject({
			episodeSince: iso(0),
		})
		const ended = h.at(1000 + LINK_DROPPING_HOLD_MS, null)[0]
		expect(ended).toMatchObject({ sourceId: "s", level: "none" })
		expect(ended).not.toHaveProperty("episodeSince")
		expect(h.reportAdvisory).toHaveBeenCalledTimes(1)
	})
	it("a source never recorded with no advisory stays unlisted", () => {
		const h = setup()
		expect(h.at(0, null)).toEqual([])
	})
	it("evidence failing for the hold ages a dropping state out", () => {
		const h = setup()
		h.at(0, source)
		h.deps.advisory = () => {
			throw new Error("unavailable")
		}
		expect(h.at(1000, null)[0]).toMatchObject({ level: "dropping" })
		expect(h.at(1000 + LINK_DROPPING_HOLD_MS - 1, null)[0]).toMatchObject({
			level: "dropping",
		})
		const aged = h.at(1000 + LINK_DROPPING_HOLD_MS, null)[0]
		expect(aged).toMatchObject({ level: "none", episodeSince: iso(0) })
		expect(aged).not.toHaveProperty("lossReason")
		// The episode then ends after its own hold.
		const ended = h.at(1000 + 2 * LINK_DROPPING_HOLD_MS, null)[0]
		expect(ended).not.toHaveProperty("episodeSince")
	})
	it("a successful recheck restarts the failure count", () => {
		const h = setup()
		h.at(0, source)
		let fail = true
		h.deps.advisory = () => {
			if (fail) throw new Error("unavailable")
			return source
		}
		h.at(1000, null)
		fail = false
		h.at(1000 + LINK_DROPPING_HOLD_MS - 1, null)
		fail = true
		h.at(1000 + LINK_DROPPING_HOLD_MS, null)
		expect(h.at(1000 + 2 * LINK_DROPPING_HOLD_MS - 2, null)[0]).toMatchObject({
			level: "dropping",
		})
	})
})
