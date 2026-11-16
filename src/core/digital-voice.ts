/**
 * Digital voice stream: decoded dsd-fme voice (AMBE/IMBE via mbelib) as a
 * continuous HTTP PCM stream with per-call metadata, like live analog audio.
 *
 * - Before decoders are created, prepareDecoderConfigs() binds one loopback
 *   UDP socket per eligible dsd-fme decoder and points the decoder at it
 *   (`-o udp:127.0.0.1:<port>`, `-V` slot selection).
 * - Each datagram (8 kHz s16le, stereo in auto/DMR modes) is validated,
 *   mixed to mono and queued in a bounded jitter buffer; a timer emits
 *   constant-rate audio with exact silence between calls. The timer runs
 *   only while a stream has clients; without one, voice is discarded.
 * - Call state comes from the decoder's "voice-call" events, published in
 *   the same tick as its call_start / call_end outputs. Audio of a call
 *   flagged encrypted is muted (dsd-fme also mutes encrypted voice). On
 *   /stream, audio of a call whose encryption is not known yet is held in a
 *   bounded per-lane ring (VOICE_HOLD_MAX_MS) and played, late, once the call
 *   is known clear; it is discarded if the call turns out encrypted or ends
 *   unknown. Each DMR slot keeps its own call and lane: in stereo only a
 *   restricted call's slot is silenced or held. Taps get the most restrictive
 *   active call and never the held audio (an unknown slot stays muted there).
 *
 * Endpoints on httpPort (default 8082): /stream and /stream.wav serve the
 * first configured dsd-fme decoder; /decoders/<id>/stream[.wav] serve each
 * decoder, including scanner probes added at runtime (addChannel).
 * Format is fixed for the stream's life (8000 Hz mono s16le), so clients are
 * never disconnected between calls.
 */

import * as dgram from "node:dgram"
import type { NodeHttpAccessOptions } from "../access/node-http-adapter.js"
import { EventEmitter } from "node:events"
import type * as http from "node:http"
import { z } from "zod"
import type { DigitalVoiceConfig } from "../config.js"
import type { DecoderConfig } from "../decoders/types.js"
import {
	DSD_FME_MODES,
	dsdFmeUdpChannels,
	type DsdFmeMode,
} from "../decoders/builtin/dsd-fme.js"
import type { Logger } from "../utils/logger.js"
import { createComponentLogger } from "../utils/logger.js"
import { WaveKitError } from "../utils/errors.js"
import {
	AudioClientRegistry,
	AudioHttpServer,
	parseStreamPath,
	type AudioRoute,
	type StreamFormat,
} from "./audio-stream-server.js"
import {
	DSD_FME_VOICE_SAMPLE_RATE,
	MAX_DSD_FME_DATAGRAM_BYTES,
	downmixDsdFmeDatagram,
	dsdFmeDatagramBytes,
	type VoiceChannels,
} from "./dsd-fme-voice-format.js"
import { PacedPcmStream } from "./paced-pcm-stream.js"
import type { PacedPcmStats } from "./paced-pcm-stream.js"
import type { VoiceTap, VoiceTapSource } from "./auto-listen/contract.js"

export type { DigitalVoiceConfig } from "../config.js"

export interface DigitalVoiceCall {
	decoderId: string
	callId: string
	protocol: string | null
	talkgroup: number | null
	source: number | null
	slot: number | null
	encrypted: boolean
	encryptionKnown?: boolean
	active: boolean
	startedAt: string
	endedAt?: string
	colourCode?: number
	nac?: string
	algorithmId?: string
	keyId?: string
	ran?: number
	errors?: { crc: number; fec: number }
}

/** /stream hold of voice whose encryption is not known yet (cumulative ms). */
export interface DigitalVoiceHoldStatus {
	/** Voice put on hold while its call's encryption was not known. */
	heldMs: number
	/** Held voice played once its call was known clear. */
	releasedMs: number
	/** Held voice discarded: encrypted, ended unknown, detach, or no listener. */
	discardedMs: number
	/** Held voice dropped oldest-first beyond VOICE_HOLD_MAX_MS. */
	overflowDroppedMs: number
	/** Current lag of the most delayed lane (held or released, not played yet). */
	bufferedMs: number
}

export interface DigitalVoiceDecoderStatus {
	decoderId: string
	mode: string
	udpPort: number
	httpUrl: string
	wavUrl: string
	clientCount: number
	bytesStreamed: number
	datagramsReceived: number
	datagramsRejected: number
	encryptedDatagramsDropped: number
	droppedSamples: number
	underruns: number
	bufferedMs: number
	/** The /stream hold of voice whose encryption is not known yet. */
	voiceHold: DigitalVoiceHoldStatus
	lastDatagramAt?: string
	call: DigitalVoiceCall | null
	lastCall?: DigitalVoiceCall
}

export interface DigitalVoiceStatus {
	enabled: boolean
	running: boolean
	config: DigitalVoiceConfig
	sampleRate: number
	audioFormat: "s16le"
	channels: 1
	httpUrl: string
	wavUrl: string
	clientCount: number
	bytesStreamed: number
	decoders: DigitalVoiceDecoderStatus[]
	call: DigitalVoiceCall | null
	lastError?: string
}

export interface DigitalVoiceServiceOptions {
	/** Borrowed shared protected policy/session/lease authority. */
	httpAccess?: NodeHttpAccessOptions
	/** Canonical configured public origin; never inferred from listener binding. */
	publicOrigin?: string
	httpHost?: string
	/** Pacing timer period (default 20 ms, one vocoder frame). */
	tickMs?: number
	/** A client that accepts nothing for this long is disconnected. */
	clientStallTimeoutMs?: number
	/** Kernel receive buffer per UDP socket (bounded; default 32 KiB). */
	udpReceiveBufferBytes?: number
}

export interface DigitalVoiceEvents {
	call: (call: DigitalVoiceCall) => void
	started: () => void
	stopped: () => void
	"clients-changed": () => void
	error: (error: Error) => void
}

/** Something that publishes dsd-fme "voice-call" events (a DsdFmeDecoder). */
export interface VoiceCallSource {
	on(event: "voice-call", listener: (state: unknown) => void): unknown
	off(event: "voice-call", listener: (state: unknown) => void): unknown
}

const STREAM: StreamFormat = {
	rate: DSD_FME_VOICE_SAMPLE_RATE,
	format: "s16le",
}

const META_FIELDS = [
	"colourCode",
	"ran",
	"nac",
	"algorithmId",
	"keyId",
	"errors",
] as const

type MetaField = (typeof META_FIELDS)[number]

/** Invalid optional metadata becomes undefined instead of failing the call. */
function lenient<T>(schema: z.ZodType<T>) {
	return schema.optional().catch(undefined)
}

function lenientHex(maxLength: number) {
	const pattern = new RegExp(`^[0-9A-F]{1,${maxLength}}$`)
	return z.preprocess(
		value => (typeof value === "string" ? value.trim().toUpperCase() : value),
		z.string().regex(pattern).optional().catch(undefined),
	)
}

const VoiceCallStateSchema = z.object({
	callId: z.string().min(1),
	protocol: z.string().nullable(),
	talkgroup: z.number().nullable(),
	source: z.number().nullable(),
	slot: z.number().nullable(),
	encrypted: z.boolean(),
	/** Call-first: present and not true = encryption not known yet, so not clear (fail closed). */
	encryptionKnown: z
		.unknown()
		.optional()
		.transform(v => (v === undefined ? undefined : v === true)),
	active: z.boolean(),
	startedAt: z.string(),
	endedAt: z.string().optional(),
	/** DMR colour code 0–15. */
	colourCode: lenient(z.number().int().min(0).max(15)),
	/** NXDN RAN 0–63. */
	ran: lenient(z.number().int().min(0).max(63)),
	/** P25 NAC, upper-case hex, 1–4 digits. */
	nac: lenientHex(4),
	/** Encryption algorithm id, upper-case hex, 1–8 digits. */
	algorithmId: lenientHex(8),
	/** Encryption key id, upper-case hex, 1–8 digits. */
	keyId: lenientHex(8),
	errors: lenient(
		z.object({
			crc: z.number().int().nonnegative(),
			fec: z.number().int().nonnegative(),
		}),
	),
})

