/**
 * WG11 requirements 1.7 and 1.8 (docs/specs/web-gaps-11): the known-protocol memory. The known
 * protocol of a discovery is the store's `protocol` while its `confidence` is `decoded`; this
 * module only adds the in-memory, per-process count of consecutive full-hold misses of that
 * protocol. Nothing is persisted and the store's fields are never changed here.
 *
 * Bound: an entry exists only for a discovery the store answered for when its miss was recorded
 * (a miss for an unknown id drops any entry) and `forget` drops an entry when the discovery is
 * deleted or merged away, so the live entries are at most the store's discoveries, i.e. at most
 * `storage.maxDiscoveries` (schema maximum 1 000 000). The hard cap
 * KNOWN_PROTOCOL_MEMORY_MAX_ENTRIES equals that schema maximum; at the cap a new entry first
 * sweeps entries whose discovery is gone (O(entries), only at the cap), and evicts the oldest
 * entry only when every entry is still live (impossible while the store honours its own cap).
 */
import type { KnownProtocolMemory } from "./known-protocol-contract.js"
import { KNOWN_PROTOCOL_MAX_MISSES } from "./known-protocol-contract.js"
import type { ScannerConfidence, ScannerProtocol } from "./types.js"

/** Schema maximum of `scanner.storage.maxDiscoveries` (src/config.ts). */
export const KNOWN_PROTOCOL_MEMORY_MAX_ENTRIES = 1_000_000

export interface KnownProtocolMemoryDeps {
	discovery: (
		id: string,
	) => { protocol: ScannerProtocol; confidence: ScannerConfidence } | undefined
}

interface MissEntry {
	/** The known protocol the misses were counted against. */
	protocol: ScannerProtocol
	misses: number
}

/**
 * The store's decoded protocol for `id`, or null on anything else: unknown id, not `decoded`,
 * a malformed answer or a throwing accessor (the safe answer: no known protocol).
 */
function decodedProtocol(
	deps: KnownProtocolMemoryDeps,
	id: string,
): ScannerProtocol | null {
	if (typeof id !== "string" || id.length === 0) return null
	let d: unknown
	try {
		d = deps.discovery(id)
	} catch {
		return null
	}
	if (typeof d !== "object" || d === null) return null
	const { protocol, confidence } = d as {
		protocol?: unknown
		confidence?: unknown
	}
	if (confidence !== "decoded") return null
	if (typeof protocol !== "string" || protocol.length === 0) return null
	return protocol as ScannerProtocol
}

export function createKnownProtocolMemory(
	deps: KnownProtocolMemoryDeps,
	opts: { maxEntries?: number } = {},
): KnownProtocolMemory & { readonly size: () => number } {
	const maxEntries =
		opts.maxEntries !== undefined &&
		Number.isInteger(opts.maxEntries) &&
		opts.maxEntries > 0
			? Math.min(opts.maxEntries, KNOWN_PROTOCOL_MEMORY_MAX_ENTRIES)
			: KNOWN_PROTOCOL_MEMORY_MAX_ENTRIES
	const misses = new Map<string, MissEntry>()

	const makeRoom = (): void => {
		if (misses.size < maxEntries) return
		for (const id of [...misses.keys()]) {
			if (decodedProtocol(deps, id) === null) misses.delete(id)
		}
		if (misses.size < maxEntries) return
		const oldest = misses.keys().next()
		if (oldest.done !== true) misses.delete(oldest.value)
	}

	return {
		size: () => misses.size,
		known(discoveryId) {
			const protocol = decodedProtocol(deps, discoveryId)
			if (protocol === null) return null
			const e = misses.get(discoveryId)
			// Misses counted against another protocol do not apply to the store's current one.
			if (
				e !== undefined &&
				e.protocol === protocol &&
				e.misses >= KNOWN_PROTOCOL_MAX_MISSES
			) {
				return null
			}
			return protocol
		},
		recordMiss(discoveryId, protocol) {
			const current = decodedProtocol(deps, discoveryId)
			if (current === null) {
				// Unknown, undecoded or unreadable discovery: nothing is known, so nothing can
				// decay; drop any entry so the map only holds live discoveries.
				misses.delete(discoveryId)
				return
			}
			// Only a miss of the current known protocol decays it: a trial of another protocol
			// that did not decode says nothing about the remembered one (it is just one of the
			// other plausible trials), and counting it would decay a correct memory.
			if (protocol !== current) return
			const e = misses.get(discoveryId)
			if (e !== undefined && e.protocol === current) {
				// Saturate at the threshold: the value only needs to say "decayed".
				e.misses = Math.min(e.misses + 1, KNOWN_PROTOCOL_MAX_MISSES)
				return
			}
			if (e === undefined) makeRoom()
			misses.set(discoveryId, { protocol: current, misses: 1 })
		},
		recordDecode(discoveryId) {
			misses.delete(discoveryId)
		},
		forget(discoveryId) {
			misses.delete(discoveryId)
		},
	}
}
