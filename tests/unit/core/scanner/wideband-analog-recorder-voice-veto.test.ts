/**
 * The analog recorder never keeps a digital or paging transmission as voice (voice-veto.ts,
 * WidebandAnalogRecorder.ownerVeto): a discovery of the session's owner (or its merge owner)
 * decoded as a protocol that is not analog voice during the session's air time refuses and
 * discards, and so does a definite digital class (a verified decode, the channel tier) of the
 * owner's own track. An older decode (a mixed-mode repeater's earlier digital over) proves
 * nothing. A spectral digital reading alone never discards or refuses, and a joined other signal
 * ends the session at the join (never later than its start) without discarding the voice before
 * it. Analog FM voice, with or without a tone, records as before.
 */
import { describe, expect, it } from "vitest"
import {
	DIGITAL_CLASSES,
	digitalClass,
	notAnalogVoiceProtocol,
	ownerDecoded,
	type DecodedLabel,
} from "../../../../src/core/scanner/channel/voice-veto.js"
import type { WidebandTrackInput } from "../../../../src/core/scanner/channel/wideband-analog-recorder.js"
import { CLASS_HYPOTHESES } from "../../../../src/core/scanner/classify/classifier.js"
import type {
	ScannerClass,
	ScannerProtocol,
} from "../../../../src/core/scanner/types.js"
import {
	HARNESS_T0,
	LOW_FS,
	LOW_OFFSET,
	harness,
	input,
	snapshot,
	transmission,
} from "./wideband-recorder-harness.js"

type Harness = ReturnType<typeof harness>

const LOW = { centreHz: 100_000_000 + LOW_OFFSET }

const codes = (h: Harness): string[] =>
	h.rec.diagnostics().recent.map(d => d.code)

const low = (
	opts: Parameters<typeof harness>[0] = {},
	source: Partial<
		NonNullable<Parameters<typeof harness>[0]>["source"] & object
	> = {},
): Harness => harness({ fs: LOW_FS, offset: LOW_OFFSET, source, ...opts })

/**
 * One over of `seconds` from the harness's source: a clean snapshot every 25 ms chunk once 100 ms
 * in (`extra(at)` per snapshot, `at` seconds after the onset), `during(at)` before each chunk,
 * then the close 600 ms later (`afterClose` right after it) and 3.5 s of quiet.
 */
async function over(
	h: Harness,
	seconds: number,
	opts: {
		extra?: (at: number) => Partial<WidebandTrackInput>
		during?: (at: number) => void
		afterClose?: () => void
		closeAnalog?: boolean
	} = {},
): Promise<void> {
	const chunk = h.fs / 40
	const onset = h.engine.liveEdge()
	const end = onset + seconds * h.fs
	for (let i = 0; i < Math.round((seconds * h.fs) / chunk); i++) {
		opts.during?.((h.engine.liveEdge() - onset) / h.fs)
		h.engine.write(h.src.next(chunk, true))
		const edge = h.engine.liveEdge()
		if (edge - onset >= 0.1 * h.fs)
			h.rec.track(
				input("o", snapshot("o", onset, Math.min(edge, end), LOW), {
					...opts.extra?.((edge - onset) / h.fs),
				}),
			)
		await h.pump()
	}
	await h.feed(0.6, false)
	h.rec.closed("o", snapshot("o", onset, end, LOW), null, {
		analogFm: opts.closeAnalog ?? true,
		discoveryId: "d_1",
	})
	opts.afterClose?.()
	await h.feed(3.5, false)
	await h.rec.idle()
}

