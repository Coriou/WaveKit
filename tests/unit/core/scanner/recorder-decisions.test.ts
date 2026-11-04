/**
 * The analog recorder's decision log: reason codes, the info log's rate limit, the bounded ring and
 * observation memory, and the codes the recorder gives on its real paths (synthetic signals).
 */
import { Writable } from "node:stream"
import pino from "pino"
import { describe, expect, it } from "vitest"
import {
	RECORDER_MAX_OBSERVATIONS,
	RECORDER_RECENT_DECISIONS,
	RECORDER_RECENT_REFUSALS,
	SCANNER_RECORDER_DECISIONS,
} from "@wavekit/api-types"
import {
	RECORDER_LOG_LIMIT,
	RECORDER_LOG_WINDOW_MS,
	RecorderDecisions,
} from "../../../../src/core/scanner/channel/recorder-decisions.js"
import {
	LOW,
	LOW_FS,
	LOW_OFFSET,
	harness,
	input,
	snapshot,
	transmission,
} from "./wideband-recorder-harness.js"

function capture(level: "info" | "debug" = "info") {
	const lines: Record<string, unknown>[] = []
	const stream = new Writable({
		write(chunk: Buffer, _enc, done) {
			for (const line of chunk.toString().split("\n"))
				if (line.trim() !== "")
					lines.push(JSON.parse(line) as Record<string, unknown>)
			done()
		},
	})
	return { lines, logger: pino({ level }, stream) }
}

const flushLogs = () => new Promise(r => setImmediate(r))

const ref = (n: number, discoveryId: string | null = null) => ({
	sourceId: "rtl",
	observationId: `o_${n}`,
	discoveryId,
})

