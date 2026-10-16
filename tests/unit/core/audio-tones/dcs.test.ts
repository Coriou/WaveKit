import { describe, expect, it } from "vitest"
import { DCS_STANDARD_CODES } from "@wavekit/api-types"
import type { AnalogTransmissionDcs } from "@wavekit/api-types"
import fc from "fast-check"
import { DcsDecoder, dcsTwin } from "../../../../src/core/audio-tones/dcs.js"
import {
	ctcssTone,
	dcsAudio,
	dcsBitStream,
	dcsWord,
	dtmfAudio,
	MASK23,
	mixInto,
	nrz,
	pinkNoise,
	speechLike,
	whiteNoise,
} from "./dcs-synth.js"
import { gaussian, mulberry32 } from "./synth.js"

const CODES = DCS_STANDARD_CODES.map(c => Number.parseInt(c, 8))
const octal = (code: number): string => code.toString(8).padStart(3, "0")

function decode(
	samples: ArrayLike<number>,
	decoder = new DcsDecoder(),
): AnalogTransmissionDcs | null {
	for (let i = 0; i < samples.length; i++) decoder.pushSample(samples[i] ?? 0)
	return decoder.result()
}

/**
 * Bits after a 10-bit alternating lead-in (the clock locks on the first transition) and a
 * 40-sample silent tail (flushes the last bit through the filter delay, not a further bit).
 */
function framed(
	bits: ArrayLike<number>,
	code: number,
	startBit = 0,
): Float64Array {
	// The lead-in ends with the complement of the word's cyclic predecessor bit, so no window
	// may borrow it.
	const pred =
		dcsBitStream({ code, bits: 1, startBit: (startBit + 22) % 23 })[0] ?? 0
	const lead = [0, 1, 0, 1, 0, 1, 0, 1, 0, 1].map(b => b ^ pred)
	const body = nrz([...lead, ...Array.from(bits)])
	const out = new Float64Array(body.length + 40)
	out.set(body)
	return out
}

/** What a stream of `code` sent with `inverted` reads as under the standard set. */
function expected(code: number, inverted: boolean): AnalogTransmissionDcs {
	const sent: AnalogTransmissionDcs = {
		code: octal(code),
		polarity: inverted ? "inverted" : "normal",
	}
	return inverted ? dcsTwin(sent) : sent
}

/** Readings that occur as three identical windows 23 bits apart (oracle for Property 9). */
function rotationsOf(word: number): Set<number> {
	const set = new Set<number>()
	for (let k = 0; k < 23; k++)
		set.add(((word >>> k) | (word << (23 - k))) & MASK23)
	return set
}
const WORD_CLASS = new Map<number, Set<number>>()
for (let c = 0; c < 512; c++) WORD_CLASS.set(c, rotationsOf(dcsWord(c)))

describe("DcsDecoder round trip (fast path)", () => {
	it("decodes all 104 codes in both polarities from clean NRZ", () => {
		for (const code of CODES) {
			for (const inverted of [false, true]) {
				const bits = dcsBitStream({
					code,
					bits: 23 * 5,
					startBit: code % 23,
					inverted,
				})
				const got = decode(nrz(bits, { offset: (code % 7) * 5 }))
				expect(got, `${octal(code)} ${inverted}`).toEqual(
					expected(code, inverted),
				)
			}
		}
	})

	it("reports normal for table codes (every table code has a table twin)", () => {
		expect(decode(nrz(dcsBitStream({ code: 0o23, bits: 120 })))).toEqual({
			code: "023",
			polarity: "normal",
		})
		expect(
			decode(nrz(dcsBitStream({ code: 0o23, bits: 120, inverted: true }))),
		).toEqual({ code: "047", polarity: "normal" })
	})

	it("needs the LSB-first order the encoder uses", () => {
		const got = decode(
			nrz(dcsBitStream({ code: 0o23, bits: 120, order: "msb" })),
		)
		expect(got).not.toEqual({ code: "023", polarity: "normal" })
	})
})