describe("voice-veto tables", () => {
	it("the digital classes are the 4FSK, TDMA, wide 2FSK and GMSK classes, none with an analog-only hypothesis list", () => {
		expect([...DIGITAL_CLASSES].sort()).toEqual(
			["fsk2-wide", "fsk4-12k5", "fsk4-6k25", "gmsk-narrow", "tdma-ms"].sort(),
		)
		// Every digital class's first hypothesis is a protocol that is not analog voice.
		for (const c of DIGITAL_CLASSES)
			expect(notAnalogVoiceProtocol(CLASS_HYPOTHESES[c][0]!.protocol)).toBe(
				true,
			)
		for (const c of Object.keys(CLASS_HYPOTHESES) as ScannerClass[])
			expect(digitalClass(c)).toBe(DIGITAL_CLASSES.has(c))
	})

	it("unknown or malformed classes are never digital", () => {
		for (const c of [undefined, null, "", "FSK4-12K5", "analog-fm", 3, {}])
			expect(digitalClass(c)).toBe(false)
	})

	it("decoded pager, packet, ISM and digital-voice protocols are not analog voice; analog, carrier and unknown prove nothing", () => {
		const notVoice: ScannerProtocol[] = [
			"pocsag",
			"flex",
			"dmr",
			"p25p1",
			"dstar",
			"ysf",
			"nxdn48",
			"dpmr",
			"aprs",
			"ais",
			"acars",
			"vdl2",
			"lora",
			"adsb",
			"ism",
		]
		for (const p of notVoice) expect(notAnalogVoiceProtocol(p)).toBe(true)
		for (const p of [
			"analog-fm",
			"analog-am",
			"carrier",
			"unknown",
			"digital-unknown",
			"bogus",
			"",
			null,
			undefined,
			42,
		])
			expect(notAnalogVoiceProtocol(p)).toBe(false)
	})

	it("ownerDecoded reads the merge owner's decoded protocol, null otherwise", () => {
		const discoveries = new Map<
			string,
			{ protocol: ScannerProtocol; confidence: "decoded" | "activity" }
		>([
			["d_pager", { protocol: "pocsag", confidence: "decoded" }],
			["d_carrier", { protocol: "carrier", confidence: "activity" }],
		])
		const owners = new Map([
			["d_pager", "d_pager"],
			["d_carrier", "d_carrier"],
			["d_merged", "d_pager"],
			["d_orphan", "d_gone"],
		])
		const store = {
			ownerLabel: (id: string) => {
				const owner = owners.get(id)
				const label = owner === undefined ? undefined : discoveries.get(owner)
				return label === undefined
					? undefined
					: { ...label, proofAt: 1_000, proofObservationId: "o_1" }
			},
		}
		const pager = { protocol: "pocsag", at: 1_000, observationId: "o_1" }
		expect(ownerDecoded(store, "d_pager")).toEqual(pager)
		// A discovery merged into the decoded pager: its owner's protocol.
		expect(ownerDecoded(store, "d_merged")).toEqual(pager)
		expect(ownerDecoded(store, "d_carrier")).toBeNull()
		expect(ownerDecoded(store, "d_orphan")).toBeNull()
		expect(ownerDecoded(store, "d_unknown")).toBeNull()
		expect(ownerDecoded(store, "")).toBeNull()
		// A malformed time or observation reads unknown.
		const malformed = {
			ownerLabel: () => ({
				protocol: "pocsag" as const,
				confidence: "decoded" as const,
				proofAt: Number.NaN,
				proofObservationId: "",
			}),
		}
		expect(ownerDecoded(malformed, "d_pager")).toEqual({
			protocol: "pocsag",
			at: null,
			observationId: null,
		})
		const throwing = {
			ownerLabel: () => {
				throw new Error("boom")
			},
		}
		expect(ownerDecoded(throwing, "d_pager")).toBeNull()
	})
})

describe("analog FM voice still records", () => {
	it("an analog-fm voice with no decode and no digital reading is finalized", async () => {
		const h = low({ decodedProtocol: () => null }, { ctcssHz: null })
		await h.feed(1, false)
		await over(h, 5)
		expect(h.ops.map(o => o.outcome)).toEqual(["finalized"])
		expect(codes(h)).toEqual(["started", "voiced", "finalized"])
	}, 120_000)

	it("an analog-fm voice whose discovery is decoded analog-fm is finalized", async () => {
		const h = low({ decodedProtocol: () => "analog-fm" }, { ctcssHz: null })
		await h.feed(1, false)
		await over(h, 5)
		expect(h.ops.map(o => o.outcome)).toEqual(["finalized"])
	}, 120_000)

	it("a voice over a CTCSS tone, classed analog-fm first, is kept although later snapshots read a digital class", async () => {
		const h = low({}, { syllables: true })
		await h.feed(1, false)
		await over(h, 16, {
			extra: at =>
				at < 1
					? { analogFm: true }
					: { analogFm: false, shadowAllowed: true, digitalClass: true },
		})
		expect(h.ops.map(o => o.outcome)).toEqual(["finalized"])
		expect(codes(h)).not.toContain("discarded:not-analog")
	}, 120_000)

	it("a continuous voice classed analog-fm by a few snapshots while most read 4FSK on the spectrum only, with no tone, is kept", async () => {
		// Weak or low-deviation NFM voice can read as a narrow digital class for its whole length:
		// a spectral reading alone never discards it (no decode, no channel tier).
		const h = low({ decodedProtocol: () => null }, { ctcssHz: null })
		await h.feed(1, false)
		await over(h, 16, {
			extra: at =>
				Math.floor(at * 4) % 5 === 0
					? { analogFm: true }
					: {
							analogFm: false,
							shadowAllowed: true,
							spectralDigital: true,
							digitalClass: true,
						},
			closeAnalog: false,
		})
		expect(h.ops.length).toBeGreaterThan(0)
		expect(h.ops.every(o => o.outcome === "finalized")).toBe(true)
		expect(codes(h)).not.toContain("discarded:not-analog")
	}, 120_000)

	it("a short voice classed analog-fm once while its other snapshots read a digital class on the spectrum only, with no tone, is kept", async () => {
		const h = low({}, { ctcssHz: null })
		await h.feed(1, false)
		await over(h, 3, {
			extra: at =>
				at < 0.3
					? { analogFm: true }
					: {
							analogFm: false,
							shadowAllowed: true,
							spectralDigital: true,
							digitalClass: true,
						},
			closeAnalog: false,
		})
		expect(h.ops.map(o => o.outcome)).toEqual(["finalized"])
		expect(codes(h)).not.toContain("discarded:not-analog")
	}, 120_000)

	it("a short analog-fm voice with a minority of digital readings is kept", async () => {
		const h = low({}, { ctcssHz: null })
		await h.feed(1, false)
		await over(h, 5, {
			extra: at =>
				at < 3 ? { analogFm: true } : { analogFm: false, digitalClass: true },
		})
		expect(h.ops.map(o => o.outcome)).toEqual(["finalized"])
	}, 120_000)
})

