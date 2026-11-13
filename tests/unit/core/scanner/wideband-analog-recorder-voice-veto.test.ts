/**
 * The analog recorder never keeps a digital or paging transmission as voice (voice-veto.ts,
 * WidebandAnalogRecorder.ownerNotVoice): a discovery of the session's owner (or its merge owner)
 * decoded as a protocol that is not analog voice refuses and discards, and so does a definite
 * digital class (a verified decode, the channel tier) of the owner's own track. A spectral
 * digital reading alone never discards or refuses, and a joined other signal ends the session at
 * the join without discarding the voice before it. Analog FM voice, with or without a tone,
 * records as before.
 */
import { describe, expect, it } from "vitest"
import {
	DIGITAL_CLASSES,
	digitalClass,
	notAnalogVoiceProtocol,
	ownerDecodedProtocol,
} from "../../../../src/core/scanner/channel/voice-veto.js"
import type { WidebandTrackInput } from "../../../../src/core/scanner/channel/wideband-analog-recorder.js"
import { CLASS_HYPOTHESES } from "../../../../src/core/scanner/classify/classifier.js"
import type {
	ScannerClass,
	ScannerProtocol,
} from "../../../../src/core/scanner/types.js"
import {
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

	it("ownerDecodedProtocol reads the merge owner's decoded protocol, null otherwise", () => {
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
				return owner === undefined ? undefined : discoveries.get(owner)
			},
		}
		expect(ownerDecodedProtocol(store, "d_pager")).toBe("pocsag")
		// A discovery merged into the decoded pager: its owner's protocol.
		expect(ownerDecodedProtocol(store, "d_merged")).toBe("pocsag")
		expect(ownerDecodedProtocol(store, "d_carrier")).toBeNull()
		expect(ownerDecodedProtocol(store, "d_orphan")).toBeNull()
		expect(ownerDecodedProtocol(store, "d_unknown")).toBeNull()
		expect(ownerDecodedProtocol(store, "")).toBeNull()
		const throwing = {
			ownerLabel: () => {
				throw new Error("boom")
			},
		}
		expect(ownerDecodedProtocol(throwing, "d_pager")).toBeNull()
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
		// The service's lookup resolves the alias to its owner (ownerDecodedProtocol).
		const store = {
			ownerLabel: (id: string) =>
				id === "d_1" || id === "d_owner"
					? { protocol: "pocsag" as const, confidence: "decoded" as const }
					: undefined,
		}
		const h = low(
			{ decodedProtocol: id => ownerDecodedProtocol(store, id) },
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
		await transmission(h, "o", 5, {}, LOW)
		// Inside the 2 s hang, another over on the same channel joins the session.
		await transmission(h, "j", 3, { discoveryId: "d_2", ...extra }, LOW)
		await h.feed(3.5, false)
		await h.rec.idle()
		return h
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
			const h = await joined(extra, decoded)
			expect(h.ops).toHaveLength(1)
			expect(h.ops[0]!.input.observationId).toBe("o")
			expect(h.ops[0]!.outcome).toBe("finalized")
			// The 5 s over is in it.
			expect(h.ops[0]!.frames).toBeGreaterThanOrEqual(5 * 8000)
			expect(codes(h)).not.toContain("discarded:not-analog")
			expect(
				(h.rec.diagnostics().recentRefusals ?? []).map(d => d.code),
			).toContain("refused:not-analog")
			expect(h.rec.owns("j")).toBe(false)
		}, 120_000)

	it("a joined analog-fm over with no decode still joins the voice file as before", async () => {
		const h = await joined({})
		expect(h.ops).toHaveLength(1)
		expect(h.ops[0]!.outcome).toBe("finalized")
		expect(h.ops[0]!.frames).toBeGreaterThanOrEqual(8 * 8000)
	}, 120_000)
})
