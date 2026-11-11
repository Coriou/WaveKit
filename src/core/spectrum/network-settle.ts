/**
 * The one settle rule for a tuning write on a network source: the receiver's new tuning is
 * visible in the payload no later than `settle = max(configured settle, in-flight estimate)` after
 * the frame was flushed to the socket.
 *
 * The configured settle (`scanner.sweep.settleMs[link]`, network default 1000 ms) covers the receiver
 * itself (PLL lock, USB transfers inside rtl_tcp or rtlmux). The in-flight estimate covers payload
 * bytes the receiver produced *before* it executed the frame and that are still between it and the
 * core when the frame leaves: they reach the core after the frame and carry the old tuning.
 *
 * Pure: no imports.
 */

/**
 * An ESTIMATE, not a bound, of the payload bytes that may still be in flight towards the core when
 * a frame is flushed: the core's socket receive buffer plus the peer's send buffer, 256 KiB each
 * on a default Linux or macOS TCP socket (net.core.rmem_default / wmem_default 212 992 B rounded
 * up, macOS 128-256 KiB), so 2 × 256 KiB = 512 KiB. It is an estimate because none of it is
 * measured: kernels autotune both buffers well past their defaults on a fast link, and rtlmux's
 * own fan-out buffer and any proxy in between are not in it (residual risk, measured live before
 * consumers read the ledger; SettleLink.inFlightBytes overrides it for a measured link). At
 * 2.4 Msps U8 IQ (4.8 MB/s) it is 109 ms, below the configured 1000 ms; at 250 ksps (0.5 MB/s) it
 * is 1.05 s and becomes the binding term.
 */
export const IN_FLIGHT_BOUND_BYTES = 2 * 256 * 1024

export interface SettleLink {
	/** The configured settle in ms of the source's link (`scanner.sweep.settleMs[link]`). */
	configuredSettleMs: number
	/** Override of the IN_FLIGHT_BOUND_BYTES estimate (tests, measured links). */
	inFlightBytes?: number
}

/**
 * Settle in payload bytes at `rateHz` samples/s of `frameBytes` bytes each:
 * `max(ceil(configuredMs × rate × frameBytes / 1000), inFlightBytes)`. A non-finite or
 * non-positive rate cannot be converted, so the answer is +Infinity (nothing ever settles).
 */
export function settleBytes(
	rateHz: number,
	frameBytes: number,
	link: SettleLink,
): number {
	if (
		!Number.isFinite(rateHz) ||
		rateHz <= 0 ||
		!Number.isFinite(frameBytes) ||
		frameBytes <= 0
	)
		return Number.POSITIVE_INFINITY
	const configured = Number.isFinite(link.configuredSettleMs)
		? Math.max(0, link.configuredSettleMs)
		: Number.POSITIVE_INFINITY
	const inFlight = link.inFlightBytes ?? IN_FLIGHT_BOUND_BYTES
	const configuredBytes = Math.ceil((configured * rateHz * frameBytes) / 1000)
	return Math.max(
		configuredBytes,
		Number.isFinite(inFlight) && inFlight >= 0
			? inFlight
			: Number.POSITIVE_INFINITY,
	)
}

/** The same settle in ms: `max(configured, inFlightBytes / (rate × frameBytes) × 1000)`. */
export function settleMs(
	rateHz: number,
	frameBytes: number,
	link: SettleLink,
): number {
	const bytes = settleBytes(rateHz, frameBytes, link)
	if (!Number.isFinite(bytes)) return Number.POSITIVE_INFINITY
	return (bytes * 1000) / (rateHz * frameBytes)
}

/**
 * A source's settle link, the same rule as the scanner's (`linkOf` in scanner-service.ts):
 * loopback hosts are local, every other host (and a missing config) is the network.
 */
export function settleLinkOf(
	cfg: { host?: string | undefined } | undefined,
): "local" | "network" {
	if (!cfg) return "network"
	const host = cfg.host ?? "127.0.0.1"
	return host === "127.0.0.1" || host === "localhost" || host === "::1"
		? "local"
		: "network"
}
