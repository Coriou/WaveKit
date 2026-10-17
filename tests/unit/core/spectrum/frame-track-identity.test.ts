import { describe, expect, it } from "vitest"
import type {
	SpectrumFrameEventData,
	SpectrumFrameTrackScanner,
} from "@wavekit/api-types"
import { TRACK_IDENTITY_LOG_INTERVAL_MS } from "../../../../src/core/spectrum/spectrum-service.js"
import type { SpectrumTrackIdentityLookup } from "../../../../src/core/spectrum/track-identity-contract.js"
import type { BlockSummary } from "../../../../src/core/spectrum/types.js"
import { richScenario } from "./frame-tracks-harness.js"
import { makeService } from "./frame-tracks-service-harness.js"

/** Built once at collection (outside any test's timeout): the pipeline run is the slow part. */
const SCENARIO = richScenario()
const RICH = SCENARIO.summaries
const IDENTITY: SpectrumFrameTrackScanner = {
	discoveryId: "d_01JABCDEFGHJKMNPQRSTVWXYZ0",
	protocol: "dmr",
	confidence: "decoded",
}

/** Summaries through a service; a source client subscribes with backfill half-way. */
async function run(
	lookup: SpectrumTrackIdentityLookup | null,
	opts: { logLines?: string[]; summaries?: readonly BlockSummary[] } = {},
) {
	const h = makeService(opts.logLines ? { logLines: opts.logLines } : {})
	h.service.setTrackIdentityLookup(lookup)
	await h.service.start()
	await h.service.acquire("rtl", "job:a")
	await h.service.subscribe("c-default", undefined)
	const sent: BlockSummary[] = []
	let epoch = 0
	for (const [i, s] of (opts.summaries ?? RICH).entries()) {
		if (s.epoch !== epoch) {
			h.host().epoch(s.epoch, epoch === 0)
			epoch = s.epoch
		}
		const copy = structuredClone({ ...s, stream: 0 })
		sent.push(copy)
		h.host().summary(copy)
		h.advance(50)
		if (i === 30)
			await h.service.subscribe("c-source", {
				sourceId: "rtl",
				hz: 5,
				bins: 2048,
				backfillMs: 5_000,
			})
	}
	const all: SpectrumFrameEventData[] = [
		...h.frames.map(f => f.frame),
		...h.profiles.flatMap(p => [...p.backfill, ...p.snapshots]),
	]
	return { h, all, sent }
}

const trackedIds = (summaries: readonly BlockSummary[]) =>
	new Set(summaries.flatMap(s => s.tracks.flatMap(t => t.trackId ?? [])))