function droppedMetadataFields(
	raw: unknown,
	parsed: Partial<Record<MetaField, unknown>>,
): MetaField[] {
	if (typeof raw !== "object" || raw === null) return []
	const record = raw as Record<string, unknown>
	const dropped: MetaField[] = []
	for (const field of META_FIELDS) {
		if (record[field] !== undefined && parsed[field] === undefined) {
			dropped.push(field)
		}
	}
	return dropped
}

const DEFAULT_UDP_RECEIVE_BUFFER_BYTES = 32 * 1024

interface VoiceChannel {
	decoderId: string
	/** "scanner": a probe channel added at runtime; never served on /stream. */
	owner: "config" | "scanner"
	mode: DsdFmeMode
	channels: VoiceChannels
	socket: dgram.Socket
	port: number
	paced: PacedPcmStream
	registry: AudioClientRegistry
	/** The most restrictive active call (see restrictiveCall), for status and taps. */
	call: DigitalVoiceCall | null
	/**
	 * Active calls by slot key (1, 2, or 0 for an unknown slot): two DMR slots
	 * run at once, so each slot keeps its own call. At most 3 entries.
	 */
	calls: Map<SlotKey, DigitalVoiceCall>
	lastCall: DigitalVoiceCall | null
	datagrams: number
	rejected: number
	/** Datagrams of an unexpected (but frame-aligned) size: logged once. */
	oddSized: number
	encryptedDropped: number
	lastDatagramAt: Date | null
	detach: (() => void) | null
	/** /stream hold lanes, allocated once on the first call not known clear. */
	hold: VoiceHold | null
	/** Cumulative hold counters, in samples. */
	holdStats: HoldStats
	/** The pacer's queued voice by slot (PacedShadow), allocated on first use. */
	shadow: PacedShadow | null
}

/** 1 and 2 are TDMA slots; 0 is a call whose slot is unknown (or not 1/2). */
type SlotKey = 0 | 1 | 2

function slotKey(slot: number | null): SlotKey {
	return slot === 1 || slot === 2 ? slot : 0
}

/** Not clear: encrypted, or its encryption is not known yet (call-first). */
function isRestricted(call: DigitalVoiceCall): boolean {
	return call.encrypted || call.encryptionKnown === false
}

/**
 * The call a whole-datagram consumer (mono mute, the auto-listen tap) must
 * obey: any restricted active call wins (encrypted before unknown), else the
 * newest clear one; null when no call is active.
 */
function restrictiveCall(
	calls: ReadonlyMap<SlotKey, DigitalVoiceCall>,
): DigitalVoiceCall | null {
	let encrypted: DigitalVoiceCall | null = null
	let unknown: DigitalVoiceCall | null = null
	let clear: DigitalVoiceCall | null = null
	for (const call of calls.values()) {
		if (call.encrypted) encrypted = call
		else if (call.encryptionKnown === false) unknown = call
		else clear = call
	}
	return encrypted ?? unknown ?? clear
}

/**
 * Bound on /stream voice held per lane while its call's encryption is not
 * known (2000 ms). Worst direct-mode first link control ~1.5 s (design
 * estimate, to be re-sized from the in-image measurement table), rounded up
 * to 2 s. Bytes = 2 s x 8000 Hz x 2 bytes/sample x 1 channel (a lane holds one
 * slot's mono voice) = 32 000 bytes (16 000 samples) per lane. A stereo
 * decoder has three lanes (slot 1, slot 2, whole datagram) = 96 000 bytes, a
 * mono one one lane; allocated once, on the decoder's first unknown call.
 * Beyond the bound the oldest held voice is dropped and counted. The /stream
 * lag is at most this bound plus the jitter buffer.
 */
export const VOICE_HOLD_MAX_MS = 2000
const VOICE_HOLD_SAMPLES =
	(VOICE_HOLD_MAX_MS * DSD_FME_VOICE_SAMPLE_RATE) / 1000
/** Largest datagram in samples per channel: 4096 bytes / 2 bytes (mono). */
const HOLD_SCRATCH_SAMPLES = MAX_DSD_FME_DATAGRAM_BYTES / 2
/**
 * Released voice left when datagrams stop (a call end) is fed to the pacer
 * from its ticks while it holds less than this many ticks of voice, at most
 * HOLD_DRAIN_MAX_STEPS ticks of voice per tick: real time, no burst.
 */
const HOLD_DRAIN_LOW_WATER_TICKS = 3
const HOLD_DRAIN_MAX_STEPS = 4

interface HoldStats {
	held: number
	released: number
	discarded: number
	overflow: number
}

/**
 * The lane's releasable tail written while a call governed it (see
 * HoldLane.tailOwner): a stereo whole lane mixing slot calls.
 */
const MIXED_OWNER = "\u0000mixed"

/**
 * One /stream lane: a fixed ring of mono samples. The head `releasable`
 * samples are clear (play them in order before live voice); the rest is held
 * for `callId`, whose encryption is not known yet. Held voice only exists
 * while `callId` is set. The last `tailOwned` releasable samples belong to
 * `tailOwner` (a call released, or live behind its backlog): if that call
 * turns restricted, they are dropped (dropOwned) rather than played.
 */
class HoldLane {
	private readonly ring = new Int16Array(VOICE_HOLD_SAMPLES)
	private head = 0
	length = 0
	releasable = 0
	callId: string | null = null
	tailOwner: string | null = null
	tailOwned = 0

	/**
	 * Appends src[from, to), releasable when `clear` (owned by `owner`);
	 * beyond the bound drops the oldest. Returns samples dropped.
	 */
	push(
		src: Int16Array,
		from: number,
		to: number,
		clear: boolean,
		owner: string | null = null,
	): number {
		const cap = VOICE_HOLD_SAMPLES
		let dropped = 0
		let start = from
		if (to - start > cap) {
			dropped += to - start - cap
			start = to - cap
		}
		const count = to - start
		const excess = this.length + count - cap
		if (excess > 0) {
			this.head = (this.head + excess) % cap
			this.length -= excess
			this.releasable = Math.max(0, this.releasable - excess)
			this.clampTail()
			dropped += excess
		}
		let w = (this.head + this.length) % cap
		for (let i = start; i < to; i++) {
			this.ring[w] = src[i]!
			w = w + 1 === cap ? 0 : w + 1
		}
		this.length += count
		if (clear) {
			this.releasable += count
			if (owner === this.tailOwner) this.tailOwned += count
			else {
				this.tailOwner = owner
				this.tailOwned = count
			}
		}
		return dropped
	}

	/**
	 * Puts src[from, to) ahead of everything and makes the whole lane held
	 * (the head of a call not known yet, still queued in the pacer). Beyond
	 * the bound drops the oldest. Returns samples dropped.
	 */
	prependHeld(src: Int16Array, from: number, to: number): number {
		const cap = VOICE_HOLD_SAMPLES
		const excess = Math.max(0, this.length + (to - from) - cap)
		const start = from + Math.min(excess, to - from)
		const count = to - start
		this.head = (this.head - count + cap) % cap
		let w = this.head
		for (let i = start; i < to; i++) {
			this.ring[w] = src[i]!
			w = w + 1 === cap ? 0 : w + 1
		}
		this.length += count
		this.releasable = 0
		this.tailOwner = null
		this.tailOwned = 0
		return excess
	}

	/** The releasable tail no call owns (live voice before any announce) becomes held. */
	holdUnownedTail(): number {
		if (this.tailOwner !== null) return 0
		const held = this.tailOwned
		this.releasable -= held
		this.tailOwned = 0
		return held
	}

