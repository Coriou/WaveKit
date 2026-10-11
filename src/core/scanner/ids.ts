/**
 * Scanner identifiers (decision D5): a dependency-free ULID generator, a short
 * stable hash for embedding job ids in decoder ids, and the probe id builder
 * of spec § 6.5 (`scan-${jobShort}-${protocolShort}-${seq}`, ≤ 32 chars,
 * `[a-z0-9-]`, so channelizer socket paths stay under MAX_SOCKET_PATH).
 */
import { randomFillSync } from "node:crypto"
import { WaveKitError } from "../../utils/errors.js"

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
const TIME_CHARS = 10
const RANDOM_CHARS = 16
const MAX_TIME = 2 ** 48 - 1
const MAX_SEQ = 9_999_999_999

let lastTime = -1
const lastRandom = new Uint8Array(RANDOM_CHARS) // base32 digits, 0..31

function freshRandom(): void {
	const bytes = randomFillSync(new Uint8Array(RANDOM_CHARS))
	for (let i = 0; i < RANDOM_CHARS; i++) lastRandom[i] = bytes[i]! & 31
}

function incrementRandom(): void {
	for (let i = RANDOM_CHARS - 1; i >= 0; i--) {
		const digit = lastRandom[i]!
		if (digit < 31) {
			lastRandom[i] = digit + 1
			return
		}
		lastRandom[i] = 0
	}
	throw new WaveKitError(
		"ULID random component overflowed within one millisecond",
		"SCANNER_ULID_OVERFLOW",
	)
}

/**
 * 26-character Crockford base32 ULID. Ids generated in this process sort
 * strictly ascending: within one millisecond (or if the clock steps back) the
 * random component of the previous id is incremented.
 */
export function ulid(now: number = Date.now()): string {
	if (!Number.isInteger(now) || now < 0 || now > MAX_TIME) {
		throw new WaveKitError(
			`ULID time out of range: ${now}`,
			"SCANNER_ULID_TIME",
		)
	}
	if (now > lastTime) {
		lastTime = now
		freshRandom()
	} else {
		incrementRandom()
	}
	let time = lastTime
	const out = new Array<string>(TIME_CHARS + RANDOM_CHARS)
	for (let i = TIME_CHARS - 1; i >= 0; i--) {
		out[i] = CROCKFORD[time % 32]!
		time = Math.floor(time / 32)
	}
	for (let i = 0; i < RANDOM_CHARS; i++)
		out[TIME_CHARS + i] = CROCKFORD[lastRandom[i]!]!
	return out.join("")
}

/** Stable 7-character `[a-z0-9]` digest (FNV-1a, 32 bit, base 36) of any string. */
export function shortId(s: string): string {
	let h = 0x811c9dc5
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i)
		h = Math.imul(h, 0x01000193) >>> 0
	}
	return h.toString(36).padStart(7, "0")
}

/**
 * Probe decoder id `scan-${jobShort}-${protocolShort}-${seq}`. `jobShort` must
 * be a shortId(); `protocolShort` is reduced to `[a-z0-9]` and cut to 8 chars;
 * `seq` is the process-wide monotonic probe counter.
 */
export function probeId(
	jobShort: string,
	protocolShort: string,
	seq: number,
): string {
	if (!/^[a-z0-9]{1,7}$/.test(jobShort)) {
		throw new WaveKitError(
			`Invalid job short id: ${jobShort}`,
			"SCANNER_PROBE_ID",
		)
	}
	const proto = protocolShort
		.toLowerCase()
		.replace(/[^a-z0-9]/g, "")
		.slice(0, 8)
	if (proto.length === 0) {
		throw new WaveKitError(
			`Invalid protocol short name: ${protocolShort}`,
			"SCANNER_PROBE_ID",
		)
	}
	if (!Number.isSafeInteger(seq) || seq < 0 || seq > MAX_SEQ) {
		throw new WaveKitError(`Invalid probe sequence: ${seq}`, "SCANNER_PROBE_ID")
	}
	// 5 + 7 + 1 + 8 + 1 + 10 = 32 characters at most.
	return `scan-${jobShort}-${proto}-${seq}`
}
