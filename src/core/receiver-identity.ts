/**
 * Receiver identity: which physical receiver a source's connection reaches, so learned
 * state (spur maps, noise floors, occupancy, the pre-band gain, the accepted tuning) is applied
 * only to the receiver it was learned on. Pure functions; the tracker
 * (receiver-identity-tracker.ts) follows connections and the learned-state manager
 * (receiver-identity-state.ts) namespaces the files.
 *
 * Key, strongest first (a key names a namespace on disk, so only stable facts form one):
 * - `unit:<unitId>`: the configured sdr-host's persisted unit id (32 lower-case hex; it survives
 *   sdr-host restarts and image updates). The sdr-host's `receiverId` is random per process and
 *   never forms a key;
 * - `serial:<vendor>:<product>:<serial>`: the dongle's USB ids and serial as the sdr-host reports
 *   them, only for a serial that is not a well-known default (`00000001`, `0`, all zeros);
 * - `source:<sourceId>|model:<tunerType>:<gainCount>`: the rtl_tcp header alone, scoped to the
 *   source (any dongle of that model on that source); weak;
 * - `unknown`: nothing usable; no learned state is applied or written.
 * Every component is validated (charset and length) before it is used in a key or a file name;
 * anything else is dropped, so a malformed peer answer only ever weakens the identity.
 */
import { createHash } from "node:crypto"
import { z } from "zod"

export type ReceiverStrength = "unit" | "model" | "unknown"

export interface ReceiverIdentity {
	key: string
	strength: ReceiverStrength
	tunerType?: number
	gainCount?: number
	serial?: string
	/** The sdr-host's persisted unit id, when it formed the key. */
	unitId?: string
	/** The sdr-host process's id: informational, connection-scoped, never persisted or keyed. */
	receiverId?: string
}

/** What the configured sdr-host said about its dongle, already validated. */
export interface SdrHostIdentityFacts {
	unitId?: string
	receiverId?: string
	vendor?: string
	product?: string
	serial?: string
	/** The serial is a shared default (the sdr-host said so, or it matches WEAK_SERIAL). */
	serialWeak?: boolean
}

export const UNKNOWN_RECEIVER_KEY = "unknown"
const HEX_ID = /^[0-9a-f]{32}$/
/**
 * USB strings: letters, digits, `.`, `_`, `-`, 1 to 32 characters (an RTL-SDR serial is 8 digits;
 * USB string descriptors allow more, which is refused rather than truncated: a cut serial could
 * name another dongle).
 */
const USB_STRING = /^[A-Za-z0-9._-]{1,32}$/
/** USB vendor and product ids as lsusb prints them (4 lower-case hex). */
const USB_ID = /^[0-9a-f]{4}$/
/** Factory serials many dongles share: `0`, `1`, all zeros, zeros then `1` (`00000001`). */
const WEAK_SERIAL = /^0*1?$/
/**
 * rtl_tcp header fields are uint32; the tuner type enum has 7 values today and an R820T reports
 * 29 gains. 255 bounds both well above any real dongle; a larger value is a malformed header.
 */
export const RECEIVER_HEADER_FIELD_MAX = 255
/**
 * Longest key: `serial:` (7) + three 32-character strings + two `:` = 105;
 * `source:` (7) + a 64-character source part + `|model:255:255` (14) = 85; `unit:` + 32 = 37.
 * 128 leaves room and bounds anything read back from disk.
 */
export const RECEIVER_KEY_MAX_LENGTH = 128
/** Source ids used as is in a key; any other id is hashed (`~` + 32 hex, never a plain id). */
const KEY_SOURCE = /^[A-Za-z0-9._-]{1,64}$/
const KEY_PATTERN =
	/^(?:unit:[0-9a-f]{32}|serial:[A-Za-z0-9._-]{1,32}:[A-Za-z0-9._-]{1,32}:[A-Za-z0-9._-]{1,32}|source:(?:[A-Za-z0-9._-]{1,64}|~[0-9a-f]{32})\|model:\d{1,3}:\d{1,3})$/

/** True for a key this module could have built (used for keys read back from disk). */
export function isReceiverKey(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length <= RECEIVER_KEY_MAX_LENGTH &&
		KEY_PATTERN.test(value)
	)
}

export function strengthOfKey(key: string): ReceiverStrength {
	if (key.startsWith("unit:") || key.startsWith("serial:")) return "unit"
	if (key.startsWith("source:")) return "model"
	return "unknown"
}

export const STRENGTH_RANK: Readonly<Record<ReceiverStrength, number>> = {
	unknown: 0,
	model: 1,
	unit: 2,
}

