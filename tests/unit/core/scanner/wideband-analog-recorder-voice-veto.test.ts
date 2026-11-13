/**
 * The analog recorder never keeps a digital or paging transmission as voice (voice-veto.ts,
 * WidebandAnalogRecorder.notVoice): a discovery (or its merge owner) decoded as a protocol that is
 * not analog voice refuses and discards, a definite digital class discards, and a class by
 * snapshots only that digital readings outvote discards unless the session's own audio gave a
 * CTCSS class. Analog FM voice, with or without a tone, records as before.
 */
import { describe, expect, it } from "vitest"
import {
	DIGITAL_CLASSES,
	digitalClass,
	digitalOutvotes,
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

	it("digital readings outvote only when strictly more; bad counts never do", () => {
		expect(digitalOutvotes(3, 2)).toBe(true)
		expect(digitalOutvotes(2, 2)).toBe(false)
		expect(digitalOutvotes(0, 0)).toBe(false)
		expect(digitalOutvotes(Number.NaN, 0)).toBe(false)
		expect(digitalOutvotes(Infinity, 0)).toBe(false)
		expect(digitalOutvotes(-1, -2)).toBe(false)
	})

	it("ownerDecodedProtocol reads the merge owner's decoded protocol, null otherwise", () => {
		const discoveries = new Map<
			string,
			{ protocol: ScannerProtocol; confidence: "decoded" | "activity" }
		>([
			["d_pager", { protocol: "pocsag", confidence: "decoded" }],
			["d_carrier", { protocol: "carrier", confidence: "activity" }],
		])
		const store = {
			folderOwner: (id: string) =>
				discoveries.has(id)
					? id
					: id === "d_merged"
						? "d_pager"
						: id === "d_orphan"
							? "d_gone"
							: undefined,
			get: (id: string) => discoveries.get(id),
		}
		expect(ownerDecodedProtocol(store, "d_pager")).toBe("pocsag")
		// A discovery merged into the decoded pager: its owner's protocol.
		expect(ownerDecodedProtocol(store, "d_merged")).toBe("pocsag")
		expect(ownerDecodedProtocol(store, "d_carrier")).toBeNull()
		expect(ownerDecodedProtocol(store, "d_orphan")).toBeNull()
		expect(ownerDecodedProtocol(store, "d_unknown")).toBeNull()
		expect(ownerDecodedProtocol(store, "")).toBeNull()
		const throwing = {
			folderOwner: () => {
				throw new Error("boom")
			},
			get: () => undefined,
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
			folderOwner: (id: string) => (id === "d_1" ? "d_owner" : id),
			get: (id: string) =>
				id === "d_owner"
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

	it("a continuous signal classed analog-fm by a few snapshots while most read 4FSK, with no tone of its own, is discarded", async () => {
		const h = low({}, { ctcssHz: null })
		await h.feed(1, false)
		await over(h, 16, {
			// An occasional analog-fm reading (one in five), fsk4-12k5 on the spectrum otherwise.
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
		expect(h.ops.map(o => o.outcome)).not.toContain("finalized")
		expect(codes(h)).toContain("discarded:not-analog")
	}, 120_000)

	it("a short burst classed analog-fm once while its other snapshots read a digital class is discarded when its file finishes", async () => {
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
})