describe("digital and paging transmissions are never kept as voice", () => {
	it("a discovery decoded as a pager refuses the recording before it starts", async () => {
		const h = low({ decodedProtocol: () => "pocsag" }, { ctcssHz: null })
		await h.feed(1, false)
		await over(h, 5)
		expect(h.ops).toEqual([])
		expect(codes(h)).not.toContain("started")
		expect(
			(h.rec.diagnostics().recentRefusals ?? []).map(d => d.code),
		).toContain("refused:not-analog")
	}, 120_000)

	it("a discovery merged into a decoded pager discovery (alias owner) refuses the recording", async () => {
		// The service's lookup resolves the alias to its owner (ownerDecoded): decoded now, on
		// this observation.
		const store = {
			ownerLabel: (id: string) =>
				id === "d_1" || id === "d_owner"
					? {
							protocol: "pocsag" as const,
							confidence: "decoded" as const,
							proofAt: HARNESS_T0,
							proofObservationId: "o",
						}
					: undefined,
		}
		const h = low(
			{ decodedLabel: id => ownerDecoded(store, id) },
			{ ctcssHz: null },
		)
		await h.feed(1, false)
		await over(h, 5)
		expect(h.ops).toEqual([])
	}, 120_000)

	it("a decode arriving during the over discards the recording in progress", async () => {
		let decoded: string | null = null
		const h = low({ decodedProtocol: () => decoded }, { ctcssHz: null })
		await h.feed(1, false)
		await over(h, 8, {
			during: at => {
				if (at >= 5) decoded = "pocsag"
			},
		})
		expect(h.ops.length).toBeGreaterThan(0)
		expect(h.ops.map(o => o.outcome)).not.toContain("finalized")
		expect(h.ops.every(o => o.outcome === "aborted")).toBe(true)
		expect(codes(h)).toContain("discarded:not-analog")
		expect(codes(h)).not.toContain("finalized")
	}, 120_000)

	it("a decode (of the merge owner) arriving after the close, before the file is finalized, discards it", async () => {
		let decoded: string | null = null
		const h = low({ decodedProtocol: () => decoded }, { ctcssHz: null })
		await h.feed(1, false)
		await over(h, 5, {
			afterClose: () => {
				decoded = "flex"
			},
		})
		expect(h.ops.map(o => o.outcome)).not.toContain("finalized")
		expect(codes(h)).toContain("discarded:not-analog")
	}, 120_000)

	it("digital voice is not analog voice either: a decoded DMR discovery discards the recording", async () => {
		let decoded: string | null = null
		const h = low({ decodedProtocol: () => decoded }, { ctcssHz: null })
		await h.feed(1, false)
		await over(h, 6, {
			during: at => {
				if (at >= 4) decoded = "dmr"
			},
		})
		expect(h.ops.map(o => o.outcome)).not.toContain("finalized")
		expect(codes(h)).toContain("discarded:not-analog")
	}, 120_000)

	it("a definite digital class (verified decode or channel tier) discards a session classed analog-fm by a snapshot", async () => {
		const h = low({}, { ctcssHz: null })
		await h.feed(1, false)
		await over(h, 6, {
			extra: at =>
				at < 3
					? { analogFm: true }
					: { analogFm: false, nonAnalog: true, digitalClass: true },
		})
		expect(h.ops.map(o => o.outcome)).not.toContain("finalized")
		expect(codes(h)).toContain("discarded:not-analog")
	}, 120_000)

	it("a decoded non-voice discovery is refused once: no lookup per later snapshot", async () => {
		let lookups = 0
		const h = low(
			{
				decodedProtocol: () => {
					lookups++
					return "pocsag"
				},
			},
			{ ctcssHz: null },
		)
		await h.feed(1, false)
		await over(h, 5)
		expect(h.ops).toEqual([])
		expect(lookups).toBe(1)
	}, 120_000)

	it("a roll-over whose first file is vetoed when it finishes (a decode with no snapshot since) discards it and starts no continuation", async () => {
		let decoded: string | null = null
		const h = low({ decodedProtocol: () => decoded }, { ctcssHz: null })
		await h.feed(0.5, false)
		const onset = h.engine.liveEdge()
		const report = () =>
			h.rec.track(
				input("long", snapshot("long", onset, h.engine.liveEdge(), LOW)),
			)
		await h.feed(119.5, true, report)
		expect(h.ops).toHaveLength(1)
		expect(h.ops[0]!.cut).toBeNull()
		// The decode arrives with no snapshot after it: the roll-over's finish (120 s) is the check.
		decoded = "flex"
		await h.feed(2, true)
		expect(h.ops).toHaveLength(1)
		expect(h.ops[0]!.frames).toBe(120 * 8000)
		expect(h.ops[0]!.cancelled).toBe("cancelled")
		expect(h.ops[0]!.outcome).toBe("aborted")
		expect(codes(h)).toContain("discarded:not-analog")
		expect(h.rec.owns("long")).toBe(false)
		// The track closes: no continuation file was started or kept.
		h.rec.closed(
			"long",
			snapshot("long", onset, h.engine.liveEdge(), LOW),
			null,
		)
		await h.feed(3.5, false)
		await h.rec.idle()
		expect(h.ops).toHaveLength(1)
	}, 120_000)
})