describe("RecorderDecisions", () => {
	it("logs RECORDER_LOG_LIMIT (20) decisions per 60 s window at info; the 21st is counted, and the next window's first line carries it", async () => {
		const { lines, logger } = capture()
		let now = 1_000_000
		const d = new RecorderDecisions(logger, () => now)
		for (let i = 0; i < RECORDER_LOG_LIMIT; i++) d.note("started", ref(i), true)
		await flushLogs()
		expect(lines).toHaveLength(20)
		d.note("started", ref(20), true)
		d.note("started", ref(21), true)
		await flushLogs()
		expect(lines).toHaveLength(20)
		expect(d.status().logsSuppressed).toBe(2)
		// One ms before the window ends: still suppressed.
		now += RECORDER_LOG_WINDOW_MS - 1
		d.note("started", ref(22), true)
		await flushLogs()
		expect(lines).toHaveLength(20)
		now += 1
		d.note("started", ref(23), true)
		await flushLogs()
		expect(lines).toHaveLength(21)
		expect(lines[20]).toMatchObject({
			level: 30,
			decision: "started",
			observationId: "o_23",
			suppressed: 3,
			msg: "Analog recorder decision",
		})
		// Only the code, the source and the core's ids are logged.
		expect(Object.keys(lines[0]!).sort()).toEqual(
			[
				"decision",
				"discoveryId",
				"hostname",
				"level",
				"msg",
				"observationId",
				"pid",
				"sourceId",
				"time",
			].sort(),
		)
		// Every decision is still counted and kept, logged or not.
		expect(d.status().counts.started).toBe(24)
	})

	it("a refusal repeating the observation's last decision is no new decision; other codes always count", () => {
		const d = new RecorderDecisions(pino({ level: "silent" }), () => 0)
		d.note("refused:slots", ref(1))
		d.note("refused:slots", ref(1))
		d.note("refused:cpu", ref(1))
		d.note("refused:slots", ref(1))
		d.note("finalized", ref(1), true)
		d.note("finalized", ref(1), true)
		expect(d.status().counts).toEqual({
			"refused:slots": 2,
			"refused:cpu": 1,
			finalized: 2,
		})
		expect(d.status().recentRefusals.map(e => e.code)).toEqual([
			"refused:slots",
			"refused:cpu",
			"refused:slots",
		])
		expect(d.status().recent.map(e => e.code)).toEqual([
			"finalized",
			"finalized",
		])
	})

	it("a repeated refusal binds the discovery it now carries, without counting or logging again", async () => {
		const { lines, logger } = capture("debug")
		const d = new RecorderDecisions(logger, () => 0)
		d.note("refused:cpu", ref(1))
		expect(d.forDiscovery("d_1")).toBeNull()
		d.note("refused:cpu", ref(1, "d_1"))
		await flushLogs()
		expect(lines).toHaveLength(1)
		expect(d.status().counts).toEqual({ "refused:cpu": 1 })
		expect(d.forDiscovery("d_1")).toMatchObject({
			last: { code: "refused:cpu", observationId: "o_1", discoveryId: "d_1" },
			counts: { "refused:cpu": 1 },
		})
	})

	it("a session's repeated decision is a new decision (two files refused by the store count twice)", () => {
		const d = new RecorderDecisions(pino({ level: "silent" }), () => 0)
		d.note("refused:store", ref(1, "d_1"), true)
		d.note("refused:store", ref(1, "d_1"), true)
		expect(d.status().counts).toEqual({ "refused:store": 2 })
		expect(d.status().recent).toHaveLength(2)
	})

	it(`keeps the last RECORDER_RECENT_DECISIONS (${RECORDER_RECENT_DECISIONS}) session decisions, newest last`, () => {
		const d = new RecorderDecisions(pino({ level: "silent" }), () => 0)
		for (let i = 0; i < RECORDER_RECENT_DECISIONS; i++)
			d.note("started", ref(i), true)
		expect(d.status().recent).toHaveLength(64)
		expect(d.status().recent[0]!.observationId).toBe("o_0")
		d.note("started", ref(64), true)
		expect(d.status().recent).toHaveLength(64)
		expect(d.status().recent[0]!.observationId).toBe("o_1")
		expect(d.status().recent[63]!.observationId).toBe("o_64")
	})

	it(`keeps the last RECORDER_RECENT_REFUSALS (${RECORDER_RECENT_REFUSALS}) snapshot refusals apart, newest last`, () => {
		const d = new RecorderDecisions(pino({ level: "silent" }), () => 0)
		for (let i = 0; i < RECORDER_RECENT_REFUSALS; i++)
			d.note("refused:not-analog", ref(i))
		expect(d.status().recentRefusals).toHaveLength(32)
		expect(d.status().recentRefusals[0]!.observationId).toBe("o_0")
		d.note("refused:tuning", ref(32))
		expect(d.status().recentRefusals).toHaveLength(32)
		expect(d.status().recentRefusals[0]!.observationId).toBe("o_1")
		expect(d.status().recentRefusals[31]!.observationId).toBe("o_32")
		expect(d.status().recent).toEqual([])
		expect(d.status().counts).toEqual({
			"refused:not-analog": 32,
			"refused:tuning": 1,
		})
	})

	it("a flood of snapshot refusals never pushes a session decision out of recent or the info log; refusals are logged at debug", async () => {
		const { lines, logger } = capture("debug")
		const d = new RecorderDecisions(logger, () => 0)
		d.note("started", ref(0, "d_0"), true)
		d.note("voiced", ref(0, "d_0"), true)
		// 1000 tracks refused once each (a busy band: not analog, or of the previous epoch).
		for (let i = 1; i <= 1_000; i++)
			d.note(i % 2 === 0 ? "refused:not-analog" : "refused:tuning", ref(i))
		d.note("finalized", ref(0, "d_0"), true)
		await flushLogs()
		expect(d.status().recent.map(e => e.code)).toEqual([
			"started",
			"voiced",
			"finalized",
		])
		expect(d.status().recentRefusals).toHaveLength(RECORDER_RECENT_REFUSALS)
		const info = lines.filter(l => l["level"] === 30)
		const debug = lines.filter(l => l["level"] === 20)
		expect(info.map(l => l["decision"])).toEqual([
			"started",
			"voiced",
			"finalized",
		])
		expect(debug).toHaveLength(1_000)
		expect(debug[0]).toMatchObject({ msg: "Analog recorder snapshot refusal" })
		expect(d.status().logsSuppressed).toBe(0)
	})

	it(`remembers RECORDER_MAX_OBSERVATIONS (${RECORDER_MAX_OBSERVATIONS}) observations for discovery reads, least recent dropped`, () => {
		const d = new RecorderDecisions(pino({ level: "silent" }), () => 0)
		for (let i = 0; i < RECORDER_MAX_OBSERVATIONS; i++)
			d.note("started", ref(i, `d_${i}`))
		expect(d.forDiscovery("d_0")).not.toBeNull()
		// o_0 is used again: o_1 is now the least recent.
		d.note("voiced", ref(0, "d_0"))
		d.note("started", ref(RECORDER_MAX_OBSERVATIONS, "d_new"))
		expect(d.forDiscovery("d_0")).not.toBeNull()
		expect(d.forDiscovery("d_1")).toBeNull()
		expect(d.forDiscovery("d_new")).not.toBeNull()
	})

	it("a discovery read sums its observations and names the newest decision; a shadow's decisions join once its discovery is known", () => {
		let now = Date.UTC(2026, 10, 3, 4, 0, 0)
		const d = new RecorderDecisions(pino({ level: "silent" }), () => now)
		d.note("shadow", ref(1))
		expect(d.forDiscovery("d_1")).toBeNull()
		d.bindDiscovery("o_1", "d_1")
		now += 1_000
		d.note("classed", ref(1, "d_1"))
		now += 1_000
		d.note("refused:cpu", ref(2, "d_1"))
		d.note("started", ref(3, "d_other"))
		expect(d.forDiscovery("d_1")).toEqual({
			last: {
				code: "refused:cpu",
				at: new Date(now).toISOString(),
				sourceId: "rtl",
				observationId: "o_2",
				discoveryId: "d_1",
			},
			counts: { shadow: 1, classed: 1, "refused:cpu": 1 },
		})
	})

	it("an unclean detail rides its decision to the status, the discovery read and the log; a decision without one has no field", async () => {
		const { lines, logger } = capture()
		const d = new RecorderDecisions(logger, () => 1_000)
		const detail = {
			flag: "iq-image",
			raisedBy: "close",
			atMs: 12_500,
			flagged: 3,
			snapshots: 140,
			kept: true,
		} as const
		d.note("started", ref(1, "d_1"), true)
		d.note("finalized", ref(1, "d_1"), true, detail)
		const recent = d.status().recent
		expect(recent[0]).not.toHaveProperty("unclean")
		expect(recent[1]!.unclean).toEqual(detail)
		// A copy: the caller's object changing later does not change what was noted.
		expect(recent[1]!.unclean).not.toBe(detail)
		expect(d.forDiscovery("d_1")?.last.unclean).toEqual(detail)
		await flushLogs()
		expect(lines.at(-1)).toMatchObject({
			decision: "finalized",
			uncleanFlag: "iq-image",
			uncleanRaisedBy: "close",
			uncleanAtMs: 12_500,
			uncleanFlagged: 3,
			uncleanSnapshots: 140,
			uncleanKept: true,
		})
		expect(lines[0]).not.toHaveProperty("uncleanFlag")
	})

	it("every code is a closed string of the form name or kind:why", () => {
		for (const code of SCANNER_RECORDER_DECISIONS)
			expect(code).toMatch(/^(?:[a-z]+|(?:refused|discarded):[a-z-]+)$/)
	})
})

