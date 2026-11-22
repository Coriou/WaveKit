/**
 * Recording admission in the wideband analog recorder (W1, scanner.admission): a data buzz on a
 * channel with no digital evidence (prior `none`, kept at once before) ends `discarded:noise` at
 * its finish: counted in the decision counts and `recent`, its operation cancelled (the .wav.part
 * never linked, so no final WAV) and one `Analog file discarded as noise` line logged with ids and
 * numbers only. Admission off keeps it as before; a syllabic voice with carrier quieting, a
 * buzz over its own CTCSS tone, or a buzz file sharing another discovery's joined voice, is kept. All signals are modelled (synthetic).
 */
import { Writable } from "node:stream"
import pino from "pino"
import { describe, expect, it } from "vitest"
import type { VoicePrior } from "../../../../src/core/scanner/channel/recording-verdict.js"
import {
	LOW_FS,
	LOW_OFFSET,
	harness,
	input,
	snapshot,
} from "./wideband-recorder-harness.js"
import { FskSource } from "./wideband-nfm-fixtures.js"

type Harness = ReturnType<typeof harness>

const LOW = { centreHz: 100_000_000 + LOW_OFFSET }
/** No digital evidence, no analog proof: prior strength `none` (kept at once before admission). */
const analogFm: VoicePrior = {
	labels: [],
	class: "analog-fm",
	analogVoice: () => false,
}

const codes = (h: Harness): string[] =>
	h.rec.diagnostics().recent.map(d => d.code)

function capture(): { logger: pino.Logger; lines: Record<string, unknown>[] } {
	const lines: Record<string, unknown>[] = []
	const sink = new Writable({
		write(chunk: Buffer, _enc, done) {
			for (const line of chunk.toString().split("\n"))
				if (line.trim() !== "")
					lines.push(JSON.parse(line) as Record<string, unknown>)
			done()
		},
	})
	return { logger: pino({ level: "info" }, sink), lines }
}

const low = (
	more: {
		admission?: boolean
		ctcssHz?: number | null
		syllables?: boolean
		logger?: pino.Logger
		prior?: VoicePrior
	} = {},
): Harness =>
	harness({
		fs: LOW_FS,
		offset: LOW_OFFSET,
		source: {
			ctcssHz: more.ctcssHz ?? null,
			syllables: more.syllables ?? false,
		},
		decodedLabel: () => null,
		voicePrior: () => more.prior ?? analogFm,
		...(more.admission !== undefined ? { admission: more.admission } : {}),
		...(more.logger ? { logger: more.logger } : {}),
	})

/**
 * One analog-fm over of `seconds` by "o" (classed by its snapshots), closed, then quiet: a
 * modelled 4FSK buzz (4 800 Bd, DMR-like deviation, plus the source's CTCSS when `ctcssHz`) or
 * the harness's own source (`voice`).
 */
async function over(
	h: Harness,
	seconds: number,
	voice: boolean,
): Promise<void> {
	const fsk = new FskSource({
		fs: h.fs,
		offsetHz: LOW_OFFSET,
		levelsHz: [-1_944, -648, 648, 1_944],
	})
	const chunk = h.fs / 40
	await h.feed(1, false)
	const onset = h.engine.liveEdge()
	const end = onset + seconds * h.fs
	for (let i = 0; i < seconds * 40; i++) {
		h.engine.write(voice ? h.src.next(chunk, true) : fsk.next(chunk, true))
		const edge = h.engine.liveEdge()
		if (edge - onset >= 0.1 * h.fs)
			h.rec.track(input("o", snapshot("o", onset, Math.min(edge, end), LOW)))
		await h.pump()
	}
	await h.feed(0.6, false)
	h.rec.closed("o", snapshot("o", onset, end, LOW), null, {
		analogFm: true,
		discoveryId: "d_1",
	})
	await h.feed(3.5, false)
	await h.rec.idle()
}

