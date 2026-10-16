/**
 * WG6 req 5.2: the resolved-address policy of the band-plan URL fetcher. An address is
 * allowed only when `node:net` classifies it and it lies in no refused block. IPv4 and IPv6
 * rules live in separate lists because one `BlockList` also matches IPv4 against IPv4-mapped
 * IPv6 rules. IPv4-mapped (::ffff:0:0/96) and NAT64 (64:ff9b::/96) addresses are refused as
 * blocks and their embedded IPv4 is checked as well.
 */
import { BlockList, isIP } from "node:net"

/** IPv4 refused blocks: [network, prefix]. */
export const REFUSED_IPV4_BLOCKS: readonly (readonly [string, number])[] =
	Object.freeze([
		["0.0.0.0", 8],
		["10.0.0.0", 8],
		["100.64.0.0", 10],
		["127.0.0.0", 8],
		["169.254.0.0", 16],
		["172.16.0.0", 12],
		["192.0.0.0", 24],
		["192.0.2.0", 24],
		["192.168.0.0", 16],
		["198.18.0.0", 15],
		["198.51.100.0", 24],
		["203.0.113.0", 24],
		["224.0.0.0", 4],
		["240.0.0.0", 4],
		["255.255.255.255", 32],
	] as const)
/** IPv6 refused blocks: [network, prefix]. */
export const REFUSED_IPV6_BLOCKS: readonly (readonly [string, number])[] =
	Object.freeze([
		["::", 128],
		["::1", 128],
		["::", 96],
		["::ffff:0:0", 96],
		["64:ff9b::", 96],
		["64:ff9b:1::", 48],
		["100::", 64],
		["2001::", 32],
		["2002::", 16],
		["2001:db8::", 32],
		["fc00::", 7],
		["fe80::", 10],
		["fec0::", 10],
		["ff00::", 8],
	] as const)

const ipv4Refused = new BlockList()
for (const [net, prefix] of REFUSED_IPV4_BLOCKS)
	ipv4Refused.addSubnet(net, prefix, "ipv4")
const ipv6Refused = new BlockList()
for (const [net, prefix] of REFUSED_IPV6_BLOCKS)
	ipv6Refused.addSubnet(net, prefix, "ipv6")

/** Decides whether the fetcher may connect to one resolved address. */
export type AddressPolicy = (address: string) => boolean

/** Expands a valid IPv6 text form to its eight 16-bit groups; undefined when it cannot. */
function ipv6Groups(address: string): number[] | undefined {
	let text = address
	const groups: number[] = []
	const lastColon = text.lastIndexOf(":")
	const tail = text.slice(lastColon + 1)
	let v4Tail: number[] | undefined
	if (tail.includes(".")) {
		if (isIP(tail) !== 4) return undefined
		const octets = tail.split(".").map(Number)
		v4Tail = [
			((octets[0] ?? 0) << 8) | (octets[1] ?? 0),
			((octets[2] ?? 0) << 8) | (octets[3] ?? 0),
		]
		text = `${text.slice(0, lastColon + 1)}0:0`
	}
	const halves = text.split("::")
	if (halves.length > 2) return undefined
	const parse = (part: string): number[] =>
		part === "" ? [] : part.split(":").map(h => Number.parseInt(h, 16))
	const head = parse(halves[0] ?? "")
	if (halves.length === 2) {
		const rest = parse(halves[1] ?? "")
		const fill = 8 - head.length - rest.length
		if (fill < 0) return undefined
		groups.push(...head, ...new Array<number>(fill).fill(0), ...rest)
	} else groups.push(...head)
	if (groups.length !== 8 || groups.some(g => !Number.isInteger(g)))
		return undefined
	if (v4Tail) {
		groups[6] = v4Tail[0] ?? 0
		groups[7] = v4Tail[1] ?? 0
	}
	return groups
}

/** The IPv4 embedded in an IPv4-mapped or NAT64 (64:ff9b::/96) address, else undefined. */
export function embeddedIpv4(address: string): string | undefined {
	const g = ipv6Groups(address)
	if (!g) return undefined
	const mapped =
		g[0] === 0 &&
		g[1] === 0 &&
		g[2] === 0 &&
		g[3] === 0 &&
		g[4] === 0 &&
		g[5] === 0xffff
	const nat64 =
		g[0] === 0x64 &&
		g[1] === 0xff9b &&
		g[2] === 0 &&
		g[3] === 0 &&
		g[4] === 0 &&
		g[5] === 0
	if (!mapped && !nat64) return undefined
	const hi = g[6] ?? 0
	const lo = g[7] ?? 0
	return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`
}

/** True when the address is refused: unclassifiable, scoped, or inside a refused block. */
export function isRefusedAddress(address: string): boolean {
	if (typeof address !== "string" || address.includes("%")) return true
	try {
		const family = isIP(address)
		if (family === 4) return ipv4Refused.check(address, "ipv4")
		if (family !== 6) return true
		if (ipv6Refused.check(address, "ipv6")) return true
		const v4 = embeddedIpv4(address)
		return v4 !== undefined && ipv4Refused.check(v4, "ipv4")
	} catch {
		return true
	}
}

/** The production policy: public unicast addresses only. */
export const defaultAddressPolicy: AddressPolicy = address =>
	!isRefusedAddress(address)