describe("dcsTwin", () => {
	it("maps 023N to 047I and back", () => {
		expect(dcsTwin({ code: "023", polarity: "normal" })).toEqual({
			code: "047",
			polarity: "inverted",
		})
		expect(dcsTwin({ code: "047", polarity: "inverted" })).toEqual({
			code: "023",
			polarity: "normal",
		})
	})

	it("is an involution onto the table for all 104 codes", () => {
		const listed = new Set(DCS_STANDARD_CODES)
		for (const code of DCS_STANDARD_CODES) {
			for (const polarity of ["normal", "inverted"] as const) {
				const twin = dcsTwin({ code, polarity })
				expect(listed.has(twin.code)).toBe(true)
				expect(twin.polarity).not.toBe(polarity)
				expect(dcsTwin(twin)).toEqual({ code, polarity })
			}
		}
	})

	it("returns a copy for malformed codes", () => {
		const bad: AnalogTransmissionDcs = { code: "9x", polarity: "normal" }
		const twin = dcsTwin(bad)
		expect(twin).toEqual(bad)
		expect(twin).not.toBe(bad)
	})
})

describe("DcsDecoder confirmation", () => {
	it("needs three words: 2 words + 22 bits is null, exactly 3 words confirm", () => {
		expect(
			decode(framed(dcsBitStream({ code: 0o23, bits: 68 }), 0o23)),
		).toBeNull()
		expect(
			decode(framed(dcsBitStream({ code: 0o23, bits: 69 }), 0o23)),
		).toEqual({
			code: "023",
			polarity: "normal",
		})
	})

	it("a corrupted bit in any of the three words prevents confirmation", () => {
		for (let flip = 0; flip < 69; flip++) {
			const bits = dcsBitStream({ code: 0o155, bits: 69, startBit: 4 })
			bits[flip] = (bits[flip] ?? 0) ^ 1
			expect(decode(framed(bits, 0o155, 4)), `bit ${flip}`).toBeNull()
		}
		expect(
			decode(
				framed(dcsBitStream({ code: 0o155, bits: 69, startBit: 4 }), 0o155, 4),
			),
		).toEqual({
			code: "155",
			polarity: "normal",
		})
	})

	it("alternating codes word by word stay null", () => {
		const bits: number[] = []
		for (let w = 0; w < 12; w++)
			bits.push(...dcsBitStream({ code: w % 2 === 0 ? 0o23 : 0o754, bits: 23 }))
		expect(decode(nrz(bits))).toBeNull()
	})

	it("keeps the last confirmed reading and resets", () => {
		const decoder = new DcsDecoder()
		decode(nrz(dcsBitStream({ code: 0o23, bits: 100 })), decoder)
		decode(nrz(dcsBitStream({ code: 0o754, bits: 100 })), decoder)
		expect(decoder.result()).toEqual({ code: "754", polarity: "normal" })
		decoder.reset()
		expect(decoder.result()).toBeNull()
		expect(
			decode(nrz(dcsBitStream({ code: 0o23, bits: 100 })), decoder),
		).toEqual({
			code: "023",
			polarity: "normal",
		})
	})

	it("silence, NaN and Infinity give null and do not throw", () => {
		expect(decode(new Float64Array(16_000))).toBeNull()
		const bad = new Float64Array(16_000)
		for (let i = 0; i < bad.length; i++)
			bad[i] = i % 3 === 0 ? Number.NaN : i % 3 === 1 ? Infinity : -Infinity
		expect(decode(bad)).toBeNull()
	})

	it("NaN bursts inside a DCS stream are treated as zeros", () => {
		const audio = nrz(dcsBitStream({ code: 0o23, bits: 23 * 8 }))
		for (let i = 0; i < 40; i++) audio[i * 7] = Number.NaN
		expect(decode(audio)).toEqual({ code: "023", polarity: "normal" })
	})

	it("tolerates a DC offset and a small clock error", () => {
		const bits = dcsBitStream({ code: 0o432, bits: 23 * 6, startBit: 9 })
		// 0.5 % fast transmitter clock.
		expect(decode(nrz(bits, { rate: 8_000 * 0.995, dc: 0.05 }))).toEqual({
			code: "432",
			polarity: "normal",
		})
	})
})