	/** Whether every releasable sample is unowned (or none is queued). */
	unowned(): boolean {
		return (
			this.releasable === 0 ||
			(this.tailOwner === null && this.tailOwned === this.releasable)
		)
	}

	/** Moves up to n releasable samples to dst[0, p). Returns p. */
	popReleasable(dst: Int16Array, n: number): number {
		const cap = VOICE_HOLD_SAMPLES
		const p = Math.min(n, this.releasable)
		let r = this.head
		for (let i = 0; i < p; i++) {
			dst[i] = this.ring[r]!
			r = r + 1 === cap ? 0 : r + 1
		}
		this.head = r
		this.length -= p
		this.releasable -= p
		this.clampTail()
		return p
	}

	/** The held part becomes releasable, owned by its call. Returns samples released. */
	release(): number {
		const released = this.length - this.releasable
		this.releasable = this.length
		if (this.tailOwner === this.callId) this.tailOwned += released
		else {
			this.tailOwner = this.callId
			this.tailOwned = released
		}
		return released
	}

	/** Drops the held part, keeping the releasable head. Returns samples dropped. */
	discardHeld(): number {
		const discarded = this.length - this.releasable
		this.length = this.releasable
		return discarded
	}

	/**
	 * Drops the releasable tail owned by `tailOwner` (its call turned
	 * restricted), keeping any held part after it. Returns samples dropped.
	 */
	dropOwned(): number {
		const cap = VOICE_HOLD_SAMPLES
		const k = this.tailOwned
		if (k === 0) {
			this.tailOwner = null
			return 0
		}
		// Shift the held part (if any) back over the dropped span.
		const held = this.length - this.releasable
		let r = (this.head + this.releasable) % cap
		let w = (this.head + this.releasable - k) % cap
		for (let i = 0; i < held; i++) {
			this.ring[w] = this.ring[r]!
			r = r + 1 === cap ? 0 : r + 1
			w = w + 1 === cap ? 0 : w + 1
		}
		this.length -= k
		this.releasable -= k
		this.tailOwner = null
		this.tailOwned = 0
		return k
	}

	/**
	 * Drops the releasable tail no call owns (voice of a call not announced
	 * yet, queued behind a backlog). Returns samples dropped.
	 */
	dropUnownedTail(): number {
		return this.tailOwner === null ? this.dropOwned() : 0
	}

	/** Drops everything (no listener, detach). Returns the held samples dropped. */
	reset(): number {
		const dropped = this.length - this.releasable
		this.head = 0
		this.length = 0
		this.releasable = 0
		this.tailOwner = null
		this.tailOwned = 0
		return dropped
	}

	private clampTail(): void {
		if (this.tailOwned > this.releasable) this.tailOwned = this.releasable
	}
}

/** Shadow sample kinds (PacedShadow). */
/** a = slot 1 (or mono) part, b = slot 2 part; the sample played is a + b, clamped. */
const SHADOW_SPLIT = 0
/** One voice dsd-fme copied to both channels: a; its slot is not known. */
const SHADOW_SHARED = 1
/** A mix whose slots are no longer known (a lagging whole lane): a. */
const SHADOW_OPAQUE = 2

/**
 * What the pacer still queues, per slot: the last VOICE_HOLD_SAMPLES samples
 * pushed to it, split by slot, so a call announced late as not known clear
 * can take its own queued head back into its hold lane (takeQueued) and
 * leave the other slot's voice queued. The pacer's queued count is exact:
 * samples pushed since the last clear less those played or dropped (both
 * oldest first). Fixed rings: 16 000 x (2 + 2 + 1) bytes = 80 000 bytes per
 * listened decoder, allocated on its first queued voice.
 */
class PacedShadow {
	readonly a = new Int16Array(VOICE_HOLD_SAMPLES)
	readonly b = new Int16Array(VOICE_HOLD_SAMPLES)
	readonly kind = new Uint8Array(VOICE_HOLD_SAMPLES)
	/** Next write index. */
	w = 0
	private pushed = 0
	private played0 = 0
	private dropped0 = 0

	constructor(stats: PacedPcmStats) {
		this.rebase(stats)
	}

	put(a: number, b: number, kind: number): void {
		const w = this.w
		this.a[w] = a
		this.b[w] = b
		this.kind[w] = kind
		this.w = w + 1 === VOICE_HOLD_SAMPLES ? 0 : w + 1
		this.pushed++
	}

	/** Samples still queued in the pacer (may exceed the shadow). */
	queued(stats: PacedPcmStats): number {
		const gone =
			stats.voiceSamples - this.played0 + (stats.droppedSamples - this.dropped0)
		return Math.max(0, this.pushed - gone)
	}

	/** The pacer was cleared or stopped: nothing is queued. */
	rebase(stats: PacedPcmStats): void {
		this.pushed = 0
		this.played0 = stats.voiceSamples
		this.dropped0 = stats.droppedSamples
	}
}

interface VoiceHold {
	/** [0] the whole datagram (mono, or a call on an unknown slot); [1], [2] TDMA slots (stereo). */
	lanes: [HoldLane, HoldLane | null, HoldLane | null]
	/** Per-datagram scratch, reused: slot contents, slot outputs, mix, output. */
	c1: Int16Array
	c2: Int16Array
	o1: Int16Array
	o2: Int16Array
	mix: Int16Array
	out: Int16Array
}

/** Lane status for one datagram. */
const LANE_IDLE = 0
const LANE_ACTIVE = 1
const LANE_HOLD = 2
const LANE_DISCARD = 3
type LaneStatus =
	| typeof LANE_IDLE
	| typeof LANE_ACTIVE
	| typeof LANE_HOLD
	| typeof LANE_DISCARD

/** Fails closed: a restricted call not held by this lane is discarded. */
function laneStatus(lane: HoldLane, call: DigitalVoiceCall | null): LaneStatus {
	if (call === null) return lane.callId === null ? LANE_IDLE : LANE_DISCARD
	if (call.encrypted) return LANE_DISCARD
	if (call.encryptionKnown === false)
		return lane.callId === call.callId ? LANE_HOLD : LANE_DISCARD
	return LANE_ACTIVE
}

function clampSample(value: number): number {
	return value > 32767 ? 32767 : value < -32768 ? -32768 : value
}

function anyNonZero(src: Int16Array, from: number, to: number): boolean {
	for (let i = from; i < to; i++) if (src[i] !== 0) return true
	return false
}

/**
 * One lane through one datagram of n samples: releasable voice first, then
 * live `content` (held, discarded, or delayed behind what is still queued).
 * Writes out[0, n); returns the samples taken from the ring. `virtual` is a
 * pacer-tick drain with no datagram: nothing silent is queued, so an idle or
 * paused lane catches up.
 */
function laneStep(
	lane: HoldLane,
	content: Int16Array,
	out: Int16Array,
	n: number,
	status: LaneStatus,
	virtual: boolean,
	stats: HoldStats,
	owner: string | null,
): number {
	const p = lane.popReleasable(out, n)
	if (status === LANE_DISCARD || status === LANE_HOLD) {
		out.fill(0, p, n)
		// Held voice starts on the call's first voiced samples: a silent slot
		// (the other slot talking) is not held, so it never lags once released.
		if (
			status === LANE_HOLD &&
			(anyNonZero(content, 0, n) || (!virtual && lane.length > lane.releasable))
		) {
			stats.overflow += lane.push(content, 0, n, false)
			stats.held += n
		}
		return p
	}
	if (p === 0 && lane.length === 0) {
		for (let i = 0; i < n; i++) out[i] = content[i]!
		return 0
	}
	// Delay line: live voice queues behind released voice (no reordering).
	const live = n - p
	for (let i = 0; i < live; i++) out[p + i] = content[i]!
	if ((status === LANE_ACTIVE && !virtual) || anyNonZero(content, live, n))
		lane.push(content, live, n, true, owner)
	return p
}

