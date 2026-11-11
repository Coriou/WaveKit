/**
 * Receiver identity: which physical receiver a source's connection reaches, so learned
 * state (spur maps, noise floors, occupancy, the pre-band gain, the accepted tuning) is applied
 * only to the receiver it was learned on. Pure functions; the tracker
 * (receiver-identity-tracker.ts) follows connections and the learned-state manager
 * (receiver-identity-state.ts) namespaces the files.
 *
 * Key, strongest first:
 * - `sdrhost:<receiverId>`: the configured sdr-host's own receiverId (32 lower-case hex);
 * - `serial:<vendor>:<product>:<serial>`: the dongle's USB strings as the sdr-host reports them;
 * - `model:<tunerType>:<gainCount>`: the rtl_tcp header alone (any dongle of that model);
 * - `unknown`: nothing usable; no learned state is applied or written.
 * Every component is validated (charset and length) before it is used in a key or a file name;
 * anything else is dropped, so a malformed peer answer only ever weakens the identity.
 */
import { createHash } from "node:crypto"

export type ReceiverStrength = "unit" | "model" | "unknown"

export interface ReceiverIdentity {
	key: string
	strength: ReceiverStrength
	tunerType?: number
	gainCount?: number
	serial?: string
	receiverId?: string
}

/** What the configured sdr-host said about its dongle, already validated. */
export interface SdrHostIdentityFacts {
	receiverId?: string
	vendor?: string
	product?: string
	serial?: string
}

export const UNKNOWN_RECEIVER_KEY = "unknown"
const RECEIVER_ID = /^[0-9a-f]{32}$/
/**
 * USB strings: letters, digits, `.`, `_`, `-`, 1 to 32 characters (an RTL-SDR serial is 8 digits;
 * USB string descriptors allow more, which is refused rather than truncated: a cut serial could
 * name another dongle).
 */
const USB_STRING = /^[A-Za-z0-9._-]{1,32}$/
/**
 * rtl_tcp header fields are uint32; the tuner type enum has 7 values today and an R820T reports
 * 29 gains. 255 bounds both well above any real dongle; a larger value is a malformed header.
 */
export const RECEIVER_HEADER_FIELD_MAX = 255
/**
 * Longest key: `serial:` (7) + three 32-character strings + two `:` = 105; `sdrhost:` + 32 = 40;
 * `model:255:255` = 13. 128 leaves room and bounds anything read back from disk.
 */
export const RECEIVER_KEY_MAX_LENGTH = 128
const KEY_PATTERN =
	/^(?:sdrhost:[0-9a-f]{32}|serial:[A-Za-z0-9._-]{1,32}:[A-Za-z0-9._-]{1,32}:[A-Za-z0-9._-]{1,32}|model:\d{1,3}:\d{1,3})$/

/** True for a key this module could have built (used for keys read back from disk). */
export function isReceiverKey(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length <= RECEIVER_KEY_MAX_LENGTH &&
		KEY_PATTERN.test(value)
	)
}

export function strengthOfKey(key: string): ReceiverStrength {
	if (key.startsWith("sdrhost:") || key.startsWith("serial:")) return "unit"
	if (key.startsWith("model:")) return "model"
	return "unknown"
}

export const STRENGTH_RANK: Readonly<Record<ReceiverStrength, number>> = {
	unknown: 0,
	model: 1,
	unit: 2,
}

function usbString(value: unknown): string | undefined {
	return typeof value === "string" && USB_STRING.test(value) ? value : undefined
}

function headerField(value: unknown): number | undefined {
	return typeof value === "number" &&
		Number.isInteger(value) &&
		value >= 0 &&
		value <= RECEIVER_HEADER_FIELD_MAX
		? value
		: undefined
}

/**
 * The sdr-host status body's identity fields (`receiverId`, `dongle.vendor/product/serial`),
 * each kept only when valid. Never throws; any shape is accepted as input.
 */