describe("W1 recording admission: noise on a channel with no digital evidence", () => {
	// Feature: recording-admission, candidate rule RA-2 (W1 integration).
	it("a 6 s data buzz: discarded:noise, counted, in recent, no final WAV, one noise log line", async () => {
		const { logger, lines } = capture()
		const h = low({ logger })
		await over(h, 6, false)
		expect(codes(h)).toContain("discarded:noise")
		expect(h.rec.diagnostics().counts["discarded:noise"]).toBe(1)
		expect(h.ops.map(o => o.outcome)).not.toContain("finalized")
		expect(h.ops.map(o => o.cancelled)).toEqual(["cancelled"])
		const noise = lines.filter(
			l => l["msg"] === "Analog file discarded as noise",
		)
		expect(noise).toHaveLength(1)
		expect(noise[0]).toMatchObject({
			discoveryId: "d_1",
			reason: "noise",
			strength: "none",
		})
		expect(noise[0]!["p10Dbfs"] as number).toBeGreaterThan(-25)
		expect(noise[0]!["spreadDb"] as number).toBeLessThan(10)
		expect(lines.some(l => l["msg"] === "Analog file kept")).toBe(false)
	}, 120_000)

	it("admission off (scanner.admission.enabled false): the same buzz is kept at once, as before", async () => {
		const h = low({ admission: false })
		await over(h, 6, false)
		expect(codes(h)).not.toContain("discarded:noise")
		expect(h.ops.map(o => o.outcome)).toEqual(["finalized"])
	}, 120_000)

	it("FROZEN: a syllabic voice (carrier quieting between syllables, no CTCSS): kept", async () => {
		const h = low({ syllables: true })
		await over(h, 6, true)
		expect(codes(h)).not.toContain("discarded:noise")
		expect(h.ops.map(o => o.outcome)).toEqual(["finalized"])
	}, 120_000)

	it("FROZEN: a voice over its own CTCSS tone is never measured as noise: kept", async () => {
		const h = low({ ctcssHz: 88.5 })
		await over(h, 6, true)
		expect(codes(h)).not.toContain("discarded:noise")
		expect(h.ops.map(o => o.outcome)).toEqual(["finalized"])
	}, 120_000)

	it("FROZEN: joined voice of another discovery over this file's buzz (admission on): kept, joined", async () => {
		const { logger, lines } = capture()
		const h = low({
			logger,
			prior: {
				...analogFm,
				channelObservation: () => false,
				knownObservation: () => true,
			},
		})
		await joinedOver(h, 6)
		expect(codes(h)).not.toContain("discarded:noise")
		expect(h.ops.map(o => o.outcome)).toEqual(["finalized"])
		const kept = lines.filter(l => l["msg"] === "Analog file kept")
		expect(kept).toHaveLength(1)
		expect(kept[0]).toMatchObject({ joinedOther: true })
		expect(lines.some(l => l["msg"] === "Analog file discarded as noise")).toBe(
			false,
		)
	}, 120_000)
})

/**
 * `over` with a modelled 4FSK buzz whose middle is also tracked as observation "j" (classed
 * analog-fm by its snapshots, joined to the session): another discovery's transmission on the
 * channel, its voice on the air in this file.
 */
async function joinedOver(h: Harness, seconds: number): Promise<void> {
	const fsk = new FskSource({
		fs: h.fs,
		offsetHz: LOW_OFFSET,
		levelsHz: [-1_944, -648, 648, 1_944],
	})
	const chunk = h.fs / 40
	await h.feed(1, false)
	const onset = h.engine.liveEdge()
	const end = onset + seconds * h.fs
	let jOnset = 0
	for (let i = 0; i < seconds * 40; i++) {
		h.engine.write(fsk.next(chunk, true))
		const edge = h.engine.liveEdge()
		if (edge - onset >= 0.1 * h.fs)
			h.rec.track(input("o", snapshot("o", onset, Math.min(edge, end), LOW)))
		if (edge - onset >= h.fs) {
			if (jOnset === 0) jOnset = edge
			h.rec.track(input("j", snapshot("j", jOnset, edge, LOW)))
		}
		await h.pump()
	}
	await h.feed(0.6, false)
	h.rec.closed("j", snapshot("j", jOnset, end, LOW), null, {
		analogFm: true,
		discoveryId: "d_2",
	})
	h.rec.closed("o", snapshot("o", onset, end, LOW), null, {
		analogFm: true,
		discoveryId: "d_1",
	})
	await h.feed(3.5, false)
	await h.rec.idle()
}