describe("frame track scanner identity (req 5.1-5.3)", () => {
	it("attaches the lookup's identity to tracked tracks only, asked with the frame's source", async () => {
		const asked: [string, string][] = []
		const ids = trackedIds(RICH)
		const known = [...ids][0]!
		const { h, all, sent } = await run((sourceId, trackId) => {
			asked.push([sourceId, trackId])
			return sourceId === "rtl" && trackId === known ? IDENTITY : null
		})
		expect(asked.length).toBeGreaterThan(0)
		expect(asked.every(([s]) => s === "rtl")).toBe(true)
		expect(asked.every(([, t]) => ids.has(t))).toBe(true)
		let attached = 0
		for (const f of all)
			for (const t of f.tracks) {
				if (t.trackId === known) {
					expect(t.scanner).toEqual(IDENTITY)
					attached++
				} else expect(t.scanner).toBeUndefined()
			}
		expect(attached).toBeGreaterThan(0)
		// the summaries (ring, other profile groups) are never mutated
		expect(JSON.stringify(sent)).not.toContain('"scanner"')
		await h.service.stop()
	})

	it("calls the lookup once per tracked track per frame (live, snapshot and backfill)", async () => {
		let calls = 0
		const { h, all } = await run(() => {
			calls++
			return null
		})
		const expected = all.reduce(
			(n, f) => n + f.tracks.filter(t => t.trackId !== undefined).length,
			0,
		)
		expect(expected).toBeGreaterThan(0)
		expect(calls).toBe(expected)
		expect(all.some(f => f.backfill === true)).toBe(true)
		expect(all.some(f => f.snapshot === true)).toBe(true)
		await h.service.stop()
	})

	it("backfill and snapshot frames carry the identity looked up when sent", async () => {
		const { h, all } = await run(() => IDENTITY)
		const replayed = all.filter(f => f.backfill === true || f.snapshot === true)
		const tracked = replayed.flatMap(f =>
			f.tracks.filter(t => t.trackId !== undefined),
		)
		expect(tracked.length).toBeGreaterThan(0)
		expect(
			tracked.every(t => t.scanner?.discoveryId === IDENTITY.discoveryId),
		).toBe(true)
		await h.service.stop()
	})

	it("an identity for another source is never attached", async () => {
		const { h, all } = await run((sourceId, _trackId) =>
			sourceId === "other" ? IDENTITY : null,
		)
		expect(JSON.stringify(all)).not.toContain('"scanner"')
		await h.service.stop()
	})

	it("a throwing lookup gives frames identical to no lookup, and one fixed-text debug line", async () => {
		const base = await run(null)
		const lines: string[] = []
		const thrown = await run(
			(_s, trackId) => {
				throw new Error(`SECRET ${trackId} /etc/passwd`)
			},
			{ logLines: lines },
		)
		expect(JSON.stringify(thrown.all)).toBe(JSON.stringify(base.all))
		const debug = lines.filter(l => l.includes("track identity"))
		expect(debug).toHaveLength(1) // 3.1 s of frames: inside one minute
		expect(debug[0]).toContain("Spectrum track identity lookup failed")
		expect(debug[0]).not.toContain("SECRET")
		expect(debug[0]).not.toContain("passwd")
		for (const id of trackedIds(RICH)) expect(debug[0]).not.toContain(id)
		await base.h.service.stop()
		await thrown.h.service.stop()
	})

	it("refuses a malformed answer (unknown protocol or confidence, bad id, extra keys stripped)", async () => {
		const answers: unknown[] = [
			{ ...IDENTITY, protocol: "tetra" },
			{ ...IDENTITY, confidence: "certain" },
			{ ...IDENTITY, discoveryId: "" },
			{ ...IDENTITY, discoveryId: "x".repeat(37) },
			"dmr",
			42,
			undefined,
		]
		for (const answer of answers) {
			const lines: string[] = []
			const { h, all } = await run(
				(() => answer) as unknown as SpectrumTrackIdentityLookup,
				{ logLines: lines },
			)
			expect(JSON.stringify(all)).not.toContain('"scanner"')
			const debug = lines.filter(l => l.includes("track identity"))
			expect(debug).toHaveLength(1)
			expect(debug[0]).toContain("returned an invalid identity")
			expect(debug[0]).not.toContain("tetra")
			await h.service.stop()
		}
		const { h, all } = await run((() => ({
			...IDENTITY,
			label: "<script>",
		})) as SpectrumTrackIdentityLookup)
		const scanners = all.flatMap(f => f.tracks.flatMap(t => t.scanner ?? []))
		expect(scanners.length).toBeGreaterThan(0)
		expect(scanners.every(s => Object.keys(s).length === 3)).toBe(true)
		await h.service.stop()
	})

	it("rate-limits the debug line to one per minute (injected clock: at 59 999 ms none, at 60 000 ms one)", async () => {
		const lines: string[] = []
		const h = makeService({ logLines: lines })
		h.service.setTrackIdentityLookup(() => {
			throw new Error("boom")
		})
		await h.service.start()
		await h.service.acquire("rtl", "job:a")
		h.host().epoch(1, true)
		const tracked = RICH.find(
			s => s.epoch === 1 && s.tracks.some(t => t.trackId !== undefined),
		)!
		h.host().summary({ ...tracked, stream: 0 })
		const count = () => lines.filter(l => l.includes("track identity")).length
		h.service.status()
		expect(count()).toBe(1)
		h.advance(TRACK_IDENTITY_LOG_INTERVAL_MS - 1)
		h.service.status()
		expect(count()).toBe(1)
		h.advance(1)
		h.service.status()
		expect(count()).toBe(2)
		h.service.status()
		expect(count()).toBe(2)
		await h.service.stop()
	})

	it("cleared with null: no scanner field", async () => {
		const h = makeService()
		h.service.setTrackIdentityLookup(() => IDENTITY)
		h.service.setTrackIdentityLookup(null)
		await h.service.start()
		await h.service.acquire("rtl", "job:a")
		h.host().epoch(1, true)
		const tracked = RICH.find(s => s.tracks.some(t => t.trackId !== undefined))!
		h.host().summary({ ...tracked, stream: 0, epoch: 1 })
		const frame = h.service
			.status()
			.sources.find(s => s.sourceId === "rtl")?.latestFrame
		expect(frame?.tracks.some(t => t.trackId !== undefined)).toBe(true)
		expect(JSON.stringify(frame)).not.toContain('"scanner"')
		await h.service.stop()
	})
})

describe("track ids across epochs (req 5.3)", () => {
	it("the tracker never reuses an id: every open is a fresh id, and epoch 2 shares no id with epoch 1", () => {
		const { harness, summaries } = SCENARIO
		const opened = harness.of("track-open").map(e => e.track.trackId)
		expect(new Set(opened).size).toBe(opened.length)
		const byEpoch = (e: number) =>
			trackedIds(summaries.filter(s => s.epoch === e))
		const one = byEpoch(1)
		const two = byEpoch(2)
		expect(one.size).toBeGreaterThan(0)
		expect(two.size).toBeGreaterThan(0)
		for (const id of two) expect(one.has(id)).toBe(false)
		// a frame track's id is always one the tracker opened in that summary's epoch
		const epochOf = new Map(
			harness.of("track-open").map(e => [e.track.trackId, e.track.epoch]),
		)
		for (const s of summaries)
			for (const t of s.tracks)
				if (t.trackId !== undefined)
					expect(epochOf.get(t.trackId)).toBe(s.epoch)
	})

	it("an identity known for an epoch-1 track never lands on an epoch-2 frame", async () => {
		const one = trackedIds(RICH.filter(s => s.epoch === 1))
		const { h, all } = await run((_s, trackId) =>
			one.has(trackId) ? IDENTITY : null,
		)
		for (const f of all.filter(x => x.epoch === 2))
			expect(f.tracks.every(t => t.scanner === undefined)).toBe(true)
		expect(
			all.some(
				f => f.epoch === 1 && f.tracks.some(t => t.scanner !== undefined),
			),
		).toBe(true)
		await h.service.stop()
	})
})