describe("a joined other signal never discards the voice before it", () => {
	const joined = async (
		extra: Partial<WidebandTrackInput>,
		decoded?: string,
	) => {
		const h = low(
			{ decodedProtocol: id => (id === "d_2" ? (decoded ?? null) : null) },
			{ ctcssHz: null },
		)
		await h.feed(1, false)
		const voiceOnset = h.engine.liveEdge()
		await transmission(h, "o", 5, {}, LOW)
		// Inside the 2 s hang, another over on the same channel joins the session.
		const joinAt = h.engine.liveEdge()
		await transmission(h, "j", 3, { discoveryId: "d_2", ...extra }, LOW)
		await h.feed(3.5, false)
		await h.rec.idle()
		// Frames from the pre-roll (300 ms) to the joined over's start.
		return { h, toJoin: ((joinAt - voiceOnset) / h.fs + 0.3) * 8000 }
	}

	for (const [name, extra, decoded] of [
		[
			"a joined over with a definite digital class (decode, channel tier)",
			{ analogFm: false, nonAnalog: true, digitalClass: true },
			undefined,
		],
		["a joined over whose discovery is decoded as DMR", {}, "dmr"],
		["a joined over whose discovery is decoded as a pager", {}, "pocsag"],
	] as const)
		it(`${name} ends the session at the join; the voice file is kept`, async () => {
			const { h, toJoin } = await joined(extra, decoded)
			expect(h.ops).toHaveLength(1)
			expect(h.ops[0]!.input.observationId).toBe("o")
			expect(h.ops[0]!.outcome).toBe("finalized")
			// The 5 s over is in it, and nothing of the joined signal (one 25 ms chunk of rounding).
			expect(h.ops[0]!.frames).toBeGreaterThanOrEqual(5 * 8000)
			expect(h.ops[0]!.frames).toBeLessThanOrEqual(Math.round(toJoin + 200))
			expect(codes(h)).not.toContain("discarded:not-analog")
			expect(
				(h.rec.diagnostics().recentRefusals ?? []).map(d => d.code),
			).toContain("refused:not-analog")
			expect(h.rec.owns("j")).toBe(false)
		}, 120_000)

	it("a joined analog-fm over with no decode still joins the voice file as before", async () => {
		const { h } = await joined({})
		expect(h.ops).toHaveLength(1)
		expect(h.ops[0]!.outcome).toBe("finalized")
		expect(h.ops[0]!.frames).toBeGreaterThanOrEqual(8 * 8000)
	}, 120_000)
})

