import { beforeAll, describe, expect, it } from "vitest"
import { laneOk } from "../../../cli/source/data/freshness.js"
import { processState } from "../../../cli/source/data/decoder-state.js"
import { guardDecoder } from "../../../cli/source/data/guards.js"
import type {
	BandAssessment,
	DecoderRow,
} from "../../../cli/source/data/types.js"
import {
	decoderMembership,
	retuneImpact,
	windowFor,
	type TunedWindow,
} from "../../../cli/source/data/window.js"
import { scenarioState } from "../../../cli/source/test/fixtures.js"
import { findBanned } from "../../../cli/source/ui/copy-rules.js"
import { lineText } from "../../../cli/source/ui/text.js"
import {
	decoderCells,
	decoderFacts,
} from "../../../cli/source/view-models/decoder-rows.js"
import { decoderDetail } from "../../../cli/source/view-models/decoders.js"

beforeAll(() => {
	process.env["TZ"] = "UTC"
})

// The live scenario tunes pi-iq to 445.9707 MHz at 2.048 MS/s.
const NOW = Date.parse("2026-10-08T18:07:52Z")
const CENTRE = 445_970_700
const base = scenarioState("live")
const liveRow = (id: string): DecoderRow =>
	base.decoders.value!.find(d => d.id === id)!

const stateWith = (rows: DecoderRow[]) => ({
	...base,
	now: NOW,
	decoders: laneOk(rows, NOW - 1000, "rest"),
})
const facts = (r: DecoderRow) => decoderFacts(stateWith([r]))[0]!
const cellText = (r: DecoderRow, id: string) =>
	(decoderCells(facts(r), NOW)[id]?.variants ?? []).map(lineText)
const detail = (r: DecoderRow) => {
	const st = stateWith([r])
	return decoderDetail(st, decoderFacts(st)[0]!, 120, st.now)
		.map(lineText)
		.join("\n")
}
const member = (r: DecoderRow) =>
	decoderMembership(r, base.sources.value, base.tuner.value, base.relay.value)

const raw = (over: Record<string, unknown>): Record<string, unknown> => ({
	id: "readsb",
	type: "readsb",
	running: true,
	health: "running",
	uptime: 10,
	stats: { bytesIn: 1, eventsOut: 1, errors: 0 },
	restartCount: 0,
	...over,
})

describe("R84 bandAssessment guard", () => {
	it("keeps a well-formed assessment", () => {
		const a = {
			verdict: "in-band",
			reasonCode: "frequency-out-of-band",
			targetsHz: [1_090_000_000],
			basis: "protocol",
			captureCenterHz: 1_090_000_000,
			windowHalfWidthHz: 819_200,
		}
		expect(guardDecoder(raw({ bandAssessment: a }))?.bandAssessment).toEqual(a)
	})
	it("reads a newer verdict as unknown, and keeps a newer basis or code as text", () => {
		expect(
			guardDecoder(
				raw({
					bandAssessment: {
						verdict: "partly",
						basis: "survey",
						reasonCode: "solar-flare",
					},
				}),
			)?.bandAssessment,
		).toEqual({
			verdict: "unknown",
			basis: "survey",
			reasonCode: "solar-flare",
		})
	})
	it("drops a malformed assessment or malformed fields, never the row", () => {
		for (const bad of [null, 3, "in-band", {}, { verdict: 1 }]) {
			const d = guardDecoder(raw({ bandAssessment: bad }))
			expect(d?.id).toBe("readsb")
			expect(d?.bandAssessment).toBeUndefined()
		}
		expect(
			guardDecoder(
				raw({
					bandAssessment: {
						verdict: "out-of-band",
						targetsHz: [1_090_000_000, -1],
						captureCenterHz: 0,
						windowHalfWidthHz: "wide",
						basis: 7,
					},
				}),
			)?.bandAssessment,
		).toEqual({ verdict: "out-of-band" })
	})
})

