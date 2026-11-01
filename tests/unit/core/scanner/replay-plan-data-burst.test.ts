/**
 * Scanner quality benchmark, defect C: a bursty data emission tries its data decoders before the
 * analog trial. An OOK sensor in ISM 433 had rtl433 8th behind the analog trial and five voice
 * probes; a POCSAG burst read `analog-fm` and had pocsag 6th. Track fixtures only.
 */
import { describe, expect, it } from "vitest"
import { classOf } from "../../../../src/core/scanner/classify/classifier.js"
import type {
	IqCaptureView,
	IqReplayPlanInput,
} from "../../../../src/core/scanner/iq-capture-contract.js"
import {
	OOK_DUTY_MAX,
	isDataBurst,
	planReplayTrials,
} from "../../../../src/core/scanner/replay-plan.js"
import type { ScannerProtocol } from "../../../../src/core/scanner/types.js"
import type { TrackSnapshot } from "../../../../src/core/spectrum/types.js"
import { TARGET_HZ, trackOf } from "../../../mocks/scanner/identify-fakes.js"

const capture: IqCaptureView = {
	captureId: "c1",
	sourceId: "rtl",
	observationId: "o_t1",
	epoch: 1,
	rfHz: TARGET_HZ,
	tuningTrust: "commanded",
	capturedAtMs: 0,
	durationMs: 2000,
	gapSamples: 0,
	rateHz: 96_000,
}

const DIGITAL: ScannerProtocol[] = [
	"dmr",
	"p25p1",
	"nxdn48",
	"nxdn96",
	"ysf",
	"dstar",
	"dpmr",
	"pocsag",
	"flex",
	"aprs",
]
/** An ISM range inside 70 cm: ISM and analog FM listed, the rest at the default 0.25. */
const ISM: Partial<Record<ScannerProtocol, number>> = {
	"analog-fm": 1,
	ism: 1,
	...Object.fromEntries(DIGITAL.map(p => [p, 0.25])),
}
/** 70 cm outside ISM: FM and the amateur digital modes listed, paging not. */
const AMATEUR: Partial<Record<ScannerProtocol, number>> = {
	...Object.fromEntries(DIGITAL.map(p => [p, 0.25])),
	"analog-fm": 1,
	dmr: 1,
	dstar: 1,
	ysf: 1,
	p25p1: 1,
	ism: 0.25,
}

const plan = (
	track: TrackSnapshot,
	priors: Partial<Record<ScannerProtocol, number>>,
): string[] =>
	planReplayTrials({
		capture,
		track,
		knownProtocol: null,
		priors,
		narrowRaster: false,
	} satisfies IqReplayPlanInput).map(t =>
		t.kind === "analog" ? "analog" : t.protocol,
	)

/** A 450 ms OOK sensor triple: peaked, 14 kHz, keyed a third of the time. */
const ook = trackOf({
	obwHz: 14_000,
	spectralShape: "peaked",
	blocks: 9,
	dutyCycle: 0.31,
})
/** A 1.5 s POCSAG burst: two tones (`fsk2`), constant envelope. */
const pocsag = trackOf({
	obwHz: 13_000,
	spectralShape: "peaked",
	blocks: 31,
	dutyCycle: 1,
	fsk2: true,
})
/** A 3 s FM voice over: peaked, constant envelope. */
const voice = trackOf({
	obwHz: 10_500,
	spectralShape: "peaked",
	blocks: 60,
	dutyCycle: 1,
})

describe("replay plan for bursty data emissions", () => {
	it("an OOK burst in an ISM band tries rtl433 first and the analog trial last", () => {
		const out = plan(ook, ISM)
		expect(out[0]).toBe("ism")
		expect(out.at(-1)).toBe("analog")
	})

	it("a two-tone burst classes fsk2-wide and tries pocsag first, analog last", () => {
		expect(classOf(pocsag)).toBe("fsk2-wide")
		const out = plan(pocsag, AMATEUR)
		expect(out[0]).toBe("pocsag")
		expect(out.at(-1)).toBe("analog")
	})

	it("a two-tone burst in an ISM band: rtl433, then the pager probes, analog last", () => {
		const out = plan(pocsag, ISM)
		expect(out.slice(0, 2)).toEqual(["ism", "pocsag"])
		expect(out.at(-1)).toBe("analog")
	})

	it("sustained FM voice keeps the analog trial first, in and out of an ISM band", () => {
		expect(plan(voice, ISM)[0]).toBe("analog")
		expect(plan(voice, AMATEUR)[0]).toBe("analog")
		expect(isDataBurst(voice, ISM)).toBe(false)
	})

	it("the ISM duty and length bounds", () => {
		const at = (over: Partial<TrackSnapshot>) =>
			isDataBurst({ ...voice, ...over }, ISM)
		expect(at({ dutyCycle: OOK_DUTY_MAX })).toBe(true)
		expect(at({ dutyCycle: OOK_DUTY_MAX + 0.01 })).toBe(false)
		// 20 blocks = 1 s at 50 ms is short; 21 is not
		expect(at({ blocks: 20 })).toBe(true)
		expect(at({ blocks: 21 })).toBe(false)
		// outside an ISM band neither rule applies
		expect(isDataBurst({ ...voice, dutyCycle: 0.3 }, AMATEUR)).toBe(false)
	})

	it("a TDMA slot pattern is digital voice, not a keyed burst", () => {
		const dmr = trackOf({
			acf30: -0.81,
			acf60: 0.93,
			blocks: 60,
			dutyCycle: 0.47,
		})
		expect(isDataBurst(dmr, ISM)).toBe(false)
	})
})