describe("a decode counts only during the session's air time", () => {
	const refusals = (h: Harness): string[] =>
		(h.rec.diagnostics().recentRefusals ?? []).map(d => d.code)

	for (const by of ["c4fm", null])
		it(`a mixed-mode repeater: a discovery decoded as DMR 60 s before a new analog FM over (citing ${by ?? "no observation"}) refuses and discards nothing`, async () => {
			let label: DecodedLabel | null = null
			const h = low(
				{ liveClock: true, decodedLabel: () => label },
				{ ctcssHz: null },
			)
			await h.feed(1, false)
			label = { protocol: "dmr", at: h.now() - 60_000, observationId: by }
			await over(h, 5)
			expect(h.ops.map(o => o.outcome)).toEqual(["finalized"])
			expect(codes(h)).not.toContain("discarded:not-analog")
			expect(refusals(h)).not.toContain("refused:not-analog")
		}, 120_000)

	it("a stale decode is not remembered as a refusal: a pager decode of this over later still discards it", async () => {
		let label: DecodedLabel | null = null
		const h = low(
			{ liveClock: true, decodedLabel: () => label },
			{ ctcssHz: null },
		)
		await h.feed(1, false)
		label = { protocol: "dmr", at: h.now() - 60_000, observationId: "c4fm" }
		await over(h, 6, {
			during: at => {
				if (at >= 4 && label?.protocol === "dmr")
					label = { protocol: "pocsag", at: h.now(), observationId: "o" }
			},
		})
		expect(h.ops.length).toBeGreaterThan(0)
		expect(h.ops.map(o => o.outcome)).not.toContain("finalized")
		expect(codes(h)).toContain("discarded:not-analog")
	}, 120_000)

	it("a discovery decoded at the over's onset refuses it once, before it starts", async () => {
		let lookups = 0
		let label: DecodedLabel | null = null
		const h = low(
			{
				liveClock: true,
				decodedLabel: () => {
					lookups++
					return label
				},
			},
			{ ctcssHz: null },
		)
		await h.feed(1, false)
		label = { protocol: "pocsag", at: h.now(), observationId: null }
		await over(h, 5)
		expect(h.ops).toEqual([])
		expect(refusals(h)).toContain("refused:not-analog")
		expect(lookups).toBe(1)
	}, 120_000)

	it("a pager burst decoded during its recording is discarded, through a merge alias too", async () => {
		let proofAt: number | null = null
		// d_1 was merged into d_owner, the decoded pager: the alias resolves to its label.
		const store = {
			ownerLabel: (id: string) =>
				proofAt !== null && (id === "d_1" || id === "d_owner")
					? {
							protocol: "pocsag" as const,
							confidence: "decoded" as const,
							proofAt,
							proofObservationId: "o",
						}
					: undefined,
		}
		const h = low(
			{ liveClock: true, decodedLabel: id => ownerDecoded(store, id) },
			{ ctcssHz: null },
		)
		await h.feed(1, false)
		await over(h, 6, {
			during: at => {
				if (at >= 3 && proofAt === null) proofAt = h.now()
			},
		})
		expect(h.ops.length).toBeGreaterThan(0)
		expect(h.ops.every(o => o.outcome === "aborted")).toBe(true)
		expect(codes(h)).toContain("discarded:not-analog")
	}, 120_000)

	it("a decode during the over that cites another observation (another transmission) discards nothing", async () => {
		let label: DecodedLabel | null = null
		const h = low(
			{ liveClock: true, decodedLabel: () => label },
			{ ctcssHz: null },
		)
		await h.feed(1, false)
		await over(h, 5, {
			during: at => {
				if (at >= 2 && label === null)
					label = { protocol: "dmr", at: h.now(), observationId: "c4fm" }
			},
		})
		expect(h.ops.map(o => o.outcome)).toEqual(["finalized"])
		expect(codes(h)).not.toContain("discarded:not-analog")
	}, 120_000)

	for (const delay of [0.8, 1.5])
		for (const by of ["dmr1", "channel:d_1"])
			it(`M1: a channel DMR decode stamped ${delay} s into a new analog over, frozen to ${by} (the earlier digital over, or a turnaround naming neither), keeps the voice`, async () => {
				let label: DecodedLabel | null = null
				const h = low(
					{ liveClock: true, decodedLabel: () => label },
					{ ctcssHz: null },
				)
				await h.feed(1, false)
				await over(h, 5, {
					during: at => {
						if (at >= delay && label === null)
							label = { protocol: "dmr", at: h.now(), observationId: by }
					},
				})
				expect(h.ops.map(o => o.outcome)).toEqual(["finalized"])
				expect(codes(h)).not.toContain("discarded:not-analog")
				expect(refusals(h)).not.toContain("refused:not-analog")
			}, 120_000)

	it("M1: a decode naming no observation stamped just before the over's onset (the over before it, a decoder's lag) refuses nothing", async () => {
		let label: DecodedLabel | null = null
		const h = low(
			{ liveClock: true, decodedLabel: () => label },
			{ ctcssHz: null },
		)
		await h.feed(1, false)
		// Inside the old window (pre-roll 300 ms + skew 500 ms before the onset), before the onset.
		label = { protocol: "dmr", at: h.now() - 200, observationId: "decode:d_1" }
		await over(h, 5)
		expect(h.ops.map(o => o.outcome)).toEqual(["finalized"])
		expect(refusals(h)).not.toContain("refused:not-analog")
	}, 120_000)

	for (const by of [null, "decode:d_1"])
		it(`M1: a pager decode after the onset naming no observation (${by ?? "null"}) discards the recording`, async () => {
			let label: DecodedLabel | null = null
			const h = low(
				{ liveClock: true, decodedLabel: () => label },
				{ ctcssHz: null },
			)
			await h.feed(1, false)
			await over(h, 6, {
				during: at => {
					if (at >= 3 && label === null)
						label = { protocol: "pocsag", at: h.now(), observationId: by }
				},
			})
			expect(h.ops.length).toBeGreaterThan(0)
			expect(h.ops.map(o => o.outcome)).not.toContain("finalized")
			expect(codes(h)).toContain("discarded:not-analog")
		}, 120_000)

	it("a DMR decode during the analog over's hang, of a digital over joined on the same discovery, ends the session at the join: the voice file is kept", async () => {
		let label: DecodedLabel | null = null
		const h = low(
			{ liveClock: true, decodedLabel: () => label },
			{ ctcssHz: null },
		)
		await h.feed(1, false)
		const voiceOnset = h.engine.liveEdge()
		await transmission(h, "o", 5, {}, LOW)
		// Inside the 2 s hang, a digital over on the same frequency (the same discovery) joins
		// (its spectrum reads 4FSK only); its decode arrives 1 s in.
		const onset = h.engine.liveEdge()
		const digital = {
			analogFm: false,
			shadowAllowed: true,
			spectralDigital: true,
			digitalClass: true,
		}
		await h.feed(3, true, () => {
			const edge = h.engine.liveEdge()
			if (edge - onset >= h.fs && label === null)
				label = { protocol: "dmr", at: h.now(), observationId: "j" }
			if (edge - onset >= 0.1 * h.fs)
				h.rec.track(input("j", snapshot("j", onset, edge, LOW), digital))
		})
		await h.feed(0.6, false)
		h.rec.closed("j", snapshot("j", onset, h.engine.liveEdge(), LOW), null)
		await h.feed(3.5, false)
		await h.rec.idle()
		expect(h.ops).toHaveLength(1)
		expect(h.ops[0]!.input.observationId).toBe("o")
		expect(h.ops[0]!.outcome).toBe("finalized")
		expect(h.ops[0]!.frames).toBeGreaterThanOrEqual(5 * 8000)
		// Pre-roll + the voice + its quiet up to the join, nothing of the joined over although its
		// decode came 1 s in (writes stay a holdback behind the edge; one 25 ms chunk of rounding).
		const toJoin = ((onset - voiceOnset) / h.fs + 0.3) * 8000
		expect(h.ops[0]!.frames).toBeLessThanOrEqual(Math.round(toJoin + 200))
		expect(codes(h)).not.toContain("discarded:not-analog")
		expect(refusals(h)).toContain("refused:not-analog")
		expect(h.rec.owns("j")).toBe(false)
	}, 120_000)
})

