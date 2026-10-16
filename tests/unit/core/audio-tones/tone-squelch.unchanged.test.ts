import { describe, expect, it } from "vitest"
import { CtcssBank } from "../../../../src/core/audio-tones/ctcss.js"
import { DcsDecoder } from "../../../../src/core/audio-tones/dcs.js"
import { ToneDetector } from "../../../../src/core/audio-tones/tone-detector.js"
import {
	ctcssTone,
	dcsAudio,
	mixInto,
	pinkNoise,
	speechLike,
	whiteNoise,
} from "./dcs-synth.js"
import { dtmfString, renderPcm, sine } from "./synth.js"

/**
 * WG7 SQ: the additive streaming exports must not change any existing result. The expected
 * values below were recorded from the code before the WG7 change (freeze cccf665f) over the
 * WG2 (CTCSS/DTMF sines at several rates and formats) and WG6 (DCS, no-DCS) corpora.
 */

type Format = "s16le" | "f32le"

function detectorResult(
	pcm: Buffer,
	rate: number,
	format: Format,
	chunk: number,
) {
	const detector = new ToneDetector()
	for (let at = 0; at < pcm.length; at += chunk)
		detector.push(pcm.subarray(at, Math.min(pcm.length, at + chunk)), {
			rate,
			format,
		})
	return detector.result()
}

function wg2Corpus(): unknown[] {
	const out: unknown[] = []
	const cases: [number, number, Format][] = [
		[67, 48_000, "f32le"],
		[100, 25_000, "s16le"],
		[151.4, 44_100, "f32le"],
		[203.5, 12_500, "s16le"],
		[254.1, 8_000, "f32le"],
	]
	for (const [hz, rate, format] of cases) {
		const pcm = sine({
			hz,
			rate,
			seconds: 1.6,
			amplitude: 0.2,
			noiseStd: 0.03,
			seed: Math.round(hz * 10),
			format,
			extraHz: 1_000,
			extraAmplitude: 0.1,
		})
		out.push(detectorResult(pcm.pcm, rate, format, 4_097))
	}
	const dtmf = dtmfString({
		symbols: "159#",
		rate: 48_000,
		onSeconds: 0.08,
		offSeconds: 0.06,
		amplitude: 0.3,
		format: "s16le",
	})
	out.push(detectorResult(dtmf.pcm, 48_000, "s16le", 333))
	return out
}

function wg6Corpus(): unknown[] {
	const out: unknown[] = []
	const audios: Float64Array[] = [
		mixInto(
			dcsAudio({ code: 0o23, seconds: 2, seed: 1 }),
			whiteNoise({ seconds: 2, seed: 2, std: 0.01 }),
		),
		dcsAudio({ code: 0o754, seconds: 2, seed: 3, inverted: true }),
		mixInto(
			speechLike({ seconds: 3, seed: 4, amplitude: 0.4 }),
			pinkNoise({ seconds: 3, seed: 5, std: 0.04 }),
		),
		mixInto(
			ctcssTone({ hz: 88.5, seconds: 2, seed: 6 }),
			dcsAudio({ code: 0o411, seconds: 2, seed: 7 }),
		),
	]
	for (const audio of audios) {
		const dcs = new DcsDecoder()
		const bank = new CtcssBank()
		for (const v of audio) {
			dcs.pushSample(v)
			bank.pushSample(v)
		}
		const rendered = renderPcm(audio, 8_000, "f32le")
		out.push({
			dcs: dcs.result(),
			ctcss: bank.result(),
			detector: detectorResult(rendered.pcm, 8_000, "f32le", 1_001),
		})
	}
	return out
}

describe("tone results unchanged by the WG7 streaming exports", () => {
	it("WG2 corpus", () => {
		expect(wg2Corpus()).toMatchInlineSnapshot(`
			[
			  {
			    "ctcssHz": 67,
			    "dcs": null,
			    "dtmf": null,
			  },
			  {
			    "ctcssHz": 100,
			    "dcs": null,
			    "dtmf": null,
			  },
			  {
			    "ctcssHz": 151.4,
			    "dcs": null,
			    "dtmf": null,
			  },
			  {
			    "ctcssHz": 203.5,
			    "dcs": null,
			    "dtmf": null,
			  },
			  {
			    "ctcssHz": 254.1,
			    "dcs": null,
			    "dtmf": null,
			  },
			  {
			    "ctcssHz": null,
			    "dcs": null,
			    "dtmf": "159#",
			  },
			]
		`)
	})
	it("WG6 corpus", () => {
		expect(wg6Corpus()).toMatchInlineSnapshot(`
			[
			  {
			    "ctcss": null,
			    "dcs": {
			      "code": "023",
			      "polarity": "normal",
			    },
			    "detector": {
			      "ctcssHz": null,
			      "dcs": {
			        "code": "023",
			        "polarity": "normal",
			      },
			      "dtmf": null,
			    },
			  },
			  {
			    "ctcss": null,
			    "dcs": {
			      "code": "116",
			      "polarity": "normal",
			    },
			    "detector": {
			      "ctcssHz": null,
			      "dcs": {
			        "code": "116",
			        "polarity": "normal",
			      },
			      "dtmf": null,
			    },
			  },
			  {
			    "ctcss": null,
			    "dcs": null,
			    "detector": {
			      "ctcssHz": null,
			      "dcs": null,
			      "dtmf": null,
			    },
			  },
			  {
			    "ctcss": null,
			    "dcs": {
			      "code": "411",
			      "polarity": "normal",
			    },
			    "detector": {
			      "ctcssHz": null,
			      "dcs": {
			        "code": "411",
			        "polarity": "normal",
			      },
			      "dtmf": null,
			    },
			  },
			]
		`)
	})
})