describe("WidebandAnalogRecorder decisions (synthetic signals)", () => {
	it("a voice recorded whole: started, voiced, finalized; the status shows the live session, then the decisions", async () => {
		const h = harness()
		await h.feed(0.5, false)
		const onset = h.engine.liveEdge()
		await h.feed(2, true, () =>
			h.rec.track(input("o", snapshot("o", onset, h.engine.liveEdge()))),
		)
		const live = h.rec.diagnostics()
		expect(live.sessions).toHaveLength(1)
		expect(live.sessions[0]).toMatchObject({
			sourceId: "rtl",
			observationId: "o",
			discoveryId: "d_1",
			state: "voiced",
			writing: true,
		})
		expect(live.sessions[0]!.backlogMs).toBeGreaterThanOrEqual(0)
		const end = h.engine.liveEdge()
		await h.feed(0.6, false)
		h.rec.closed("o", snapshot("o", onset, end), null)
		await h.feed(3, false)
		await h.rec.idle()
		const st = h.rec.diagnostics()
		expect(st.sessions).toEqual([])
		expect(st.recent.map(e => e.code)).toEqual([
			"started",
			"voiced",
			"finalized",
		])
		expect(h.rec.discoveryDecisions("d_1")?.last.code).toBe("finalized")
		expect(h.ops[0]!.outcome).toBe("finalized")
	}, 60_000)

	it("a classed carrier that never sounds like voice: never voice for a sweep, discarded:unvoiced after 8 s in the track", async () => {
		const h = harness({
			fs: LOW_FS,
			offset: LOW_OFFSET,
			source: { voice: false },
		})
		await h.feed(0.5, false)
		const onset = h.engine.liveEdge()
		const seen = new Set<string>()
		// WIDEBAND_QUALIFY_MS (8 s) of in-track audio, judged a holdback (1 s) late, and a margin.
		await h.feed(10, true, () => {
			h.rec.track(input("c", snapshot("c", onset, h.engine.liveEdge(), LOW)))
			seen.add(
				JSON.stringify(h.rec.recordingActive("rtl", { stream: 1, epoch: 1 })),
			)
		})
		expect([...seen]).toEqual(["false"])
		expect(h.rec.diagnostics().recent.map(e => e.code)).toEqual([
			"started",
			"discarded:unvoiced",
		])
		expect(h.ops).toHaveLength(0)
	}, 60_000)

	it("a full CPU budget: refused:cpu once however many snapshots retry; then started when it frees", async () => {
		let full = true
		const h = harness({ reserveCores: () => (full ? null : () => undefined) })
		await h.feed(0.5, false)
		const onset = h.engine.liveEdge()
		const report = () =>
			h.rec.track(input("o", snapshot("o", onset, h.engine.liveEdge())))
		await h.feed(0.5, true, report)
		expect(h.rec.diagnostics().counts).toEqual({ "refused:cpu": 1 })
		full = false
		await h.feed(0.1, true, report)
		expect(h.rec.diagnostics().recentRefusals?.map(e => e.code)).toEqual([
			"refused:cpu",
		])
		expect(h.rec.diagnostics().recent.map(e => e.code)).toEqual(["started"])
	}, 60_000)

	it("a refused observation associated only on a later snapshot, or only at its close, names its refusal on the discovery", async () => {
		const h = harness({ reserveCores: () => null })
		await h.feed(0.2, false)
		const onset = h.engine.liveEdge()
		await h.feed(0.2, true)
		const track = snapshot("x", onset, h.engine.liveEdge())
		// Refused while unassociated, then the same refusal once the store associated it.
		h.rec.track(input("c", track, { discoveryId: null }))
		h.rec.track(input("c", track, { discoveryId: "d_cpu" }))
		expect(h.rec.discoveryDecisions("d_cpu")).toMatchObject({
			last: { code: "refused:cpu", observationId: "c" },
			counts: { "refused:cpu": 1 },
		})
		// Refused (no class, no shadow) and associated only by its closing snapshot.
		h.rec.track(input("n", track, { discoveryId: null, analogFm: false }))
		expect(h.rec.discoveryDecisions("d_close")).toBeNull()
		h.rec.closed("n", track, null, { analogFm: false, discoveryId: "d_close" })
		expect(h.rec.discoveryDecisions("d_close")).toMatchObject({
			last: { code: "refused:not-analog", observationId: "n" },
		})
	})

	it("encrypted, opted out and non-analog snapshots get their own refusal codes", async () => {
		const h = harness()
		await h.feed(0.2, false)
		const onset = h.engine.liveEdge()
		await h.feed(0.2, true)
		const track = snapshot("x", onset, h.engine.liveEdge())
		h.rec.track(input("e", track, { encrypted: true }))
		h.rec.track(input("r", track, { recordAllowed: false }))
		h.rec.track(input("n", track, { analogFm: false, nonAnalog: true }))
		expect(
			h.rec.diagnostics().recentRefusals?.map(e => [e.observationId, e.code]),
		).toEqual([
			["e", "refused:encrypted"],
			["r", "refused:record-disabled"],
			["n", "refused:not-analog"],
		])
	})

	it("an encrypted close discards a recording in progress: refused:encrypted is its last decision", async () => {
		const h = harness()
		await h.feed(0.5, false)
		await transmission(h, "o", 2)
		// transmission() closed it cleanly; a second one closes encrypted.
		await h.feed(3, false)
		const onset = h.engine.liveEdge()
		await h.feed(2, true, () =>
			h.rec.track(input("p", snapshot("p", onset, h.engine.liveEdge()))),
		)
		const end = h.engine.liveEdge()
		h.rec.closed("p", snapshot("p", onset, end), null, {
			analogFm: true,
			discoveryId: "d_1",
			encrypted: true,
		})
		await h.feed(1, false)
		const codes = h.rec
			.diagnostics()
			.recent.filter(e => e.observationId === "p")
			.map(e => e.code)
		expect(codes.at(-1)).toBe("refused:encrypted")
	}, 60_000)
})

it("keeps receipt details in status, discovery detail and logs", async () => {
	const { lines, logger } = capture()
	const decisions = new RecorderDecisions(logger, () => 0)
	const receipt = {
		outcome: "failed" as const,
		errorCode: "write-failed",
		operationId: "op-test",
	}
	decisions.note("discarded:aborted", ref(1, "d"), true, null, receipt)
	expect(decisions.status().recent[0]?.receipt).toEqual(receipt)
	expect(decisions.forDiscovery("d")?.last.receipt).toEqual(receipt)
	await flushLogs()
	expect(lines[0]).toMatchObject({
		receiptOutcome: "failed",
		receiptErrorCode: "write-failed",
		operationId: "op-test",
	})
})