describe("m2: a join before the current file's start (a roll-over)", () => {
	/**
	 * A 118 s voice `o`, then `j` (same channel) reported beside it for `joinedSeconds` from
	 * 118 s on while `o` goes on past the 120 s roll-over; 1 s past the roll-over a DMR decode
	 * naming `j` arrives.
	 */
	const scene = async (joinedSeconds: number) => {
		let label: DecodedLabel | null = null
		const h = low(
			{ liveClock: true, decodedLabel: () => label },
			{ ctcssHz: null },
		)
		await h.feed(0.5, false)
		const onset = h.engine.liveEdge()
		const report = () =>
			h.rec.track(input("o", snapshot("o", onset, h.engine.liveEdge(), LOW)))
		await h.feed(118, true, report)
		const joinAt = h.engine.liveEdge()
		const joinEnd = joinAt + joinedSeconds * h.fs
		await h.feed(4, true, () => {
			report()
			const edge = h.engine.liveEdge()
			if (edge >= joinAt + 0.1 * h.fs && edge <= joinEnd)
				h.rec.track(input("j", snapshot("j", joinAt, edge, LOW)))
			if (edge > joinEnd && h.rec.owns("j"))
				h.rec.closed("j", snapshot("j", joinAt, joinEnd, LOW), null)
			if (edge - onset >= 121 * h.fs && label === null)
				label = { protocol: "dmr", at: h.now(), observationId: "j" }
		})
		h.rec.closed("o", snapshot("o", onset, h.engine.liveEdge(), LOW), null)
		await h.feed(3.5, false)
		await h.rec.idle()
		return h
	}

	/** Finalized files, each of `o`; the files after the first hold the voice past 120 s once. */
	const keptAfterRollOver = (h: Harness, files: number) => {
		const kept = h.ops.filter(o => o.outcome === "finalized")
		expect(kept.map(o => o.input.observationId)).toEqual(
			Array<string>(files).fill("o"),
		)
		expect(kept[0]).toBe(h.ops[0])
		// The roll-over is 120 s after the file's start (the onset less the 300 ms pre-roll): the
		// voice goes on 2.3 s past it, then the 2 s hang, each sample once (one chunk of rounding).
		const after = kept.slice(1).reduce((n, o) => n + o.frames, 0)
		expect(after).toBeGreaterThanOrEqual(2.3 * 8000)
		expect(after).toBeLessThanOrEqual((2.3 + 2) * 8000 + 200)
		expect(codes(h)).not.toContain("discarded:not-analog")
		expect(
			(h.rec.diagnostics().recentRefusals ?? [])
				.filter(d => d.code === "refused:not-analog")
				.map(d => d.observationId),
		).toEqual(["j"])
		expect(h.rec.owns("o")).toBe(false)
	}

	it("the joined signal still on the air when the roll-over's file opened: that file is dropped, the voice before it kept, and the voice going on is recorded in a continuation from the roll-over", async () => {
		keptAfterRollOver(await scene(4), 2)
	}, 240_000)

	it("the joined signal ended before the roll-over's file opened: that file (voice after it) is kept too, and the voice going on is recorded in a continuation from its end", async () => {
		keptAfterRollOver(await scene(1), 3)
	}, 240_000)
})