function holdEngaged(hold: VoiceHold | null): boolean {
	if (hold === null) return false
	for (const lane of hold.lanes)
		if (lane !== null && (lane.callId !== null || lane.length > 0)) return true
	return false
}

function holdReleasable(hold: VoiceHold): boolean {
	for (const lane of hold.lanes)
		if (lane !== null && lane.releasable > 0) return true
	return false
}

function holdsCall(hold: VoiceHold | null, callId: string): boolean {
	if (hold === null) return false
	for (const lane of hold.lanes) if (lane?.callId === callId) return true
	return false
}

/** Who owns the whole lane's live voice: its call, a mix of slot calls, or none. */
function wholeOwner(
	channel: VoiceChannel,
	gov0: DigitalVoiceCall | null,
): string | null {
	if (channel.channels === 1 && channel.calls.size > 1) return MIXED_OWNER
	if (gov0 !== null) return gov0.callId
	return channel.calls.size > 0 ? MIXED_OWNER : null
}

function samplesToMs(samples: number): number {
	return Math.round((samples * 1000) / DSD_FME_VOICE_SAMPLE_RATE)
}

function holdStatus(channel: VoiceChannel): DigitalVoiceHoldStatus {
	let buffered = 0
	for (const lane of channel.hold?.lanes ?? [])
		if (lane !== null && lane.length > buffered) buffered = lane.length
	const stats = channel.holdStats
	return {
		heldMs: samplesToMs(stats.held),
		releasedMs: samplesToMs(stats.released),
		discardedMs: samplesToMs(stats.discarded),
		overflowDroppedMs: samplesToMs(stats.overflow),
		bufferedMs: samplesToMs(buffered),
	}
}

function isDsdFmeMode(value: unknown): value is DsdFmeMode {
	return DSD_FME_MODES.includes(value as DsdFmeMode)
}

