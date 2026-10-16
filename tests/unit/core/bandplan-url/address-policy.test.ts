import { describe, expect, it } from "vitest"
import fc from "fast-check"
import {
	embeddedIpv4,
	isRefusedAddress,
} from "../../../../src/core/bandplan-url/index.js"

describe("address policy (rule 2)", () => {
	it.each([
		"0.0.0.0",
		"0.1.2.3",
		"10.0.0.1",
		"100.64.0.1",
		"100.127.255.255",
		"127.0.0.1",
		"127.255.255.254",
		"169.254.169.254",
		"172.16.0.1",
		"172.31.255.255",
		"192.0.0.8",
		"192.0.2.1",
		"192.168.1.1",
		"198.18.0.1",
		"198.19.255.255",
		"198.51.100.7",
		"203.0.113.9",
		"224.0.0.1",
		"239.255.255.255",
		"240.0.0.1",
		"255.255.255.255",
		"::",
		"::1",
		"::ffff:10.0.0.1",
		"::ffff:a00:1",
		"::ffff:8.8.8.8",
		"64:ff9b::a00:1",
		"64:ff9b::8.8.8.8",
		"100::1",
		"2001:db8::1",
		"fc00::1",
		"fd00::",
		"fe80::1",
		"febf::1",
		"fe80::1%eth0",
		"ff02::1",
		"",
		"localhost",
		"not-an-ip",
		"1.2.3",
		"0x7f.0.0.1",
		" 8.8.8.8",
	])("refuses %s", address => {
		expect(isRefusedAddress(address)).toBe(true)
	})

	it.each([
		"8.8.8.8",
		"185.199.108.133",
		"100.63.255.255",
		"100.128.0.0",
		"172.15.255.255",
		"172.32.0.0",
		"198.17.255.255",
		"198.20.0.0",
		"223.255.255.255",
		"2606:50c0:8000::154",
		"2001:4860:4860::8888",
		"::2",
		"fec0::1",
	])("allows %s", address => {
		expect(isRefusedAddress(address)).toBe(false)
	})

	it("extracts embedded IPv4 from mapped and NAT64 forms", () => {
		expect(embeddedIpv4("::ffff:10.0.0.1")).toBe("10.0.0.1")
		expect(embeddedIpv4("::ffff:a00:1")).toBe("10.0.0.1")
		expect(embeddedIpv4("64:ff9b::a00:1")).toBe("10.0.0.1")
		expect(embeddedIpv4("64:ff9b:0:0:0:0:7f00:1")).toBe("127.0.0.1")
		expect(embeddedIpv4("2001:4860::1")).toBeUndefined()
	})

	it("refuses every mapped / NAT64 form of a refused IPv4 (property)", () => {
		fc.assert(
			fc.property(
				fc.ipV4(),
				fc.constantFrom("::ffff:", "64:ff9b::"),
				fc.boolean(),
				(v4, prefix, hex) => {
					const o = v4.split(".").map(Number)
					const tail = hex
						? `${(((o[0] ?? 0) << 8) | (o[1] ?? 0)).toString(16)}:${(((o[2] ?? 0) << 8) | (o[3] ?? 0)).toString(16)}`
						: v4
					expect(embeddedIpv4(`${prefix}${tail}`)).toBe(v4)
					expect(isRefusedAddress(`${prefix}${tail}`)).toBe(true)
				},
			),
			{ numRuns: 200 },
		)
	})
})