describe("M1: an own veto of a short digital owner never loses a joined analog voice", () => {
	const DIGITAL_SHADOW = {
		analogFm: false,
		shadowAllowed: true,
		spectralDigital: true,
		digitalClass: true,
	}

	/**
	 * A 2.5 s digital burst `b` (a shadow: its spectrum reads 4FSK only), 200 ms of quiet, then a
	 * 6 s analog FM over `v` on the same channel that joins `b`'s session inside its hang; `b`'s
	 * close is reported 400 ms into `v` (`closeInfo`), `atVoice(at)` runs before each chunk of
	 * `v` (`at` seconds in).
	 */
	const scene = async (opts: {
		closeInfo: Parameters<Harness["rec"]["closed"]>[3]
		atVoice?: (h: Harness, at: number) => void
		label?: () => DecodedLabel | null
	}) => {
		const h = low(
			{ liveClock: true, decodedLabel: () => opts.label?.() ?? null },
			{ ctcssHz: null },
		)
		await h.feed(1, false)
		const burstOnset = h.engine.liveEdge()
		await h.feed(2.5, true, () => {
			const edge = h.engine.liveEdge()
			if (edge - burstOnset >= 0.1 * h.fs)
				h.rec.track(
					input("b", snapshot("b", burstOnset, edge, LOW), DIGITAL_SHADOW),
				)
		})
		const burstEnd = h.engine.liveEdge()
		await h.feed(0.2, false)
		const voiceOnset = h.engine.liveEdge()
		let closedBurst = false
		await h.feed(6, true, () => {
			const edge = h.engine.liveEdge()
			const at = (edge - voiceOnset) / h.fs
			opts.atVoice?.(h, at)
			if (at >= 0.1)
				h.rec.track(input("v", snapshot("v", voiceOnset, edge, LOW)))
			if (at >= 0.4 && !closedBurst) {
				closedBurst = true
				h.rec.closed(
					"b",
					snapshot("b", burstOnset, burstEnd, LOW),
					null,
					opts.closeInfo,
				)
			}
		})
		const voiceEnd = h.engine.liveEdge()
		await h.feed(0.6, false)
		h.rec.closed("v", snapshot("v", voiceOnset, voiceEnd, LOW), null, {
			analogFm: true,
			discoveryId: "d_1",
		})
		await h.feed(3.5, false)
		await h.rec.idle()
		return h
	}

	const expectVoiceKept = (h: Harness) => {
		const kept = h.ops.filter(o => o.outcome === "finalized")
		expect(kept).toHaveLength(1)
		expect(kept[0]!.input.observationId).toBe("v")
		// The whole over (from the burst's end, the pre-roll floored there) and its hang, nothing
		// of the 2.5 s burst before it (one 25 ms chunk of rounding).
		expect(kept[0]!.frames).toBeGreaterThanOrEqual(6 * 8000)
		expect(kept[0]!.frames).toBeLessThanOrEqual((0.2 + 6 + 2) * 8000 + 200)
		// The burst's session is discarded as not analog; the voice is never refused.
		expect(codes(h)).toContain("discarded:not-analog")
		expect(
			(h.rec.diagnostics().recentRefusals ?? []).filter(
				d => d.observationId === "v",
			),
		).toEqual([])
		expect(
			h.rec
				.diagnostics()
				.recent.filter(
					d => d.observationId === "v" && d.code === "discarded:not-analog",
				),
		).toEqual([])
	}

	it("a pager decode citing the burst, arriving 1.5 s into the joined voice, discards only the burst's part: the voice is recorded and kept", async () => {
		let label: DecodedLabel | null = null
		const h = await scene({
			closeInfo: {
				analogFm: false,
				digitalClass: true,
				discoveryId: "d_1",
			},
			label: () => label,
			atVoice: (h, at) => {
				if (at >= 1.5 && label === null)
					label = { protocol: "pocsag", at: h.now(), observationId: "b" }
			},
		})
		expectVoiceKept(h)
	}, 120_000)

	it("the burst's closing snapshot carrying the channel tier's digital class after the voice joined discards only the burst's part: the voice is recorded and kept", async () => {
		const h = await scene({
			closeInfo: {
				analogFm: false,
				nonAnalog: true,
				digitalClass: true,
				discoveryId: "d_1",
			},
		})
		expectVoiceKept(h)
	}, 120_000)

	it("with no joined voice, the same decode still discards the burst's session (nothing finalized)", async () => {
		let label: DecodedLabel | null = null
		const h = low(
			{ liveClock: true, decodedLabel: () => label },
			{ ctcssHz: null },
		)
		await h.feed(1, false)
		const onset = h.engine.liveEdge()
		await h.feed(2.5, true, () => {
			const edge = h.engine.liveEdge()
			if (edge - onset >= 1 * h.fs && label === null)
				label = { protocol: "pocsag", at: h.now(), observationId: "b" }
			if (edge - onset >= 0.1 * h.fs)
				h.rec.track(input("b", snapshot("b", onset, edge, LOW), DIGITAL_SHADOW))
		})
		h.rec.closed("b", snapshot("b", onset, h.engine.liveEdge(), LOW), null)
		await h.feed(3.5, false)
		await h.rec.idle()
		expect(h.ops.map(o => o.outcome)).not.toContain("finalized")
	}, 120_000)
})