export class DigitalVoiceService
	extends EventEmitter
	implements VoiceTapSource
{
	private readonly log: Logger
	private readonly config: DigitalVoiceConfig
	private readonly options: Required<
		Omit<DigitalVoiceServiceOptions, "httpAccess" | "publicOrigin" | "httpHost">
	> &
		Pick<DigitalVoiceServiceOptions, "httpAccess" | "publicOrigin" | "httpHost">
	private readonly channels: Map<string, VoiceChannel> = new Map()
	private readonly http: AudioHttpServer
	private running = false
	private lastError: string | null = null
	private starting: Promise<void> | null = null
	/** Optional voice-call fields dropped because they failed validation. */
	private metadataDrops = 0
	private metadataDropLogged = false
	/** Auto listen route taps (auto-listen-route 3.3); empty unless `/auto` has a client. */
	private readonly voiceTaps = new Set<VoiceTap>()
	private voiceTapFailureLogged = false

	constructor(
		logger: Logger,
		config: DigitalVoiceConfig,
		options: DigitalVoiceServiceOptions = {},
	) {
		super()
		this.log = createComponentLogger(logger, "DigitalVoice")
		this.config = config
		this.options = {
			...options,
			tickMs: options.tickMs ?? 20,
			clientStallTimeoutMs: options.clientStallTimeoutMs ?? 30_000,
			udpReceiveBufferBytes:
				options.udpReceiveBufferBytes ?? DEFAULT_UDP_RECEIVE_BUFFER_BYTES,
		}
		this.http = new AudioHttpServer(
			this.log,
			"Digital voice",
			req => this.resolveRoute(req),
			err => this.emitError(err),
			options.httpAccess,
		)
	}

	/** Rate of the mono voice handed to taps (8 kHz s16le). */
	get voiceSampleRate(): number {
		return STREAM.rate
	}

	/**
	 * Registers an auto listen route tap: decoded, encryption-muted mono voice per datagram
	 * (even with no client on this service's own streams), every call event and every detach.
	 * Returns its remover. This service's own streams, pacing and counters are unchanged.
	 */
	addVoiceTap(tap: VoiceTap): () => void {
		this.voiceTaps.add(tap)
		return () => {
			this.voiceTaps.delete(tap)
		}
	}

	private notifyTaps(fn: (tap: VoiceTap) => void): void {
		for (const tap of this.voiceTaps) {
			try {
				fn(tap)
			} catch {
				this.noteTapFailure()
			}
		}
	}

	/** A fixed message: no property of the thrown value is read (it is untrusted). */
	private noteTapFailure(): void {
		if (this.voiceTapFailureLogged) return
		this.voiceTapFailureLogged = true
		this.log.warn("Auto listen voice tap failed")
	}

	/** Invalid optional call-metadata fields dropped so far. */
	get metadataFieldDrops(): number {
		return this.metadataDrops
	}

	get enabled(): boolean {
		return this.config.enabled
	}

	/**
	 * Binds a voice socket for every eligible dsd-fme decoder and returns the
	 * configs with `output: "udp"` pointed at it. Eligible: digital voice
	 * enabled, type dsd-fme, and `output` unset (or "udp" without a port). A
	 * decoder that sets output itself keeps its own choice.
	 */
	async prepareDecoderConfigs(
		configs: readonly DecoderConfig[],
	): Promise<DecoderConfig[]> {
		if (!this.config.enabled) return [...configs]
		const prepared: DecoderConfig[] = []
		for (const config of configs) {
			if (!this.isEligible(config) || this.channels.has(config.id)) {
				prepared.push(config)
				continue
			}
			let channel: VoiceChannel
			try {
				channel = await this.createChannel(config, "config")
			} catch (err) {
				// The decoder still runs, with call metadata only (-o null).
				this.log.error(
					{ err, decoderId: config.id },
					"Could not bind a digital voice UDP socket; voice disabled for this decoder",
				)
				prepared.push(config)
				continue
			}
			this.channels.set(config.id, channel)
			prepared.push(this.routeConfig(config, channel))
		}
		return prepared
	}

	/**
	 * Binds a voice socket for a scanner probe and returns its config routed
	 * to it (spec § 6.5). Unchanged when digital voice is disabled or the
	 * config sets its own output. Does not start the server: ensureStarted().
	 */
	async addChannel(config: DecoderConfig): Promise<DecoderConfig> {
		if (!this.config.enabled || !this.isEligible(config)) return config
		if (this.channels.has(config.id)) {
			throw new WaveKitError(
				`Digital voice channel already exists: ${config.id}`,
				"DIGITAL_VOICE_CHANNEL_EXISTS",
			)
		}
		const channel = await this.createChannel(config, "scanner")
		if (this.channels.has(config.id)) {
			// A concurrent addChannel for the same id bound first.
			channel.socket.close()
			throw new WaveKitError(
				`Digital voice channel already exists: ${config.id}`,
				"DIGITAL_VOICE_CHANNEL_EXISTS",
			)
		}
		this.channels.set(config.id, channel)
		return this.routeConfig(config, channel)
	}

	/** Disconnects the channel's listeners and releases its socket; no-op if unknown. */
	async removeChannel(decoderId: string): Promise<void> {
		const channel = this.channels.get(decoderId)
		if (!channel) return
		this.channels.delete(decoderId)
		channel.detach?.()
		this.stopPaced(channel)
		this.resetHold(channel, true)
		channel.registry.closeAll("removed", true)
		channel.socket.close()
		this.notifyTaps(tap => tap.detach(decoderId))
		this.emit("clients-changed")
		this.log.info({ decoderId }, "Digital voice channel removed")
	}

	/** Starts the HTTP server if it is not running (lazy start for the first probe). */
	async ensureStarted(): Promise<void> {
		if (this.running) return
		await this.start()
	}

	private routeConfig(
		config: DecoderConfig,
		channel: VoiceChannel,
	): DecoderConfig {
		const voiceSlot = config.options["voiceSlot"] ?? this.config.voiceSlot
		this.log.info(
			{
				decoderId: config.id,
				owner: channel.owner,
				udpPort: channel.port,
				mode: channel.mode,
				channels: channel.channels,
				voiceSlot,
			},
			"dsd-fme voice routed to the digital voice stream",
		)
		return {
			...config,
			options: {
				...config.options,
				output: "udp",
				udpHost: "127.0.0.1",
				udpPort: channel.port,
				voiceSlot,
			},
		}
	}

	/** Follows a decoder's call state (its "voice-call" events). */
	attachDecoder(decoderId: string, source: VoiceCallSource): void {
		const channel = this.channels.get(decoderId)
		if (!channel) return
		channel.detach?.()
		// A new source (a restarted decoder) never sends the old calls' ends.
		channel.calls.clear()
		channel.call = null
		channel.paced.setCallActive(false)
		this.resetHold(channel, true)
		const listener = (state: unknown) => this.handleVoiceCall(channel, state)
		source.on("voice-call", listener)
		channel.detach = () => source.off("voice-call", listener)
	}

	/**
	 * Starts the HTTP server. A call while a start is in flight (the boot
	 * start racing a probe's ensureStarted()) joins it: one http.start.
	 */
	async start(): Promise<void> {
		if (this.running) {
			this.log.warn("Digital voice stream already running")
			return
		}
		this.starting ??= this.startServer().finally(() => {
			this.starting = null
		})
		await this.starting
	}

	private async startServer(): Promise<void> {
		if (this.channels.size === 0) {
			const err = new WaveKitError(
				this.config.enabled
					? "No dsd-fme decoder streams voice (none configured, or each sets its own output)"
					: "Digital voice is disabled in config (digitalVoice.enabled); enable it and restart",
				"DIGITAL_VOICE_UNAVAILABLE",
			)
			this.lastError = err.message
			throw err
		}
		try {
			await this.http.start(this.config.httpPort, this.options.httpHost)
		} catch (err) {
			const error = err instanceof Error ? err : new Error(String(err))
			this.lastError = error.message
			this.emitError(error)
			throw error
		}
		this.running = true
		for (const channel of this.channels.values()) {
			if (channel.registry.size > 0) channel.paced.start()
		}
		this.lastError = null
		this.emit("started")
		this.log.info(
			{ httpPort: this.config.httpPort, decoders: [...this.channels.keys()] },
			"Digital voice stream started",
		)
	}

	/** Stop HTTP admission immediately, before global route draining. */
	shutdownAdmission(): void {
		this.http.shutdownAdmission()
	}

	stopAdmission(): void {
		this.http.stopAdmission()
	}

	async stop(): Promise<void> {
		this.stopAdmission()
		if (!this.running) return
		this.running = false
		for (const channel of this.channels.values()) {
			this.stopPaced(channel)
			this.resetHold(channel, false)
			channel.registry.closeAll("stop", true)
			this.notifyTaps(tap => tap.detach(channel.decoderId))
		}
		await this.http.close()
		this.emit("stopped")
		this.log.info("Digital voice stream stopped")
	}

	/** Stops the stream and releases the UDP sockets (shutdown only). */
	async destroy(): Promise<void> {
		await this.stop()
		for (const channel of this.channels.values()) {
			channel.detach?.()
			channel.socket.close()
			this.notifyTaps(tap => tap.detach(channel.decoderId))
		}
		this.channels.clear()
	}

	getStatus(): DigitalVoiceStatus {
		const decoders = [...this.channels.values()].map(channel =>
			this.channelStatus(channel),
		)
		const first = decoders.find(
			d => this.channels.get(d.decoderId)?.owner === "config",
		)
		const status: DigitalVoiceStatus = {
			enabled: this.config.enabled,
			running: this.running,
			config: { ...this.config },
			sampleRate: STREAM.rate,
			audioFormat: "s16le",
			channels: 1,
			httpUrl: first?.httpUrl ?? this.url("/stream"),
			wavUrl: first?.wavUrl ?? this.url("/stream.wav"),
			clientCount: decoders.reduce((sum, d) => sum + d.clientCount, 0),
			bytesStreamed: decoders.reduce((sum, d) => sum + d.bytesStreamed, 0),
			decoders,
			call: decoders.find(d => d.call?.active)?.call ?? null,
		}
		if (this.lastError) status.lastError = this.lastError
		return status
	}

	private isEligible(config: DecoderConfig): boolean {
		if (config.type !== "dsd-fme") return false
		const output = config.options["output"]
		if (output === undefined) return true
		return output === "udp" && config.options["udpPort"] === undefined
	}

	private async createChannel(
		config: DecoderConfig,
		owner: "config" | "scanner",
	): Promise<VoiceChannel> {
		const modeOption = config.options["mode"] ?? "auto"
		const mode: DsdFmeMode = isDsdFmeMode(modeOption) ? modeOption : "auto"
		const socket = dgram.createSocket({
			type: "udp4",
			recvBufferSize: this.options.udpReceiveBufferBytes,
		})
		await new Promise<void>((resolve, reject) => {
			socket.once("error", reject)
			socket.bind(0, "127.0.0.1", () => {
				socket.off("error", reject)
				resolve()
			})
		})
		const registry = new AudioClientRegistry(this.log, {
			stallTimeoutMs: this.options.clientStallTimeoutMs,
			label: "Digital voice",
			stream: STREAM,
		})
		const paced = new PacedPcmStream({
			sampleRate: STREAM.rate,
			tickMs: this.options.tickMs,
			jitterBufferMs: this.config.jitterBufferMs,
			maxBufferMs: this.config.maxBufferMs,
		})
		const channel: VoiceChannel = {
			decoderId: config.id,
			owner,
			mode,
			channels: dsdFmeUdpChannels(mode),
			socket,
			port: socket.address().port,
			paced,
			registry,
			call: null,
			calls: new Map(),
			lastCall: null,
			datagrams: 0,
			rejected: 0,
			oddSized: 0,
			encryptedDropped: 0,
			lastDatagramAt: null,
			detach: null,
			hold: null,
			holdStats: { held: 0, released: 0, discarded: 0, overflow: 0 },
			shadow: null,
		}
		paced.on("audio", (chunk: Buffer) => {
			registry.write(chunk)
			if (channel.hold !== null) this.drainHold(channel)
		})
		// Pace only while someone listens: with no client, voice is discarded
		// and the stream costs nothing.
		registry.on("client-connected", () => {
			if (this.running) paced.start()
			this.emit("clients-changed")
		})
		registry.on("client-disconnected", () => {
			if (registry.size === 0) {
				this.stopPaced(channel)
				// Held voice is only for a listener; the call's hold state stays.
				this.resetHold(channel, false)
			}
			this.emit("clients-changed")
		})
		socket.on("message", (msg: Buffer) => this.ingest(channel, msg))
		socket.on("error", err => {
			this.log.warn(
				{ err, decoderId: channel.decoderId },
				"Digital voice UDP socket error",
			)
		})
		return channel
	}

	private ingest(channel: VoiceChannel, datagram: Buffer): void {
		channel.datagrams++
		channel.lastDatagramAt = new Date()
		// `own`: this service's stream is paced. Taps alone never move its counters (7.2).
		const own = channel.paced.running
		if (!this.running || (!own && this.voiceTaps.size === 0)) return
		// Each active call mutes its own slot when it is not clear (encrypted, or
		// its encryption is not known yet); a call on an unknown slot, any
		// restricted call on a mono channel, or both slots restricted drop the
		// whole datagram.
		let mute1 = false
		let mute2 = false
		let whole = false
		for (const [key, call] of channel.calls) {
			if (!isRestricted(call)) continue
			if (key === 0 || channel.channels === 1) whole = true
			else if (key === 1) mute1 = true
			else mute2 = true
		}
		const encrypted = whole || mute1 || mute2
		if (own && holdEngaged(channel.hold)) {
			this.ingestHeld(
				channel,
				datagram,
				whole || (mute1 && mute2),
				mute1,
				mute2,
			)
			return
		}
		if (whole || (mute1 && mute2)) {
			if (own) channel.encryptedDropped++
			return
		}
		const mono = downmixDsdFmeDatagram(
			datagram,
			channel.channels,
			// Stereo: mute only the restricted call's slot; a clear call on the
			// other slot keeps playing (dsd-fme zero-fills the muted slot too).
			mute1 ? { muteSlot: 1 } : mute2 ? { muteSlot: 2 } : {},
		)
		if (own && mono) this.noteOddSize(channel, datagram)
		if (!mono) {
			if (!own) return
			this.noteRejected(channel, datagram)
			return
		}
		// Inline loop: no closure per datagram.
		for (const tap of this.voiceTaps) {
			try {
				tap.frame(channel.decoderId, mono, channel.call)
			} catch {
				this.noteTapFailure()
			}
		}
		if (!own) return
		if (encrypted) channel.encryptedDropped++
		channel.paced.push(mono)
		this.shadowUnheld(channel, datagram, mono, mute1, mute2)
	}

	/** The pacer was stopped (its queue dropped). */
	private stopPaced(channel: VoiceChannel): void {
		channel.paced.stop()
		channel.shadow?.rebase(channel.paced.stats)
	}

	/** The pacer's queue was discarded. */
	private clearPaced(channel: VoiceChannel): void {
		channel.paced.clear()
		channel.shadow?.rebase(channel.paced.stats)
	}

	private shadowOf(channel: VoiceChannel): PacedShadow {
		channel.shadow ??= new PacedShadow(channel.paced.stats)
		return channel.shadow
	}

	/** Records an unheld datagram's queued voice (`mono`, as pushed) by slot. */
	private shadowUnheld(
		channel: VoiceChannel,
		datagram: Buffer,
		mono: Buffer,
		mute1: boolean,
		mute2: boolean,
	): void {
		const shadow = this.shadowOf(channel)
		const n = mono.length / 2
		if (channel.channels === 1) {
			for (let i = 0; i < n; i++)
				shadow.put(mono.readInt16LE(i * 2), 0, SHADOW_SPLIT)
			return
		}
		let identical = true
		for (let i = 0; i < n && identical; i++) {
			if (datagram.readInt16LE(i * 4) !== datagram.readInt16LE(i * 4 + 2))
				identical = false
		}
		if (identical) {
			// downmix: one voice passes once, or nothing when a slot is muted.
			const muted = mute1 || mute2
			for (let i = 0; i < n; i++) {
				if (muted) shadow.put(0, 0, SHADOW_SPLIT)
				else shadow.put(datagram.readInt16LE(i * 4), 0, SHADOW_SHARED)
			}
			return
		}
		for (let i = 0; i < n; i++) {
			shadow.put(
				mute1 ? 0 : datagram.readInt16LE(i * 4),
				mute2 ? 0 : datagram.readInt16LE(i * 4 + 2),
				SHADOW_SPLIT,
			)
		}
	}

	private noteOddSize(channel: VoiceChannel, datagram: Buffer): void {
		if (datagram.length % dsdFmeDatagramBytes(channel.channels) === 0) return
		if (channel.oddSized === 0) {
			this.log.warn(
				{
					decoderId: channel.decoderId,
					bytes: datagram.length,
					expectedMultipleOf: dsdFmeDatagramBytes(channel.channels),
					channels: channel.channels,
				},
				"Unexpected dsd-fme voice datagram size: is the mode or output format overridden?",
			)
		}
		channel.oddSized++
	}

	private noteRejected(channel: VoiceChannel, datagram: Buffer): void {
		if (channel.rejected === 0) {
			this.log.warn(
				{
					decoderId: channel.decoderId,
					bytes: datagram.length,
					channels: channel.channels,
				},
				"Rejected a malformed dsd-fme voice datagram",
			)
		}
		channel.rejected++
	}

	/**
	 * A datagram while a /stream lane holds or lags. Taps get exactly what they
	 * get without a hold (muted restricted slots, nothing when wholly
	 * restricted); /stream goes through the lanes.
	 */
	private ingestHeld(
		channel: VoiceChannel,
		datagram: Buffer,
		tapBlocked: boolean,
		mute1: boolean,
		mute2: boolean,
	): void {
		const frameBytes = channel.channels * 2
		if (
			datagram.length === 0 ||
			datagram.length > MAX_DSD_FME_DATAGRAM_BYTES ||
			datagram.length % frameBytes !== 0
		) {
			this.noteRejected(channel, datagram)
			return
		}
		this.noteOddSize(channel, datagram)
		if (!tapBlocked && this.voiceTaps.size > 0) {
			const mono = downmixDsdFmeDatagram(
				datagram,
				channel.channels,
				mute1 ? { muteSlot: 1 } : mute2 ? { muteSlot: 2 } : {},
			)
			if (mono) {
				for (const tap of this.voiceTaps) {
					try {
						tap.frame(channel.decoderId, mono, channel.call)
					} catch {
						this.noteTapFailure()
					}
				}
			}
		}
		this.streamHeld(channel, datagram, datagram.length / frameBytes)
	}

	/**
	 * /stream through the hold lanes: n samples from `datagram` (validated), or
	 * with `datagram` null a pacer-tick drain of released voice. Stereo: each
	 * slot lane is held, delayed, discarded or passed, the two are mixed, then
	 * the whole lane (a call on an unknown slot) applies to the mix. Mono: the
	 * whole lane alone, ruled by the most restrictive call.
	 */
	private streamHeld(
		channel: VoiceChannel,
		datagram: Buffer | null,
		n: number,
	): number {
		const hold = channel.hold
		if (hold === null) return 0
		const stats = channel.holdStats
		const virtual = datagram === null
		const [whole, lane1, lane2] = hold.lanes
		const mix = hold.mix
		const gov0 =
			channel.channels === 2
				? (channel.calls.get(0) ?? null)
				: restrictiveCall(channel.calls)
		const st0 = laneStatus(whole, gov0)
		let popped = 0
		let discarded = st0 === LANE_DISCARD
		let silent = discarded
		if (lane1 === null || lane2 === null) {
			if (datagram === null) mix.fill(0, 0, n)
			else for (let i = 0; i < n; i++) mix[i] = datagram.readInt16LE(i * 2)
		} else if (st0 === LANE_DISCARD) {
			// The whole datagram is restricted: slot lanes wait, nothing is mixed.
			mix.fill(0, 0, n)
		} else {
			let st1 = laneStatus(lane1, channel.calls.get(1) ?? null)
			let st2 = laneStatus(lane2, channel.calls.get(2) ?? null)
			const { c1, c2, o1, o2 } = hold
			if (datagram === null) {
				c1.fill(0, 0, n)
				c2.fill(0, 0, n)
			} else {
				let identical = true
				for (let i = 0; i < n && identical; i++) {
					if (datagram.readInt16LE(i * 4) !== datagram.readInt16LE(i * 4 + 2))
						identical = false
				}
				if (!identical) {
					for (let i = 0; i < n; i++) {
						c1[i] = datagram.readInt16LE(i * 4)
						c2[i] = datagram.readInt16LE(i * 4 + 2)
					}
				} else {
					// One voice copied to both channels: whose? A lone restricted
					// slot owns it (held or muted, never leaked); two restricted
					// slots are ambiguous and both discard it; else the lagged slot
					// (to keep its order), else slot 1 (mixed once, as unheld).
					const r1 = st1 >= LANE_HOLD
					const r2 = st2 >= LANE_HOLD
					if (r1 && r2) {
						st1 = LANE_DISCARD
						st2 = LANE_DISCARD
					}
					const target = r1
						? 1
						: r2
							? 2
							: lane1.length === 0 && lane2.length > 0
								? 2
								: 1
					const own = target === 1 ? c1 : c2
					const other = target === 1 ? c2 : c1
					for (let i = 0; i < n; i++) own[i] = datagram.readInt16LE(i * 4)
					other.fill(0, 0, n)
				}
			}
			if (st1 === LANE_DISCARD || st2 === LANE_DISCARD) discarded = true
			silent = st1 === LANE_DISCARD && st2 === LANE_DISCARD
			const owner1 = channel.calls.get(1)?.callId ?? null
			const owner2 = channel.calls.get(2)?.callId ?? null
			popped += laneStep(lane1, c1, o1, n, st1, virtual, stats, owner1)
			popped += laneStep(lane2, c2, o2, n, st2, virtual, stats, owner2)
			for (let i = 0; i < n; i++) {
				const sum = o1[i]! + o2[i]!
				mix[i] = sum > 32767 ? 32767 : sum < -32768 ? -32768 : sum
			}
		}
		const out = hold.out
		const p0 = laneStep(
			whole,
			mix,
			out,
			n,
			st0,
			virtual,
			stats,
			wholeOwner(channel, gov0),
		)
		popped += p0
		if (!virtual && discarded) channel.encryptedDropped++
		// Nothing audible and nothing released: like a muted datagram, queue nothing.
		if (popped === 0 && (virtual || silent)) return 0
		const pcm = Buffer.alloc(n * 2)
		for (let i = 0; i < n; i++) pcm.writeInt16LE(out[i]!, i * 2)
		channel.paced.push(pcm)
		// By slot: out[p0, n) is the mix of o1 and o2 (from 0); out[0, p0)
		// an older mix of the whole lane; a held or muted whole lane is silent.
		const shadow = this.shadowOf(channel)
		const stereo = lane1 !== null && lane2 !== null
		for (let i = 0; i < n; i++) {
			if (!stereo) shadow.put(out[i]!, 0, SHADOW_SPLIT)
			else if (i < p0) shadow.put(out[i]!, 0, SHADOW_OPAQUE)
			else if (st0 >= LANE_HOLD) shadow.put(0, 0, SHADOW_SPLIT)
			else shadow.put(hold.o1[i - p0]!, hold.o2[i - p0]!, SHADOW_SPLIT)
		}
		return popped
	}

	/** Pacer tick: feeds released voice once datagrams stop (see HOLD_DRAIN_LOW_WATER_TICKS). */
	private drainHold(channel: VoiceChannel): void {
		const hold = channel.hold
		if (hold === null || !this.running || !channel.paced.running) return
		const lowWaterMs = HOLD_DRAIN_LOW_WATER_TICKS * this.options.tickMs
		const frames = Math.min(
			HOLD_SCRATCH_SAMPLES,
			Math.max(1, Math.round((STREAM.rate * this.options.tickMs) / 1000)),
		)
		for (let step = 0; step < HOLD_DRAIN_MAX_STEPS; step++) {
			if (channel.paced.bufferedMs >= lowWaterMs) return
			if (!holdReleasable(hold)) return
			if (this.streamHeld(channel, null, frames) === 0) return
		}
	}

	/**
	 * After a call event: a lane holding a call releases it once known clear,
	 * keeps holding while it is still unknown, else discards (encrypted, ended,
	 * replaced, moved to another slot). A lane whose call is not known yet
	 * starts holding it, with its head still queued in the pacer (takeQueued).
	 * A call restricted after its release drops its voice still queued in any
	 * lane (released, or live behind it), as does a mix of slot calls.
	 */
	private updateHold(channel: VoiceChannel, event: DigitalVoiceCall): void {
		const stereo = channel.channels === 2
		const stats = channel.holdStats
		if (channel.hold !== null && isRestricted(event)) {
			for (const lane of channel.hold.lanes) {
				if (
					lane !== null &&
					(lane.tailOwner === event.callId || lane.tailOwner === MIXED_OWNER)
				)
					stats.discarded += lane.dropOwned()
			}
		}
		for (let index = 0; index < (stereo ? 3 : 1); index++) {
			const call =
				index === 0
					? stereo
						? (channel.calls.get(0) ?? null)
						: restrictiveCall(channel.calls)
					: (channel.calls.get(index as SlotKey) ?? null)
			let lane = channel.hold?.lanes[index] ?? null
			if (lane !== null && lane.callId !== null) {
				if (call !== null && call.callId === lane.callId && !call.encrypted) {
					if (call.encryptionKnown !== false) {
						stats.released += lane.release()
						lane.callId = null
					}
				} else {
					stats.discarded += lane.discardHeld()
					lane.callId = null
				}
			}
			if (
				call !== null &&
				!call.encrypted &&
				call.encryptionKnown === false &&
				(lane === null || lane.callId === null)
			) {
				lane ??= this.holdFor(channel).lanes[index] ?? null
				if (lane !== null) {
					lane.callId = call.callId
					this.takeQueued(channel, index as SlotKey, lane)
				}
			}
		}
	}

	/**
	 * A lane starts holding a call not known yet (`index`: 0 the whole
	 * datagram, else its slot): the call's voice already queued, live in the
	 * lane (no call owns it) and still in the pacer, becomes the head of its
	 * hold, in order, so a clear over loses nothing to a late announce. The
	 * other slot's queued voice stays queued. Voice behind another call's
	 * backlog is not the call's head: the pacer is not touched.
	 */
	private takeQueued(
		channel: VoiceChannel,
		index: SlotKey,
		lane: HoldLane,
	): void {
		const stats = channel.holdStats
		if (!lane.unowned()) {
			stats.held += lane.holdUnownedTail()
			return
		}
		const shadow = channel.shadow
		const queued = shadow === null ? 0 : shadow.queued(channel.paced.stats)
		const take = Math.min(queued, VOICE_HOLD_SAMPLES)
		const own = new Int16Array(take)
		const rest = new Int16Array(take)
		const restA = new Int16Array(take)
		const restB = new Int16Array(take)
		const restKind = new Uint8Array(take)
		let ownFrom = take
		let restFrom = take
		let shared = 0
		if (shadow !== null && take > 0) {
			const otherRestricted =
				index !== 0 &&
				[...channel.calls].some(
					([key, call]) => key !== 0 && key !== index && isRestricted(call),
				)
			let r = (shadow.w - take + VOICE_HOLD_SAMPLES) % VOICE_HOLD_SAMPLES
			for (let i = 0; i < take; i++) {
				const a = shadow.a[r]!
				const b = shadow.b[r]!
				const kind = shadow.kind[r]!
				r = r + 1 === VOICE_HOLD_SAMPLES ? 0 : r + 1
				let mine = 0
				let ra = 0
				let rb = 0
				let rk = SHADOW_SPLIT
				if (kind === SHADOW_SPLIT) {
					if (index === 0) mine = clampSample(a + b)
					else if (index === 1) {
						mine = a
						rb = b
					} else {
						mine = b
						ra = a
					}
				} else if (kind === SHADOW_SHARED) {
					// One voice on both channels: a lone restricted slot owns it;
					// with the other slot restricted too it is ambiguous: dropped.
					if (index !== 0 && otherRestricted) {
						if (a !== 0) shared++
					} else mine = a
				} else if (index === 0) mine = a
				else {
					ra = a
					rk = SHADOW_OPAQUE
				}
				own[i] = mine
				restA[i] = ra
				restB[i] = rb
				restKind[i] = rk
				rest[i] = clampSample(ra + rb)
				if (mine !== 0 && ownFrom === take) ownFrom = i
				if (rest[i] !== 0 && restFrom === take) restFrom = i
			}
		}
		if (ownFrom === take && shared === 0) {
			// Nothing of the call is queued in the pacer: the lane alone is held.
			stats.held += lane.length
			lane.prependHeld(own, take, take)
			return
		}
		// Voice older than the shadow is dropped with the pacer's queue.
		stats.overflow += queued - take
		stats.discarded += shared
		this.clearPaced(channel)
		if (restFrom < take) {
			const pcm = Buffer.alloc((take - restFrom) * 2)
			const kept = this.shadowOf(channel)
			for (let i = restFrom; i < take; i++) {
				pcm.writeInt16LE(rest[i]!, (i - restFrom) * 2)
				kept.put(restA[i]!, restB[i]!, restKind[i]!)
			}
			channel.paced.push(pcm)
		}
		const before = lane.length
		stats.overflow += lane.prependHeld(own, ownFrom, take)
		stats.held += before + (take - ownFrom)
	}

	/**
	 * A restricted call starts unheld: the voice no call owns, queued in the
	 * lanes its voice passes (`key`: its slot, 0 unknown) behind a released
	 * backlog, is its late entry and is dropped (counted). Returns whether a
	 * clear backlog still lags on that path: then everything newer is in the
	 * lanes and the pacer queues only older clear voice, so it is kept.
	 */
	private dropLateEntry(channel: VoiceChannel, key: SlotKey): boolean {
		const hold = channel.hold
		if (hold === null) return false
		const [whole, lane1, lane2] = hold.lanes
		const stats = channel.holdStats
		stats.discarded += whole.dropUnownedTail()
		if (lane1 === null || lane2 === null) return whole.releasable > 0
		const drop1 = key !== 2
		const drop2 = key !== 1
		if (drop1) stats.discarded += lane1.dropUnownedTail()
		if (drop2) stats.discarded += lane2.dropUnownedTail()
		if (whole.releasable > 0) return true
		return (!drop1 || lane1.releasable > 0) && (!drop2 || lane2.releasable > 0)
	}

	/** The channel's lanes, allocated on first use (see VOICE_HOLD_MAX_MS). */
	private holdFor(channel: VoiceChannel): VoiceHold {
		if (channel.hold !== null) return channel.hold
		const stereo = channel.channels === 2
		const scratch = () => new Int16Array(HOLD_SCRATCH_SAMPLES)
		channel.hold = {
			lanes: [
				new HoldLane(),
				stereo ? new HoldLane() : null,
				stereo ? new HoldLane() : null,
			],
			c1: scratch(),
			c2: scratch(),
			o1: scratch(),
			o2: scratch(),
			mix: scratch(),
			out: scratch(),
		}
		return channel.hold
	}

	/** Drops queued lane voice (counted); `calls` also forgets which calls are held. */
	private resetHold(channel: VoiceChannel, calls: boolean): void {
		if (channel.hold === null) return
		for (const lane of channel.hold.lanes) {
			if (lane === null) continue
			channel.holdStats.discarded += lane.reset()
			if (calls) lane.callId = null
		}
	}

	private handleVoiceCall(channel: VoiceChannel, raw: unknown): void {
		const parsed = VoiceCallStateSchema.safeParse(raw)
		if (!parsed.success) {
			this.log.warn(
				{ decoderId: channel.decoderId, issues: parsed.error.issues },
				"Ignoring a malformed voice-call event",
			)
			return
		}
		const state = parsed.data
		const dropped = droppedMetadataFields(raw, state)
		if (dropped.length > 0) this.noteMetadataDrop(channel.decoderId, dropped)
		const call: DigitalVoiceCall = {
			decoderId: channel.decoderId,
			callId: state.callId,
			protocol: state.protocol,
			talkgroup: state.talkgroup,
			source: state.source,
			slot: state.slot,
			encrypted: state.encrypted,
			...(state.encryptionKnown !== undefined
				? { encryptionKnown: state.encryptionKnown }
				: {}),
			active: state.active,
			startedAt: state.startedAt,
			...(state.endedAt !== undefined ? { endedAt: state.endedAt } : {}),
			...(state.colourCode !== undefined
				? { colourCode: state.colourCode }
				: {}),
			...(state.nac !== undefined ? { nac: state.nac } : {}),
			...(state.algorithmId !== undefined
				? { algorithmId: state.algorithmId }
				: {}),
			...(state.keyId !== undefined ? { keyId: state.keyId } : {}),
			...(state.ran !== undefined ? { ran: state.ran } : {}),
			...(state.errors !== undefined ? { errors: state.errors } : {}),
		}
		const key = slotKey(call.slot)
		const held = holdsCall(channel.hold, call.callId)
		if (call.active) {
			// The same call keyed elsewhere (its slot became known) moves here.
			for (const [k, c] of channel.calls) {
				if (k !== key && c.callId === call.callId) channel.calls.delete(k)
			}
			channel.calls.set(key, call)
		} else {
			// An end clears only its own slot (and the same call wherever it is
			// keyed); a newer call on that slot or the other slot stays.
			for (const [k, c] of channel.calls) {
				if (c.callId === call.callId) channel.calls.delete(k)
			}
			channel.lastCall = call
		}
		channel.call = restrictiveCall(channel.calls)
		this.updateHold(channel, call)
		// Never play audio of a call that is not clear, even if some was queued:
		// a call already held has none queued, and one that starts holding took
		// its own queued voice into its hold (takeQueued).
		if (
			call.active &&
			isRestricted(call) &&
			!held &&
			!holdsCall(channel.hold, call.callId) &&
			!this.dropLateEntry(channel, key)
		)
			this.clearPaced(channel)
		channel.paced.setCallActive(channel.call !== null)
		// Taps (the auto-listen router) are whole-datagram consumers: they get
		// the most restrictive active call, or this event when none is active.
		const tapCall = channel.call ?? call
		if (this.voiceTaps.size > 0)
			this.notifyTaps(tap => tap.call(channel.decoderId, tapCall))
		this.emit("call", call)
	}

	private resolveRoute(req: http.IncomingMessage): AudioRoute | null {
		const { base, wav } = parseStreamPath(req.url)
		let channel: VoiceChannel | undefined
		if (base === "/stream") {
			// /stream is the configured decoders' stream; probes come and go.
			channel = [...this.channels.values()].find(c => c.owner === "config")
		} else {
			const match = /^\/decoders\/([^/]+)\/stream$/.exec(base)
			if (match?.[1]) {
				try {
					channel = this.channels.get(decodeURIComponent(match[1]))
				} catch {
					channel = undefined
				}
			}
		}
		if (!channel) return null
		return { registry: channel.registry, stream: STREAM, wav }
	}

	private channelStatus(channel: VoiceChannel): DigitalVoiceDecoderStatus {
		const base = `/decoders/${encodeURIComponent(channel.decoderId)}/stream`
		const status: DigitalVoiceDecoderStatus = {
			decoderId: channel.decoderId,
			mode: channel.mode,
			udpPort: channel.port,
			httpUrl: this.url(base),
			wavUrl: this.url(`${base}.wav`),
			clientCount: channel.registry.size,
			bytesStreamed: channel.registry.bytesStreamed,
			datagramsReceived: channel.datagrams,
			datagramsRejected: channel.rejected,
			encryptedDatagramsDropped: channel.encryptedDropped,
			droppedSamples: channel.paced.stats.droppedSamples,
			underruns: channel.paced.stats.underruns,
			bufferedMs: channel.paced.bufferedMs,
			voiceHold: holdStatus(channel),
			call: channel.call,
		}
		if (channel.lastDatagramAt) {
			status.lastDatagramAt = channel.lastDatagramAt.toISOString()
		}
		if (channel.lastCall) status.lastCall = channel.lastCall
		return status
	}

	private url(path: string): string {
		return `${this.options.publicOrigin ?? `http://localhost:${this.config.httpPort}`}${path}`
	}

	/** Count every dropped field. Log only the first drop for this process. */
	private noteMetadataDrop(decoderId: string, fields: readonly string[]): void {
		this.metadataDrops += fields.length
		if (this.metadataDropLogged) return
		this.metadataDropLogged = true
		this.log.warn(
			{ decoderId, fields, metadataFieldDrops: this.metadataDrops },
			"Dropped invalid digital voice call metadata",
		)
	}

	private emitError(err: Error): void {
		if (this.listenerCount("error") > 0) this.emit("error", err)
	}
}
