/**
 * Endpoint address filter (docs/specs/receiver-endpoints 3.6): every spelling
 * of a non-unicast, loopback, link-local or mapped address is refused, in core
 * and in the bridge's copy alike.
 */
import { describe, expect, it } from "vitest"
import fc from "fast-check"
import { isDialableEndpoint } from "../../../src/core/endpoint-probe.js"
// @ts-expect-error plain ESM script without types
import { isDialableEndpoint as bridgeDialable } from "../../../scripts/pi-lan-bridge-select.mjs"

const filters: Array<[string, (address: string) => boolean]> = [
	["core", isDialableEndpoint],
	["bridge", bridgeDialable as (address: string) => boolean],
]

const byte = fc.integer({ min: 0, max: 255 })
const v4 = (a: number, b: number, c: number, d: number): string =>
	`${a}.${b}.${c}.${d}`

/** Blocked IPv4 ranges: 0/8, 127/8, 169.254/16, 224/4, 240/4, 255.255.255.255. */
const blockedV4 = fc.oneof(
	fc.tuple(fc.constant(0), byte, byte, byte),
	fc.tuple(fc.constant(127), byte, byte, byte),
	fc.tuple(fc.constant(169), fc.constant(254), byte, byte),
	fc.tuple(fc.integer({ min: 224, max: 255 }), byte, byte, byte),
)
/** Public-ish unicast IPv4 (documentation and private ranges). */
const unicastV4 = fc.oneof(
	fc.tuple(fc.constant(192), fc.constant(0), fc.constant(2), byte),
	fc.tuple(fc.constant(198), fc.constant(51), fc.constant(100), byte),
	fc.tuple(fc.constant(10), byte, byte, byte),
	fc.tuple(fc.constant(192), fc.constant(168), byte, byte),
)

type Hextets = number[]
const hex = (n: number) => n.toString(16)

/** Several valid spellings of the same IPv6 address. */
function spellings(h: Hextets): fc.Arbitrary<string> {
	const full = h.map(n => hex(n).padStart(4, "0")).join(":")
	const short = h.map(hex).join(":")
	// Compress the longest run of zero hextets (or none).
	let best = [-1, 0]
	for (let i = 0; i < 8; ) {
		if (h[i] !== 0) {
			i++
			continue
		}
		let j = i
		while (j < 8 && h[j] === 0) j++
		if (j - i > best[1]!) best = [i, j - i]
		i = j
	}
	const [at, len] = best as [number, number]
	const compressed =
		at < 0
			? short
			: `${h.slice(0, at).map(hex).join(":")}::${h
					.slice(at + len)
					.map(hex)
					.join(":")}`
	return fc.constantFrom(
		full,
		short,
		compressed,
		compressed.toUpperCase(),
		full.toUpperCase(),
	)
}

const mapped = (
	a: number,
	b: number,
	c: number,
	d: number,
): fc.Arbitrary<string> =>
	fc.oneof(
		spellings([0, 0, 0, 0, 0, 0xffff, (a << 8) | b, (c << 8) | d]),
		fc.constantFrom(
			`::ffff:${v4(a, b, c, d)}`,
			`0:0:0:0:0:ffff:${v4(a, b, c, d)}`,
			`::FFFF:${v4(a, b, c, d)}`,
		),
	)

const blockedV6 = fc.oneof(
	spellings([0, 0, 0, 0, 0, 0, 0, 0]),
	spellings([0, 0, 0, 0, 0, 0, 0, 1]),
	fc
		.tuple(
			fc.integer({ min: 0xfe80, max: 0xfebf }),
			fc.array(fc.integer({ min: 0, max: 0xffff }), {
				minLength: 7,
				maxLength: 7,
			}),
		)
		.chain(([first, rest]) => spellings([first, ...rest])),
	fc
		.tuple(
			fc.integer({ min: 0xff00, max: 0xffff }),
			fc.array(fc.integer({ min: 0, max: 0xffff }), {
				minLength: 7,
				maxLength: 7,
			}),
		)
		.chain(([first, rest]) => spellings([first, ...rest])),
	// Any IPv4-mapped address, whatever IPv4 it carries.
	fc.tuple(byte, byte, byte, byte).chain(([a, b, c, d]) => mapped(a, b, c, d)),
)

const unicastV6 = fc
	.array(fc.integer({ min: 0, max: 0xffff }), { minLength: 6, maxLength: 6 })
	.chain(rest => spellings([0x2001, 0xdb8, ...rest]))

describe("endpoint address filter", () => {
	for (const [name, dialable] of filters) {
		// Feature: receiver-endpoints, Property 4: Address filter is spelling-independent
		// Validates: Requirements 3.6
		it(`${name}: refuses every spelling of blocked IPv4, IPv6 and mapped addresses`, () => {
			fc.assert(
				fc.property(
					fc.oneof(
						blockedV4.map(([a, b, c, d]) => v4(a, b, c, d)),
						blockedV6,
					),
					address => {
						expect(dialable(address)).toBe(false)
					},
				),
				{ numRuns: 300 },
			)
		})

		it(`${name}: accepts unicast IPv4 and IPv6 in any spelling, rejects zone ids and names`, () => {
			fc.assert(
				fc.property(
					fc.oneof(
						unicastV4.map(([a, b, c, d]) => v4(a, b, c, d)),
						unicastV6,
					),
					address => {
						expect(dialable(address)).toBe(true)
						expect(dialable(`${address}%eth0`)).toBe(false)
					},
				),
				{ numRuns: 300 },
			)
			for (const address of [
				"0:0:0:0:0:0:0:1",
				"0::1",
				"0:0:0:0:0:0:0:0",
				"0:0:0:0:0:ffff:7f00:1",
				"::ffff:127.0.0.1",
				"fe80::1%eth0",
				"255.255.255.255",
				"wavekit-pi.local",
				"",
			])
				expect(dialable(address)).toBe(false)
		})
	}
})