export function isWeakSerial(serial: string): boolean {
	return WEAK_SERIAL.test(serial)
}

/** The source part of a source-scoped key: the id itself when plain, else a hash of it. */
function keySource(sourceId: string): string {
	if (KEY_SOURCE.test(sourceId)) return sourceId
	return `~${createHash("sha256").update(sourceId, "utf8").digest("hex").slice(0, 32)}`
}

/** The weak, source-scoped key of a header model on a source. */
export function sourceModelKey(
	sourceId: string,
	model: { tunerType: number; gainCount: number },
): string {
	return `source:${keySource(sourceId)}|model:${model.tunerType}:${model.gainCount}`
}

const HexIdSchema = z.string().regex(HEX_ID)
const UsbStringSchema = z.string().regex(USB_STRING)
const UsbIdSchema = z.string().regex(USB_ID)

function pick<T>(schema: z.ZodType<T>, value: unknown): T | undefined {
	const parsed = schema.safeParse(value)
	return parsed.success ? parsed.data : undefined
}

/**
 * The sdr-host status body's identity fields, each kept only when valid (Zod, field by field):
 * `unitId`, `receiverId`, `dongle.usb.vid/pid` (else `dongle.vendor/product`), `dongle.serial`,
 * `dongle.serialWeak`. A serial is weak when the sdr-host says so or it matches a shared default
 * (the safe answer: the core's own rule applies to an older or wrong sdr-host too). An sdr-host
 * without `unitId` (an older one) gives no unit id. Never throws; any shape is accepted as input.
 */
export function parseSdrHostIdentity(body: unknown): SdrHostIdentityFacts {
	const out: SdrHostIdentityFacts = {}
	if (typeof body !== "object" || body === null) return out
	const record = body as Record<string, unknown>
	const unitId = pick(HexIdSchema, record["unitId"])
	if (unitId !== undefined) out.unitId = unitId
	const receiverId = pick(HexIdSchema, record["receiverId"])
	if (receiverId !== undefined) out.receiverId = receiverId
	const dongle = record["dongle"]
	if (typeof dongle === "object" && dongle !== null) {
		const d = dongle as Record<string, unknown>
		const usb =
			typeof d["usb"] === "object" && d["usb"] !== null
				? (d["usb"] as Record<string, unknown>)
				: {}
		const vendor =
			pick(UsbIdSchema, usb["vid"]) ?? pick(UsbStringSchema, d["vendor"])
		const product =
			pick(UsbIdSchema, usb["pid"]) ?? pick(UsbStringSchema, d["product"])
		const serial = pick(UsbStringSchema, d["serial"])
		if (vendor !== undefined) out.vendor = vendor
		if (product !== undefined) out.product = product
		if (serial !== undefined) {
			out.serial = serial
			out.serialWeak =
				pick(z.boolean(), d["serialWeak"]) === true || isWeakSerial(serial)
		}
	}
	return out
}

function headerField(value: unknown): number | undefined {
	return typeof value === "number" &&
		Number.isInteger(value) &&
		value >= 0 &&
		value <= RECEIVER_HEADER_FIELD_MAX
		? value
		: undefined
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
 * The identity of one connection of `sourceId` from its rtl_tcp header and (when the configured
 * sdr-host describes the connected receiver) the sdr-host's validated facts.
 */
export function resolveReceiverIdentity(
	sourceId: string,
	header: { magic: unknown; tunerType: unknown; gainCount: unknown } | null,
	sdrHost: SdrHostIdentityFacts | null,
): ReceiverIdentity {
	const model = headerModel(header)
	const base: Omit<ReceiverIdentity, "key" | "strength"> = model
		? { tunerType: model.tunerType, gainCount: model.gainCount }
		: {}
	if (sdrHost?.serial !== undefined) base.serial = sdrHost.serial
	if (sdrHost?.receiverId !== undefined) base.receiverId = sdrHost.receiverId
	if (sdrHost?.unitId !== undefined)
		return {
			key: `unit:${sdrHost.unitId}`,
			strength: "unit",
			...base,
			unitId: sdrHost.unitId,
		}
	if (
		sdrHost?.vendor !== undefined &&
		sdrHost.product !== undefined &&
		sdrHost.serial !== undefined &&
		sdrHost.serialWeak !== true &&
		!isWeakSerial(sdrHost.serial)
	)
		return {
			key: `serial:${sdrHost.vendor}:${sdrHost.product}:${sdrHost.serial}`,
			strength: "unit",
			...base,
		}
	if (model)
		return {
			key: sourceModelKey(sourceId, model),
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