describe("DcsDecoder any-valid", () => {
	it("reports the lowest valid code among the rotations", () => {
		const decoder = new DcsDecoder({ codeSet: "any-valid" })
		// Code 0o001 is not in the table.
		const got = decode(
			nrz(dcsBitStream({ code: 1, bits: 100, startBit: 5 })),
			decoder,
		)
		let lowest = 512
		for (let c = 0; c < 512; c++)
			if (WORD_CLASS.get(c)?.has(dcsWord(1)) === true)
				lowest = Math.min(lowest, c)
		expect(got).toEqual({ code: octal(lowest), polarity: "normal" })
		expect(decode(nrz(dcsBitStream({ code: 1, bits: 100 })))).toBeNull()
	})

	it("decodes table codes too", () => {
		const decoder = new DcsDecoder({ codeSet: "any-valid" })
		const got = decode(nrz(dcsBitStream({ code: 0o23, bits: 100 })), decoder)
		expect(got?.polarity).toBe("normal")
		expect(
			WORD_CLASS.get(Number.parseInt(got?.code ?? "0", 8))?.has(dcsWord(0o23)),
		).toBe(true)
	})
})

describe("DcsDecoder audio path", () => {
	it("decodes a sample of codes under voice and noise", () => {
		const rand = mulberry32(42)
		for (let n = 0; n < 12; n++) {
			const code = CODES[Math.floor(rand() * CODES.length)] ?? 0o23
			const inverted = n % 2 === 1
			const seed = 1_000 + n
			const audio = dcsAudio({
				code,
				seconds: 1.5,
				seed,
				inverted,
				amplitude: 0.12,
			})
			mixInto(
				audio,
				highPass300(speechLike({ seconds: 1.5, seed, amplitude: 0.6 })),
			)
			mixInto(audio, whiteNoise({ seconds: 1.5, seed, std: 0.02 }))
			expect(decode(audio), `${octal(code)} ${inverted}`).toEqual(
				expected(code, inverted),
			)
		}
	})

	it("CTCSS-only and DTMF-only audio give null", () => {
		for (const hz of [67, 100, 131.8, 167.9, 203.5, 254.1]) {
			expect(
				decode(ctcssTone({ hz, seconds: 3, seed: hz })),
				`${hz}`,
			).toBeNull()
		}
		expect(decode(dtmfAudio({ seconds: 5, seed: 7 }))).toBeNull()
	})
})

/** One-pole-pair high-pass at 300 Hz (a transmitter's voice filter), 8 kHz. */
function highPass300(x: Float64Array): Float64Array {
	const k = Math.exp((-2 * Math.PI * 300) / 8_000)
	for (let pass = 0; pass < 2; pass++) {
		let prevIn = 0
		let prevOut = 0
		for (let i = 0; i < x.length; i++) {
			const v = x[i] ?? 0
			prevOut = k * (prevOut + v - prevIn)
			prevIn = v
			x[i] = prevOut
		}
	}
	return x
}

describe("DcsDecoder allocation", () => {
	it("pushSample keeps state in numbers only (by construction) and shares the table", () => {
		const decoder = new DcsDecoder()
		const before = Object.entries(decoder)
		decode(nrz(dcsBitStream({ code: 0o23, bits: 200 })), decoder)
		const after = Object.entries(decoder)
		expect(after.map(([k]) => k)).toEqual(before.map(([k]) => k))
		for (const [key, value] of after) {
			if (key === "map") {
				expect(value).toBe(before.find(([k]) => k === "map")?.[1])
				expect(value).toBe(
					(new DcsDecoder() as unknown as { map: unknown }).map,
				)
				continue
			}
			expect(["number", "boolean"], key).toContain(typeof value)
		}
	})
})

