import { randomBytes } from "node:crypto"
import { isIP } from "node:net"
import type {
	SdrHostEndpoint,
	SdrHostEndpoints,
	SdrHostNetworkInterface,
	SdrHostTelemetry,
} from "@wavekit/api-types"

const KIND_RANK: Record<SdrHostNetworkInterface["kind"], number> = {
	ethernet: 0,
	other: 1,
	wireless: 2,
}

/** One running sdr-host; the same on every address it serves. */
export function createReceiverId(): string {
	return randomBytes(16).toString("hex")
}

function usable(address: string): "IPv4" | "IPv6" | null {
	const family = isIP(address)
	if (family === 4)
		return address.startsWith("127.") || address.startsWith("169.254.")
			? null
			: "IPv4"
	if (family === 6) {
		const lower = address.toLowerCase()
		// Loopback, link-local (fe80::/10) and IPv4-mapped forms are not dialable endpoints.
		if (
			lower === "::1" ||
			/^fe[89ab]/.test(lower) ||
			lower.startsWith("::ffff:")
		)
			return null
		return "IPv6"
	}
	return null
}

/**
 * Every address a client may dial for this receiver, best first: a wired link
 * with carrier, then other links, Wi-Fi last; lower default-route metric
 * within a kind; IPv4 before IPv6. Says nothing about reachability from any
 * particular client.
 */
export function rankEndpoints(
	interfaces: readonly SdrHostNetworkInterface[],
): SdrHostEndpoint[] {
	const ranked = interfaces
		.filter(i => i.operstate === "up")
		.flatMap(i =>
			i.addresses.flatMap(address => {
				const family = usable(address)
				if (family === null) return []
				const kind =
					i.kind === "ethernet" && i.speedMbps === null ? "other" : i.kind
				return [{ i, address, family, kindRank: KIND_RANK[kind] }]
			}),
		)
		.sort(
			(a, b) =>
				a.kindRank - b.kindRank ||
				(a.i.defaultRouteMetric ?? Infinity) -
					(b.i.defaultRouteMetric ?? Infinity) ||
				(a.family === b.family ? 0 : a.family === "IPv4" ? -1 : 1) ||
				a.i.name.localeCompare(b.i.name),
		)
	return ranked.map(({ i, address, family }) => ({
		address,
		family,
		interface: i.name,
		kind: i.kind,
		speedMbps: i.speedMbps,
		signalDbm: i.wireless?.signalDbm ?? null,
	}))
}

/** Endpoints from the cached host network reading; never measured per request. */
export function endpointsFromTelemetry(
	network: SdrHostTelemetry["network"],
	ports: { iqPort: number; apiPort: number },
): SdrHostEndpoints | null {
	if (network.state === "unavailable" || network.value === null) return null
	return { ...ports, addresses: rankEndpoints(network.value) }
}
