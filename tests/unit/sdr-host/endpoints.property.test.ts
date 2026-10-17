import { describe, expect, it } from "vitest"
import fc from "fast-check"
import type { SdrHostNetworkInterface } from "@wavekit/api-types"
import { rankEndpoints } from "../../../packages/sdr-host/src/telemetry/endpoints.js"

const address = fc.oneof(
	fc.ipV4(),
	fc.ipV6(),
	fc.constantFrom(
		"127.0.0.1",
		"169.254.1.1",
		"fe80::1",
		"::1",
		"::ffff:10.0.0.1",
	),
)

const networkInterface: fc.Arbitrary<SdrHostNetworkInterface> = fc.record({
	name: fc.stringMatching(/^[a-z]{2,5}\d$/),
	kind: fc.constantFrom("ethernet", "wireless", "other"),
	operstate: fc.constantFrom("up", "down", "unknown"),
	addresses: fc.array(address, { maxLength: 4 }),
	rxBytesPerSec: fc.constant(null),
	txBytesPerSec: fc.constant(null),
	wireless: fc.option(
		fc.record({
			linkQuality: fc.nat(70),
			signalDbm: fc.integer({ min: -95, max: -20 }),
		}),
		{ nil: null },
	),
	speedMbps: fc.option(fc.constantFrom(10, 100, 1000), { nil: null }),
	defaultRouteMetric: fc.option(fc.nat(20_000), { nil: null }),
})

const undialable = (a: string): boolean =>
	a.startsWith("127.") ||
	a.startsWith("169.254.") ||
	a === "::1" ||
	/^fe[89ab]/i.test(a) ||
	a.toLowerCase().startsWith("::ffff:")

describe("receiver endpoint ranking", () => {
	// Feature: receiver-endpoints, Property 1: Ranking order
	// Validates: Requirements 1.2, 1.3
	it("lists only dialable addresses of up interfaces, wired with carrier before Wi-Fi, metric then IPv4 first", () => {
		fc.assert(
			fc.property(
				fc.uniqueArray(networkInterface, {
					maxLength: 6,
					selector: i => i.name,
				}),
				interfaces => {
					const ranked = rankEndpoints(interfaces)
					const source = (name: string): SdrHostNetworkInterface => {
						const found = interfaces.find(i => i.name === name)
						if (!found) throw new Error("unknown interface")
						return found
					}
					for (const e of ranked) {
						expect(undialable(e.address)).toBe(false)
						expect(
							interfaces.some(
								i =>
									i.name === e.interface &&
									i.operstate === "up" &&
									i.addresses.includes(e.address),
							),
						).toBe(true)
					}
					const rank = (name: string): number => {
						const i = source(name)
						return i.kind === "ethernet" && i.speedMbps !== null
							? 0
							: i.kind === "wireless"
								? 2
								: 1
					}
					for (let n = 1; n < ranked.length; n++) {
						const a = ranked[n - 1]
						const b = ranked[n]
						if (!a || !b) continue
						expect(rank(a.interface)).toBeLessThanOrEqual(rank(b.interface))
						if (rank(a.interface) === rank(b.interface)) {
							const ma = source(a.interface).defaultRouteMetric ?? Infinity
							const mb = source(b.interface).defaultRouteMetric ?? Infinity
							expect(ma).toBeLessThanOrEqual(mb)
							if (
								ma === mb &&
								a.interface === b.interface &&
								a.family !== b.family
							)
								expect(a.family).toBe("IPv4")
						}
					}
				},
			),
			{ numRuns: 200 },
		)
	})
})