export function parseSdrHostIdentity(body: unknown): SdrHostIdentityFacts {
	const out: SdrHostIdentityFacts = {}
	if (typeof body !== "object" || body === null) return out
	const record = body as Record<string, unknown>
	const receiverId = record["receiverId"]
	if (typeof receiverId === "string" && RECEIVER_ID.test(receiverId))
		out.receiverId = receiverId
	const dongle = record["dongle"]
	if (typeof dongle === "object" && dongle !== null) {
		const d = dongle as Record<string, unknown>
		const vendor = usbString(d["vendor"])
		const product = usbString(d["product"])
		const serial = usbString(d["serial"])
		if (vendor !== undefined) out.vendor = vendor
		if (product !== undefined) out.product = product
		if (serial !== undefined) out.serial = serial
	}
	return out
}

/** rtl_tcp header facts (`RTL0` magic, tuner type, gain count); null when not a valid header. */
export function headerModel(
	header: { magic: unknown; tunerType: unknown; gainCount: unknown } | null,
): { tunerType: number; gainCount: number } | null {
	if (header === null || header.magic !== "RTL0") return null
	const tunerType = headerField(header.tunerType)
	const gainCount = headerField(header.gainCount)
	if (tunerType === undefined || gainCount === undefined) return null
	return { tunerType, gainCount }
}

/**
 * The identity of one connection from its rtl_tcp header and (when the configured sdr-host
 * describes the connected receiver) the sdr-host's validated facts.
 */
export function resolveReceiverIdentity(
	header: { magic: unknown; tunerType: unknown; gainCount: unknown } | null,
	sdrHost: SdrHostIdentityFacts | null,
): ReceiverIdentity {
	const model = headerModel(header)
	const base: Omit<ReceiverIdentity, "key" | "strength"> = model
		? { tunerType: model.tunerType, gainCount: model.gainCount }
		: {}
	if (sdrHost?.serial !== undefined) base.serial = sdrHost.serial
	if (sdrHost?.receiverId !== undefined) {
		base.receiverId = sdrHost.receiverId
		return { key: `sdrhost:${sdrHost.receiverId}`, strength: "unit", ...base }
	}
	if (
		sdrHost?.vendor !== undefined &&
		sdrHost.product !== undefined &&
		sdrHost.serial !== undefined
	)
		return {
			key: `serial:${sdrHost.vendor}:${sdrHost.product}:${sdrHost.serial}`,
			strength: "unit",
			...base,
		}
	if (model)
		return {
			key: `model:${model.tunerType}:${model.gainCount}`,
			strength: "model",
			...base,
		}
	return { key: UNKNOWN_RECEIVER_KEY, strength: "unknown", ...base }
}

/**
 * Longest name a path segment gets before it is hashed: 255 bytes is the common NAME_MAX; 200
 * leaves room for the suffixes the stores append.
 */
export const PATH_SEGMENT_MAX_LENGTH = 200

/**
 * A single, collision-free path segment for any string: percent-encoded with every `.` and every
 * upper-case letter encoded too (so never `.` or `..`, never a separator, and two strings that
 * differ only in case stay apart on a case-insensitive file system: the only upper-case
 * characters left are the hex digits of escapes, which are never emitted in lower case), or past
 * PATH_SEGMENT_MAX_LENGTH `%h` and a SHA-256 (encodeURIComponent never emits `%h`, so the two
 * forms cannot collide).
 */
export function pathSegment(value: string): string {
	let encoded = ""
	try {
		encoded = encodeURIComponent(value).replace(/%[0-9A-F]{2}|[A-Z.]/g, m =>
			m.length === 3
				? m
				: `%${m.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`,
		)
	} catch {
		// A lone surrogate cannot be encoded: hashed below.
	}
	if (encoded.length > 0 && encoded.length <= PATH_SEGMENT_MAX_LENGTH)
		return encoded
	// UTF-16 code units, so two strings with different lone surrogates hash apart.
	return `%h${createHash("sha256").update(Buffer.from(value, "utf16le")).digest("hex")}`
}