describe("DCS properties", () => {
	// Feature: web-gaps-6, Property 8: DCS round trip
	// Validates: Requirements 4.1, 4.3, 4.4, 4.5
	it("Property 8: any table code, polarity, start, phase, level and offset round-trips", () => {
		fc.assert(
			fc.property(
				fc.constantFrom(...CODES),
				fc.boolean(),
				fc.integer({ min: 0, max: 22 }),
				fc.double({ min: 0, max: 59, noNaN: true }),
				fc.double({ min: 0.01, max: 0.8, noNaN: true }),
				fc.double({ min: -0.2, max: 0.2, noNaN: true }),
				fc.integer({ min: 0, max: 2 ** 31 - 1 }),
				(code, inverted, startBit, offset, amplitude, dc, seed) => {
					const bits = dcsBitStream({ code, bits: 23 * 5, startBit, inverted })
					const audio = nrz(bits, { amplitude, offset, dc })
					const rand = mulberry32(seed)
					for (let i = 0; i < audio.length; i++)
						audio[i] = (audio[i] ?? 0) + amplitude * 0.1 * gaussian(rand)
					expect(decode(audio)).toEqual(expected(code, inverted))
				},
			),
			{ numRuns: 100 },
		)
	})

	// Feature: web-gaps-6, Property 9: DCS never guesses
	// Validates: Requirements 4.3, 4.8
	it("Property 9: random bits never confirm a reading absent from three clean words", () => {
		fc.assert(
			fc.property(fc.uint8Array({ minLength: 69, maxLength: 300 }), bytes => {
				const bits = bytes.map(b => b & 1)
				const got = decode(nrz(bits))
				if (got === null) return
				// Oracle: some window of 69 bits is three identical windows of a
				// word of the reported reading.
				expect(containsReading(bits, got)).toBe(true)
			}),
			{ numRuns: 100 },
		)
	})

	// Feature: web-gaps-6, Property 9: DCS never guesses
	// Validates: Requirements 4.3, 4.8
	it("Property 9: a noisy or corrupted code never reads as another code", () => {
		fc.assert(
			fc.property(
				fc.constantFrom(...CODES),
				fc.boolean(),
				fc.double({ min: 0, max: 0.08, noNaN: true }),
				fc.integer({ min: 0, max: 2 ** 31 - 1 }),
				(code, inverted, flipRate, seed) => {
					const rand = mulberry32(seed)
					const bits = dcsBitStream({ code, bits: 23 * 6, inverted })
					for (let i = 0; i < bits.length; i++)
						if (rand() < flipRate) bits[i] = (bits[i] ?? 0) ^ 1
					const got = decode(nrz(bits))
					if (got !== null) expect(got).toEqual(expected(code, inverted))
				},
			),
			{ numRuns: 100 },
		)
	})

	// Feature: web-gaps-6, Property 9: DCS never guesses
	// Validates: Requirements 4.3, 4.8
	it("Property 9: speech-like audio with noise never yields a code", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 0, max: 2 ** 31 - 1 }),
				fc.double({ min: 0.05, max: 0.9, noNaN: true }),
				(seed, level) => {
					const audio = speechLike({ seconds: 1, seed, amplitude: level })
					mixInto(
						audio,
						pinkNoise({ seconds: 1, seed: seed + 1, std: level / 4 }),
					)
					expect(decode(audio)).toBeNull()
				},
			),
			{ numRuns: 100 },
		)
	})
})

function containsReading(
	bits: ArrayLike<number>,
	got: AnalogTransmissionDcs,
): boolean {
	const code = Number.parseInt(got.code, 8)
	const cls = WORD_CLASS.get(code)
	if (cls === undefined) return false
	const invert = got.polarity === "inverted" ? MASK23 : 0
	let reg = 0
	const regs: number[] = []
	for (let i = 0; i < bits.length; i++) {
		reg = ((reg >>> 1) | ((bits[i] ?? 0) << 22)) & MASK23
		regs.push(i >= 22 ? reg ^ invert : -1)
	}
	for (let i = 22; i + 46 < regs.length; i++) {
		const r = regs[i] ?? -1
		if (cls.has(r) && regs[i + 23] === r && regs[i + 46] === r) return true
	}
	return false
}