describe("R84 membership: core's bandAssessment first, nominal table as fallback", () => {
	it("follows core's verdict over the nominal inference", () => {
		const readsb = liveRow("readsb")
		expect(member(readsb)).toBe("out")
		expect(member({ ...readsb, bandAssessment: { verdict: "in-band" } })).toBe(
			"in",
		)
		expect(
			member({ ...readsb, bandAssessment: { verdict: "out-of-band" } }),
		).toBe("out")
		expect(member({ ...readsb, bandAssessment: { verdict: "unknown" } })).toBe(
			"?",
		)
	})
	it("tuned decoders show whatever core says", () => {
		const dsd = liveRow("dsd-fme")
		expect(member(dsd)).toBe("in")
		expect(member({ ...dsd, bandAssessment: { verdict: "unknown" } })).toBe("?")
	})
	it("a decoder on its own SDR stays off the shared window (—)", () => {
		const { sourceId: _s, ...readsb } = liveRow("readsb")
		const own: DecoderRow = {
			...readsb,
			id: "readsb-own",
			caps: {
				input: "external",
				output: "beast",
				integrationPattern: "network_producer",
			},
			bandAssessment: { verdict: "unknown", reasonCode: "external-input" },
		}
		expect(member(own)).toBe("—")
	})
	it("the window cell renders core's verdict", () => {
		const readsb = liveRow("readsb")
		expect(
			cellText({ ...readsb, bandAssessment: { verdict: "in-band" } }, "window"),
		).toEqual(["in"])
		expect(
			cellText({ ...readsb, bandAssessment: { verdict: "unknown" } }, "window"),
		).toEqual(["?"])
	})
})

describe("R84 band label and basis", () => {
	it("core's targets drive the band column; a configured basis keeps its mark", () => {
		const vdl = liveRow("dumpvdl2")
		const a: BandAssessment = {
			verdict: "out-of-band",
			targetsHz: [136_725_000, 136_975_000],
			basis: "decoder-default",
		}
		const { targetFrequenciesHz: _t, ...plain } = vdl
		expect(cellText({ ...plain, bandAssessment: a }, "nominal")).toEqual([
			"136.725–136.975",
		])
		expect(
			cellText(
				{ ...plain, bandAssessment: { ...a, basis: "configured" } },
				"nominal",
			),
		).toEqual(["136.725–136.975*"])
	})
	it("keeps the nominal table's alternatives when core's targets match it", () => {
		const ais = liveRow("ais-catcher")
		expect(
			cellText(
				{
					...ais,
					bandAssessment: {
						verdict: "out-of-band",
						targetsHz: [162_025_000, 161_975_000],
						basis: "protocol",
					},
				},
				"nominal",
			),
		).toEqual(["161.975/162.025"])
	})
	it("labels the basis in the detail and shows core's usable window", () => {
		const readsb = liveRow("readsb")
		const text = detail({
			...readsb,
			bandAssessment: {
				verdict: "out-of-band",
				targetsHz: [1_090_000_000],
				basis: "protocol",
				captureCenterHz: CENTRE,
				windowHalfWidthHz: 800_000,
			},
		})
		expect(text).toContain("1090.000 MHz protocol")
		expect(text).toContain("usable 445.171–446.771 MHz")
		expect(text).toContain("out of window")
		for (const [basis, words] of [
			["decoder-default", "decoder default"],
			["configured", "configured"],
			["survey", 'basis "survey"'],
		] as const)
			expect(
				detail({
					...readsb,
					bandAssessment: {
						verdict: "out-of-band",
						targetsHz: [1_090_000_000],
						basis,
					},
				}),
			).toContain(`1090.000 MHz ${words}`)
	})
	it("an unknown verdict says why, in plain words or quoted", () => {
		const readsb = liveRow("readsb")
		expect(
			detail({
				...readsb,
				bandAssessment: {
					verdict: "unknown",
					reasonCode: "no-target-frequency",
				},
			}),
		).toContain("window ? (no target frequency)")
		expect(
			detail({
				...readsb,
				bandAssessment: { verdict: "unknown", reasonCode: "solar-flare" },
			}),
		).toContain('window ? ("solar-flare")')
	})
	it("an older core (no bandAssessment) keeps the nominal wording", () => {
		const text = detail(liveRow("readsb"))
		expect(text).toContain("1090.000 MHz nominal")
		expect(text).toContain("window 444.947–446.995 MHz")
	})
})

