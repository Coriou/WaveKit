/**
 * dsd-fme UDP voice datagrams -> mono s16le.
 */

import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import * as fc from "fast-check"
import {
	DSD_FME_DATAGRAM_FRAMES,
	downmixDsdFmeDatagram,
} from "../../../src/core/dsd-fme-voice-format.js"

function fixture(name: string): { sizes: number[]; payload: Buffer } {
	const dir = new URL("../../mocks/fixtures/dsd-fme/", import.meta.url)
	const sizes = readFileSync(fileURLToPath(new URL(`${name}.txt`, dir)), "utf8")
		.split("\n")
		.filter(line => line && !line.startsWith("#"))
		.map(line => Number(line.split("\t")[1]))
	const payload = readFileSync(fileURLToPath(new URL(`${name}.bin`, dir)))
	return { sizes, payload }
}

function stereo(left: number[], right: number[]): Buffer {
	const buf = Buffer.alloc(left.length * 4)
	left.forEach((l, i) => {
		buf.writeInt16LE(l, i * 4)
		buf.writeInt16LE(right[i]!, i * 4 + 2)
	})
	return buf
}

function mono(buf: Buffer): number[] {
	const out: number[] = []
	for (let i = 0; i < buf.length; i += 2) out.push(buf.readInt16LE(i))
	return out
}

describe("downmixDsdFmeDatagram", () => {
	it("matches the captured auto-mode format: 640-byte stereo datagrams with L == R", () => {
		const { sizes, payload } = fixture("udp-ysf-auto-stereo")
		expect(new Set(sizes)).toEqual(new Set([DSD_FME_DATAGRAM_FRAMES * 4]))
		let offset = 0
		for (const size of sizes) {
			const datagram = payload.subarray(offset, offset + size)
			offset += size
			const out = downmixDsdFmeDatagram(datagram, 2)!
			expect(out).toHaveLength(DSD_FME_DATAGRAM_FRAMES * 2)
			for (let i = 0; i < DSD_FME_DATAGRAM_FRAMES; i++) {
				expect(out.readInt16LE(i * 2)).toBe(datagram.readInt16LE(i * 4))
			}
		}
	})

	it("passes the captured YSF-mode 320-byte mono datagrams through", () => {
		const { sizes, payload } = fixture("udp-ysf-mono")
		expect(new Set(sizes)).toEqual(new Set([DSD_FME_DATAGRAM_FRAMES * 2]))
		const first = payload.subarray(0, sizes[0])
		expect(downmixDsdFmeDatagram(first, 1)!.equals(first)).toBe(true)
	})

	it("keeps the active slot when the other is zero-filled (muted or encrypted)", () => {
		expect(mono(downmixDsdFmeDatagram(stereo([5, -7], [0, 0]), 2)!)).toEqual([
			5, -7,
		])
		expect(mono(downmixDsdFmeDatagram(stereo([0, 0], [9, 3]), 2)!)).toEqual([
			9, 3,
		])
	})

	it("averages two active slots so simultaneous calls cannot clip", () => {
		expect(
			mono(downmixDsdFmeDatagram(stereo([32767, 100], [32767, -50]), 2)!),
		).toEqual([32767, 25])
	})

	it("rejects empty, partial-frame and oversized datagrams", () => {
		expect(downmixDsdFmeDatagram(Buffer.alloc(0), 2)).toBeNull()
		expect(downmixDsdFmeDatagram(Buffer.alloc(642), 2)).toBeNull()
		expect(downmixDsdFmeDatagram(Buffer.alloc(321), 1)).toBeNull()
		expect(downmixDsdFmeDatagram(Buffer.alloc(8192), 2)).toBeNull()
	})

	// Feature: digital-voice, Property 2: stereo downmix stays in range and preserves length
	// Validates: ROADMAP 5b one mixed mono stream
	it("produces one in-range mono sample per stereo frame", () => {
		fc.assert(
			fc.property(
				fc.array(
					fc.tuple(
						fc.integer({ min: -32768, max: 32767 }),
						fc.integer({ min: -32768, max: 32767 }),
					),
					{ minLength: 1, maxLength: 960 },
				),
				frames => {
					const left = frames.map(f => f[0])
					const right = frames.map(f => f[1])
					const out = mono(downmixDsdFmeDatagram(stereo(left, right), 2)!)
					expect(out).toHaveLength(frames.length)
					for (const [i, sample] of out.entries()) {
						const lo = Math.min(left[i]!, right[i]!)
						const hi = Math.max(left[i]!, right[i]!)
						// One channel verbatim or the rounded average: within [lo, hi].
						expect(sample).toBeGreaterThanOrEqual(lo)
						expect(sample).toBeLessThanOrEqual(hi)
					}
				},
			),
			{ numRuns: 100 },
		)
	})
})
