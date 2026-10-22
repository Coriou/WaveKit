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

	it("gate below or a non-finite channelSnrDb is stripped by sanitizeBlockTrack", () => {
		const kept = { ...TRACKED, gate: "passed" as const, channelSnrDb: -123.5 }
		expect(roundTrip([kept]).tracks[0]).toEqual(kept)
		const pending = { ...TRACKED, gate: "pending" as const, channelSnrDb: 0 }
		// pending + surfaced true is a contradiction: the gate owns surfacing.
		expect(roundTrip([pending]).tracks[0]).toEqual({
			...pending,
			surfaced: false,
		})
		const below = roundTrip([{ ...TRACKED, gate: "below", channelSnrDb: 6 }])
			.tracks[0]!
		expect("gate" in below).toBe(false)
		expect(below.surfaced).toBe(false)
		expect(below.channelSnrDb).toBe(6)
		expect(below.trackId).toBe(TRACKED.trackId)
		expect(below.startHz).toBe(1)
		for (const value of [Number.NaN, Infinity, -Infinity]) {
			const t = roundTrip([{ ...TRACKED, gate: "passed", channelSnrDb: value }])
				.tracks[0]!
			expect("channelSnrDb" in t, String(value)).toBe(false)
			expect(t.gate).toBe("passed")
			expect(t.trackId).toBe(TRACKED.trackId)
		}
		// No plan: the keys are absent and the bytes match the pre-gate track.
		const absent = roundTrip([TRACKED]).tracks[0]!
		expect(absent).toEqual(TRACKED)
		expect("gate" in absent).toBe(false)
		expect("channelSnrDb" in absent).toBe(false)
		expect(JSON.stringify(absent)).toBe(JSON.stringify(TRACKED))
	})

	it("drops hostile gate and channelSnrDb values without throwing", () => {
		const gates: unknown[] = [
			"below",
			"PASSED",
			"passed ",
			"",
			1,
			true,
			null,
			{},
			[],
			"pending\n",
		]
		for (const gate of gates) {
			const t = roundTrip([{ ...TRACKED, gate, channelSnrDb: 6.5 }]).tracks[0]!
			expect("gate" in t, JSON.stringify(gate)).toBe(false)
			expect(t.surfaced, JSON.stringify(gate)).toBe(false)
			expect(t.channelSnrDb).toBe(6.5)
			expect(t.trackId).toBe(TRACKED.trackId)
		}
		// Off the 0.5 dB grid or past ±999.5: not a frame value (R 2.6), so a
		// hostile finite cannot grow the track past the 40-byte gate budget.
		const snrs: unknown[] = [
			"12.5",
			"NaN",
			null,
			{},
			[],
			true,
			1e20,
			1e308,
			Number.MAX_VALUE,
			1000,
			-1000,
			12.2,
			-999.75,
			Number.NaN,
		]
		for (const channelSnrDb of snrs) {
			const t = roundTrip([{ ...TRACKED, gate: "pending", channelSnrDb }])
				.tracks[0]!
			expect("channelSnrDb" in t, String(channelSnrDb)).toBe(false)
			expect(t.gate).toBe("pending")
			expect(t.surfaced).toBe(false)
			expect(t.startHz).toBe(1)
		}
		const both = roundTrip([
			{ ...TRACKED, gate: "below", channelSnrDb: "nope" },
		]).tracks[0]!
		expect("gate" in both).toBe(false)
		expect("channelSnrDb" in both).toBe(false)
		expect(both.surfaced).toBe(false)
		expect(both.trackId).toBe(TRACKED.trackId)
	})

	it("a passed gate with unknown mask flags cannot leave surfaced true", () => {
		const cases: { flags: unknown; label: string }[] = [
			{ flags: { ...FLAGS, spur: "true" }, label: "string spur" },
			{
				flags: { ...FLAGS, spur: false, iqImage: "no" },
				label: "string iqImage",
			},
			{
				flags: { burst: false, edge: false, spur: false },
				label: "missing iqImage",
			},
			{
				flags: { burst: false, iqImage: false, edge: false },
				label: "missing spur",
			},
			{ flags: null, label: "null flags" },
		]
		for (const c of cases) {
			const t = roundTrip([
				{ ...TRACKED, gate: "passed", surfaced: true, flags: c.flags },
			]).tracks[0]
			if (t === undefined) continue
			expect(t.surfaced === true, c.label).toBe(false)
		}
	})

	it("a present gate cannot leave surfaced true unless it survived as passed", () => {
		// Hostile worker, through WorkerToMainSchema and decodeEventsFromWire.
		// False-safe: the surfaced key stays, and the value is false.
		const hostile: { gate: unknown; label: string }[] = [
			{ gate: "pending", label: "pending" },
			{ gate: "below", label: "below" },
			{ gate: null, label: "null" },
			{ gate: "nope", label: "string" },
			{ gate: 3, label: "number" },
		]
		for (const c of hostile) {
			const t = roundTrip([{ ...TRACKED, gate: c.gate, surfaced: true }])
				.tracks[0]!
			if (c.gate === "pending") expect(t.gate, c.label).toBe("pending")
			else expect("gate" in t, c.label).toBe(false)
			expect(t.surfaced, c.label).toBe(false)
		}
		const passed = roundTrip([{ ...TRACKED, gate: "passed", surfaced: true }])
			.tracks[0]!
		expect(passed.gate).toBe("passed")
		expect(passed.surfaced).toBe(true)
		const spur = roundTrip([
			{
				...TRACKED,
				gate: "passed",
				surfaced: true,
				flags: { ...FLAGS, spur: true },
			},
		]).tracks[0]!
		expect(spur.gate).toBe("passed")
		expect(spur.surfaced).toBe(false)
		const image = roundTrip([
			{
				...TRACKED,
				gate: "passed",
				surfaced: true,
				flags: { ...FLAGS, iqImage: true },
			},
		]).tracks[0]!
		expect(image.gate).toBe("passed")
		expect(image.surfaced).toBe(false)
		const absent = roundTrip([TRACKED]).tracks[0]!
		expect("gate" in absent).toBe(false)
		expect(absent.surfaced).toBe(true)
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