describe("R84 retune impact prefers core's assessment", () => {
	const from = windowFor(
		"pi-iq",
		base.tuner.value,
		base.sources.value,
		base.relay.value,
	)!
	const at = (centreHz: number, sampleRate = from.sampleRate): TunedWindow => ({
		sourceId: "pi-iq",
		centreHz,
		sampleRate,
		loHz: centreHz - sampleRate / 2,
		hiHz: centreHz + sampleRate / 2,
	})
	const subject = (a: BandAssessment) => ({
		id: "x",
		type: "unlisted-type",
		bandAssessment: a,
	})
	it("uses core's verdict now and core's targets and half-width for the draft", () => {
		const a: BandAssessment = {
			verdict: "in-band",
			targetsHz: [CENTRE + 500_000],
			windowHalfWidthHz: 819_200,
		}
		// Moving 400 kHz away keeps the target within 819.2 kHz: no change.
		expect(retuneImpact([subject(a)], from, at(CENTRE + 100_000))).toEqual({
			tuned: [],
			enters: [],
			leaves: [],
			unknown: [],
		})
		// Moving 1 MHz the other way: the target leaves core's usable half-width.
		expect(
			retuneImpact([subject(a)], from, at(CENTRE - 500_000)).leaves,
		).toEqual(["x"])
		expect(
			retuneImpact(
				[subject({ ...a, verdict: "out-of-band" })],
				from,
				at(CENTRE + 500_000),
			).enters,
		).toEqual(["x"])
	})
	it("is unknown when the draft lands between targets (followCenter may still cover it)", () => {
		const a: BandAssessment = {
			verdict: "out-of-band",
			targetsHz: [130_000_000, 140_000_000],
			windowHalfWidthHz: 819_200,
		}
		expect(retuneImpact([subject(a)], from, at(135_000_000)).unknown).toEqual([
			"x",
		])
	})
	it("is unknown when core's verdict is unknown and nothing else is known", () => {
		expect(
			retuneImpact([subject({ verdict: "unknown" })], from, at(CENTRE)).unknown,
		).toEqual(["x"])
	})
	it("a rate change falls back to the nominal table (core's half-width no longer applies)", () => {
		const readsb = {
			id: "readsb",
			type: "readsb",
			bandAssessment: {
				verdict: "out-of-band",
				targetsHz: [1_090_000_000],
				windowHalfWidthHz: 819_200,
			} satisfies BandAssessment,
		}
		expect(
			retuneImpact([readsb], from, at(1_090_500_000, 2_400_000)).enters,
		).toEqual(["readsb"])
	})
})

describe("R84 band suspension", () => {
	const suspended = (over: Partial<DecoderRow> = {}): DecoderRow => ({
		...liveRow("readsb"),
		running: false,
		health: "running",
		desiredRunning: true,
		suspended: true,
		suspension: {
			reasonCode: "frequency-out-of-band",
			since: "2026-10-08T18:00:00.000Z",
		},
		bandAssessment: {
			verdict: "out-of-band",
			reasonCode: "frequency-out-of-band",
			targetsHz: [1_090_000_000],
			basis: "protocol",
		},
		...over,
	})
	it("the process cell reads suspended · out of band, in the neutral role", () => {
		const r = suspended()
		expect(cellText(r, "process")).toEqual([
			"suspended",
			"suspended · out of band",
		])
		const cell = decoderCells(facts(r), NOW)["process"]!
		for (const v of cell.variants)
			for (const s of v) expect(s.role).toBe("neutral")
	})
	it('the detail names the retune that resumes it (spec §9 bans "Waiting for")', () => {
		expect(detail(suspended())).toContain(
			"suspended since 18:00:00 · resumes on retune to 1090.000 MHz",
		)
		expect(
			detail(
				suspended({
					bandAssessment: {
						verdict: "out-of-band",
						targetsHz: [136_650_000, 136_975_000],
					},
				}),
			),
		).toContain(
			"suspended since 18:00:00 · resumes on retune to 136.650–136.975 MHz",
		)
	})
	it("without core's targets it says out of band only", () => {
		expect(
			detail(suspended({ bandAssessment: { verdict: "out-of-band" } })),
		).toContain("suspended since 18:00:00 · out of band")
	})
	it("a rate suspension still reads rate (core sends the reason that wins)", () => {
		const r = suspended({
			suspension: {
				reasonCode: "insufficient-sample-rate",
				since: "2026-10-08T18:00:00.000Z",
			},
		})
		expect(cellText(r, "process")).toEqual(["suspended", "suspended · rate"])
		expect(detail(r)).toContain(
			"suspended since 18:00:00 · sample rate too low",
		)
	})
	it("an unknown code reads plain suspended, with the code quoted in the detail", () => {
		const r = suspended({
			suspension: {
				reasonCode: "solar-flare",
				since: "2026-10-08T18:00:00.000Z",
			},
		})
		expect(cellText(r, "process")).toEqual(["suspended"])
		expect(detail(r)).toContain('suspended since 18:00:00 · "solar-flare"')
	})
	it("keeps health running, and suspended renders first", () => {
		const r = suspended()
		expect(r.health).toBe("running")
		expect(processState(r, 0, false, NOW)).toBe("suspended")
		expect(facts(r).failing).toBe(false)
		expect(detail(r)).toContain('health "running"')
		expect(detail(r)).not.toMatch(/up \d/)
	})
	it("never uses banned copy", () => {
		const r = suspended()
		for (const t of [...cellText(r, "process"), detail(r)])
			expect(findBanned(t)).toEqual([])
	})
})