describe("minor 1: a decoded other signal joining a voice still on the air", () => {
	it("ends the kept file at the join, refuses only the joined signal, and the rest of the voice is recorded in a continuation file", async () => {
		const h = low({}, { ctcssHz: null })
		await h.feed(1, false)
		const onset = h.engine.liveEdge()
		let joinAt = 0
		let joinEnd = 0
		await h.feed(14, true, () => {
			const edge = h.engine.liveEdge()
			const at = (edge - onset) / h.fs
			if (at >= 0.1) h.rec.track(input("o", snapshot("o", onset, edge, LOW)))
			// 5 s in, a signal with the channel tier's digital class joins for 1 s.
			if (at >= 5 && joinAt === 0) joinAt = edge
			if (joinAt !== 0 && joinEnd === 0) {
				if (at < 6)
					h.rec.track(
						input("j", snapshot("j", joinAt, edge, LOW), {
							discoveryId: "d_2",
							analogFm: false,
							nonAnalog: true,
							digitalClass: true,
						}),
					)
				else {
					joinEnd = edge
					h.rec.closed("j", snapshot("j", joinAt, edge, LOW), null)
				}
			}
		})
		const end = h.engine.liveEdge()
		await h.feed(0.6, false)
		h.rec.closed("o", snapshot("o", onset, end, LOW), null, {
			analogFm: true,
			discoveryId: "d_1",
		})
		await h.feed(3.5, false)
		await h.rec.idle()
		const kept = h.ops.filter(o => o.outcome === "finalized")
		expect(kept.map(o => o.input.observationId)).toEqual(["o", "o"])
		// The first file: the pre-roll and the voice up to the join (one chunk of rounding).
		const toJoin = ((joinAt - onset) / h.fs + 0.3) * 8000
		expect(kept[0]!.frames).toBeGreaterThanOrEqual(4.5 * 8000)
		expect(kept[0]!.frames).toBeLessThanOrEqual(Math.round(toJoin + 200))
		// The continuation: from the join on (the joined second included), the rest of the voice
		// and its hang; together they hold the whole over once.
		expect(kept[1]!.frames).toBeGreaterThanOrEqual(8 * 8000)
		expect(kept[0]!.frames + kept[1]!.frames).toBeLessThanOrEqual(
			(0.3 + 14 + 2) * 8000 + 400,
		)
		expect(codes(h)).not.toContain("discarded:not-analog")
		const refused = (h.rec.diagnostics().recentRefusals ?? []).filter(
			d => d.code === "refused:not-analog",
		)
		expect(refused.map(d => d.observationId)).toEqual(["j"])
	}, 120_000)
})
