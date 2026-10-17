import { afterAll, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import pino from "pino"
import { ThreadPipelineHost } from "../../../../src/core/spectrum/pipeline-host.js"
import { buildPipelineConfig } from "../../../../src/core/spectrum/spectrum-engine.js"
import {
	decodeEventsFromWire,
	encodeEventsForWire,
} from "../../../../src/core/spectrum/summary-wire.js"
import { WorkerToMainSchema } from "../../../../src/core/spectrum/worker-protocol.js"
import type {
	BlockSummary,
	BlockTrack,
	PipelineEvent,
} from "../../../../src/core/spectrum/types.js"
import { testSettings } from "../../../mocks/scanner/engine-fakes.js"

const FLAGS = { burst: false, iqImage: false, edge: false }
const TRACKED: BlockTrack = {
	startHz: 1,
	endHz: 2,
	flags: { ...FLAGS, spur: false },
	trackId: "mguu1x2s-1",
	snrDb: 12.5,
	peakDbfs: -40.5,
	blocks: 3,
	ageMs: 150,
	surfaced: true,
}
const UNTRACKED: BlockTrack = { startHz: 3, endHz: 4, flags: FLAGS }

function summary(tracks: unknown[]): BlockSummary {
	return {
		sourceId: "rtl",
		stream: 0,
		epoch: 1,
		endSample: 0,
		centreHz: 1,
		sampleRateHz: 1,
		binHz: 1,
		startHz: 0,
		bins: [-90, -80.5],
		floorDbfs: -90,
		thresholdDb: 6,
		tracks: tracks as BlockTrack[],
		masks: { dcHz: 1, dcGuardHz: 0, spurRanges: [] },
		floorOccupied: false,
		overload: false,
	}
}

/** Worker encode → structured clone (postMessage) → host schema → host decode. */
function roundTrip(tracks: unknown[]): BlockSummary {
	const events: PipelineEvent[] = [
		{ kind: "block-summary", summary: summary(tracks) },
	]
	const transfer: ArrayBuffer[] = []
	encodeEventsForWire(events, transfer)
	const cloned = structuredClone({ type: "events", events }, { transfer })
	const parsed = WorkerToMainSchema.safeParse(cloned)
	if (!parsed.success || parsed.data.type !== "events")
		throw new Error("schema refused the message")
	decodeEventsFromWire(parsed.data.events)
	const ev = parsed.data.events[0]
	if (ev?.kind !== "block-summary") throw new Error("kind")
	return ev.summary
}

describe("WG11 frame-track fields across the worker (req 5.1, 5.5)", () => {
	it("carries the fields unchanged and an untracked segment stays bare", () => {
		const s = roundTrip([TRACKED, UNTRACKED])
		expect(s.tracks).toEqual([TRACKED, UNTRACKED])
		expect(JSON.stringify(s.tracks[1])).toBe(JSON.stringify(UNTRACKED))
		expect(s.bins).toEqual([-90, -80.5])
	})

	it("carries the host-internal trackerId of a rolled-over chain; drops a hostile or orphan one (MAJ3)", () => {
		const rolled = { ...TRACKED, trackerId: "mguu1x2s-5" }
		expect(roundTrip([rolled]).tracks).toEqual([rolled])
		for (const bad of ["x".repeat(31), "", 5, null, 'a"b', ["a"]]) {
			const t = roundTrip([{ ...TRACKED, trackerId: bad }]).tracks[0]!
			expect("trackerId" in t).toBe(false)
			expect(t.trackId).toBe(TRACKED.trackId)
		}
		// without a valid chain id the internal id goes with every other WG11 field
		const orphan = roundTrip([
			{ ...TRACKED, trackId: 12, trackerId: "mguu1x2s-5" },
		]).tracks[0]!
		expect(orphan).toEqual(UNTRACKED_AT(1, 2))
	})

	it("drops a hostile field, never the summary or the track", () => {
		const hostile: [string, unknown][] = [
			["snrDb", Number.NaN],
			["snrDb", Infinity],
			["peakDbfs", -Infinity],
			["peakDbfs", "-40"],
			["blocks", -3],
			["blocks", 2.5],
			["blocks", 1e12],
			["ageMs", -1],
			["ageMs", { n: 1 }],
			["surfaced", "yes"],
		]
		for (const [key, value] of hostile) {
			const s = roundTrip([{ ...TRACKED, [key]: value }, UNTRACKED])
			expect(s.tracks).toHaveLength(2)
			const t = s.tracks[0]!
			expect(key in t, key).toBe(false)
			expect(t.trackId).toBe(TRACKED.trackId)
			expect(t.startHz).toBe(1)
		}
	})

	it("an oversized, non-string or escaping trackId strips every WG11 field of that track", () => {
		for (const id of ["x".repeat(10_000), 12, null, 'a"},{"x', ["a"]]) {
			const s = roundTrip([{ ...TRACKED, trackId: id }])
			expect(s.tracks[0]).toEqual(UNTRACKED_AT(1, 2))
		}
	})

	it("a scanner field and a contradictory surfaced are dropped", () => {
		const s = roundTrip([
			{
				...TRACKED,
				flags: { ...FLAGS, spur: true },
				scanner: { discoveryId: "d_1", protocol: "dmr", confidence: "decoded" },
			},
		])
		const t = s.tracks[0]!
		expect("scanner" in t).toBe(false)
		expect("surfaced" in t).toBe(false)
		expect(t.flags.spur).toBe(true)
	})

	it("non-object tracks are left as they are (the frame guard's business, as today)", () => {
		const s = roundTrip([42, null, TRACKED])
		expect(s.tracks).toEqual([42, null, TRACKED])
	})
})

function UNTRACKED_AT(startHz: number, endHz: number): BlockTrack {
	return { startHz, endHz, flags: FLAGS }
}

const dir = mkdtempSync(join(tmpdir(), "wavekit-tr-wire-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

/** A stand-in worker posting one summary with a hostile frame track over a real MessagePort. */
const FAKE = `
import { parentPort } from "node:worker_threads"
const summary = tracks => ({ sourceId: "rtl", stream: 0, epoch: 1, endSample: 0, centreHz: 1, sampleRateHz: 1, binHz: 1, startHz: 0, bins: [-90], floorDbfs: -90, thresholdDb: 6, tracks, masks: { dcHz: 1, dcGuardHz: 0, spurRanges: [] }, floorOccupied: false, overload: false })
parentPort.on("message", m => {
	if (m.type === "init") {
		parentPort.postMessage({ type: "events", events: [{ kind: "block-summary", summary: summary([
			{ startHz: 1, endHz: 2, flags: { burst: false, iqImage: false, edge: false, spur: false }, trackId: "rtl-1", snrDb: NaN, peakDbfs: -40.5, blocks: -1, ageMs: 50, surfaced: true },
			{ startHz: 3, endHz: 4, flags: { burst: false, iqImage: false, edge: false } },
		]) }] })
		parentPort.postMessage({ type: "error", message: "done" })
	}
	if (m.type === "close") parentPort.close()
})
`

describe("ThreadPipelineHost frame-track decode", () => {
	it("delivers the summary with the malformed fields dropped", async () => {
		const file = join(dir, "fake-worker.mjs")
		writeFileSync(file, FAKE)
		const cfg = buildPipelineConfig(
			"rtl",
			"U8_IQ",
			1_024_000,
			testSettings(),
			{
				fftSize: null,
				integrationMs: null,
				thresholdDb: null,
				sensitivity: null,
			},
			undefined,
			2048,
		)
		const events: PipelineEvent[] = []
		const errors: Error[] = []
		const host = new ThreadPipelineHost(
			cfg,
			{
				events: evs => events.push(...evs),
				buffer: () => undefined,
				error: err => errors.push(err),
			},
			pathToFileURL(file),
			pino({ level: "silent" }),
		)
		const deadline = Date.now() + 3000
		while (errors.length === 0 && Date.now() < deadline)
			await new Promise(r => setTimeout(r, 10))
		await host.close()
		expect(events).toHaveLength(1)
		const ev = events[0]
		if (ev?.kind !== "block-summary") throw new Error("kind")
		expect(ev.summary.tracks).toEqual([
			{
				startHz: 1,
				endHz: 2,
				flags: { ...FLAGS, spur: false },
				trackId: "rtl-1",
				peakDbfs: -40.5,
				ageMs: 50,
				surfaced: true,
			},
			{ startHz: 3, endHz: 4, flags: FLAGS },
		])
	})
})
