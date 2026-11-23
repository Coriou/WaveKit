/**
 * The `wavekit-iqhub` control protocol (version 1) as the Node supervisor speaks it: the requests it
 * sends, a Zod schema for every event it reads (parsed at the boundary, unknown members dropped),
 * the features it needs and the error-code mapping of a closed attempt. The protocol is documented
 * in `native/wavekit-iqhub/README.md`; nothing here echoes hub or peer values into a message.
 */
import { getSystemErrorName } from "node:util"
import { z } from "zod"

export const HUB_PROTOCOL = 1

/** Features the supervisor needs; a hub without one of them is refused (IQHUB_UNAVAILABLE). */
export const HUB_REQUIRED_FEATURES = [
	"tcp-connected",
	"header-timeout",
	"errno",
	"close-modes",
	"front",
	"rcvbuf",
] as const

/** One event line is at most this long (the hub's own events stay well below it). */
export const HUB_MAX_EVENT_LINE_BYTES = 256 * 1024

const uint = z.number().int().nonnegative()
const int = z.number().int()
const sinkId = z.string().regex(/^[A-Za-z0-9._-]{1,64}$/)
const base = {
	v: z.literal(HUB_PROTOCOL),
	mono: z.number().nonnegative(),
	seq: uint.optional(),
	sourcePos: uint.nullable().optional(),
}

const readyEvent = z.object({
	...base,
	type: z.literal("ready"),
	protocol: z.literal(HUB_PROTOCOL),
	features: z.array(z.string().max(64)).max(64),
	sinkSocket: z.string().min(1).max(103),
	maxSinks: uint,
	maxAttempts: uint,
})
const rejectedEvent = z.object({
	...base,
	type: z.literal("rejected"),
	request: z.string().max(64).nullable(),
	reason: z.string().max(64),
	detail: z.string().max(256).optional(),
})
const configuredEvent = z.object({
	...base,
	type: z.literal("configured"),
	ringBytes: uint,
})
const rcvBuf = z.object({
	requested: uint,
	granted: uint,
	applied: z.boolean(),
	limit: uint.nullable(),
})
const tcpConnectedEvent = z.object({
	...base,
	type: z.literal("tcp-connected"),
	attempt: uint,
	localPort: z.number().int().min(0).max(65_535),
	rcvBuf: rcvBuf.optional(),
})
const connectedEvent = z.object({
	...base,
	type: z.literal("connected"),
	attempt: uint,
	headerHex: z
		.string()
		.max(128)
		.regex(/^(?:[0-9a-f]{2})*$/),
})
const payloadReadyEvent = z.object({
	...base,
	type: z.literal("payload-ready"),
	attempt: uint,
})
export const HUB_CLOSE_REASONS = [
	"timeout",
	"refused",
	"unreachable",
	"reset",
	"eof",
	"aborted",
	"replaced",
	"error",
] as const
export type HubCloseReason = (typeof HUB_CLOSE_REASONS)[number]
const closedEvent = z.object({
	...base,
	type: z.literal("closed"),
	attempt: uint,
	phase: z.enum(["connect", "header", "held", "adopted"]),
	reason: z.enum(HUB_CLOSE_REASONS),
	mode: z.enum(["now", "after-writes", "graceful"]).optional(),
	errno: int.optional(),
	connectSeq: uint.optional(),
	front: sinkId.optional(),
	by: z.literal("front").optional(),
})
const adoptedEvent = z.object({
	...base,
	type: z.literal("adopted"),
	attempt: uint,
	stream: uint,
})
const writtenEvent = z.object({
	...base,
	type: z.literal("written"),
	id: uint,
	attempt: uint,
})
const writeFailedEvent = z.object({
	...base,
	type: z.literal("write-failed"),
	id: uint,
	attempt: uint,
	reason: z.string().max(64),
	errno: int.optional(),
})
const markedEvent = z.object({
	...base,
	type: z.literal("marked"),
	id: uint,
	sinks: z.array(z.object({ sink: sinkId, sinkByte: uint })).max(64),
})
const progressEvent = z.object({
	...base,
	type: z.literal("progress"),
	stream: uint.nullable().optional(),
	sinks: z
		.array(
			z.object({
				sink: sinkId,
				sinkBytes: uint,
				lagBytes: uint,
				gaps: uint,
				droppedBytes: uint,
			}),
		)
		.max(64)
		.optional(),
})
const linkGapEvent = z.object({
	...base,
	type: z.literal("link-gap"),
	startMono: z.number().nonnegative(),
	endMono: z.number().nonnegative(),
	queuedBytes: uint,
})
const sinkReadyEvent = z.object({
	...base,
	type: z.literal("sink-ready"),
	sink: sinkId,
})
const sinkBoundEvent = z.object({
	...base,
	type: z.literal("sink-bound"),
	sink: sinkId,
})
const sinkRejectedEvent = z.object({
	...base,
	type: z.literal("sink-rejected"),
	reason: z.string().max(64),
	sink: sinkId.optional(),
})
const sinkStartedEvent = z.object({
	...base,
	type: z.literal("sink-started"),
	sink: sinkId,
	startSourcePos: uint,
	sinkByte: uint,
})
const sinkUpdatedEvent = z.object({
	...base,
	type: z.literal("sink-updated"),
	sink: sinkId,
})
const sinkGapEvent = z.object({
	...base,
	type: z.literal("sink-gap"),
	sink: sinkId,
	atSinkByte: uint,
	atSourcePos: uint,
	droppedBytes: uint,
	cause: z.enum(["lag", "stream", "start"]),
})
const sinkClosedEvent = z.object({
	...base,
	type: z.literal("sink-closed"),
	sink: sinkId,
	reason: z.enum(["request", "peer", "reconfigured", "attempt-closed"]),
	sinkBytes: uint,
	headerSent: uint.optional(),
	droppedBytes: uint.optional(),
	discardedBytes: uint.optional(),
})
const frontPlacedEvent = z.object({
	...base,
	type: z.literal("front-placed"),
	sink: sinkId,
	frontBytes: uint,
	atSourcePos: uint,
	sinkByte: uint,
	queuedBytes: uint,
})
const frontEndedEvent = z.object({
	...base,
	type: z.literal("front-ended"),
	sink: sinkId,
	sinkBytes: uint,
	headerSent: uint,
	droppedBytes: uint,
	discardedBytes: uint,
	reason: z.union([z.enum(HUB_CLOSE_REASONS), z.literal("front-closed")]),
	errno: int.optional(),
})

export const HubEventSchema = z.discriminatedUnion("type", [
	readyEvent,
	rejectedEvent,
	configuredEvent,
	tcpConnectedEvent,
	connectedEvent,
	payloadReadyEvent,
	closedEvent,
	adoptedEvent,
	writtenEvent,
	writeFailedEvent,
	markedEvent,
	progressEvent,
	linkGapEvent,
	sinkReadyEvent,
	sinkBoundEvent,
	sinkRejectedEvent,
	sinkStartedEvent,
	sinkUpdatedEvent,
	sinkGapEvent,
	sinkClosedEvent,
	frontPlacedEvent,
	frontEndedEvent,
])
export type HubEvent = z.infer<typeof HubEventSchema>
export type HubEventOf<T extends HubEvent["type"]> = Extract<
	HubEvent,
	{ type: T }
>
export type HubFrontPlaced = HubEventOf<"front-placed">
export type HubSinkGap = HubEventOf<"sink-gap">

/**
 * One event line, validated. Null for a line that is not JSON or not a known, well-formed event
 * (the caller counts it; the line itself is never logged).
 */
export function parseHubEvent(line: string): HubEvent | null {
	let value: unknown
	try {
		value = JSON.parse(line)
	} catch {
		return null
	}
	const parsed = HubEventSchema.safeParse(value)
	return parsed.success ? parsed.data : null
}

/** The requests the supervisor sends (each one line, `{"v":1,"type":...}`). */
export interface HubConfigureRequest {
	type: "configure"
	byteRate: number
	frameBytes: number
	levelFormat: null
	progressMs: number
	linkGapMs: number
}
export interface HubConnectRequest {
	type: "connect"
	attempt: number
	host: string
	port: number
	timeoutMs: number
	headerBytes: number
	keepAliveMs: number
	rcvBufBytes?: number
}
export interface HubFrontOpenRequest {
	type: "sink-open"
	sink: string
	kind: "front"
	attempt: number
	maxLagMs: number
	resumeMs: number
}
export interface HubAbortRequest {
	type: "abort"
	attempt: number
	mode: "now"
}
export interface HubShutdownRequest {
	type: "shutdown"
}
export type HubRequest =
	| HubConfigureRequest
	| HubConnectRequest
	| HubFrontOpenRequest
	| HubAbortRequest
	| HubShutdownRequest

export function encodeHubRequest(request: HubRequest, seq?: number): string {
	return `${JSON.stringify({ v: HUB_PROTOCOL, ...request, ...(seq !== undefined ? { seq } : {}) })}\n`
}

/** The hello that binds a Unix connection to a declared sink. */
export function hubHello(sink: string): string {
	return `${JSON.stringify({ v: HUB_PROTOCOL, sink })}\n`
}

const HELLO = /^\{"v":1,"sink":"[A-Za-z0-9._-]{1,64}"\}\n$/

/**
 * True for exactly the supervisor's hello (a write spy on `net.Socket.prototype.write` sees it on a
 * front socket before any tuner command: filter it with this).
 */
export function isHubHello(chunk: unknown): boolean {
	const text =
		typeof chunk === "string"
			? chunk
			: Buffer.isBuffer(chunk)
				? chunk.toString("latin1")
				: null
	return text !== null && HELLO.test(text)
}

/** System error code per portable close reason, when the hub gave no errno. */
const REASON_CODES: Readonly<Record<HubCloseReason, string>> = {
	refused: "ECONNREFUSED",
	unreachable: "EHOSTUNREACH",
	timeout: "ETIMEDOUT",
	reset: "ECONNRESET",
	error: "EIO",
	eof: "ECONNRESET",
	aborted: "ECONNRESET",
	replaced: "ECONNRESET",
}

/**
 * The code a net connect would have given: the errno's system name when the hub gave one (the
 * platform's own number, the hub runs on the same host), else the reason's code.
 */
export function hubCloseCode(reason: HubCloseReason, errno?: number): string {
	if (errno !== undefined && Number.isInteger(errno) && errno > 0) {
		try {
			const name = getSystemErrorName(-errno)
			if (/^E[A-Z0-9]+$/.test(name)) return name
		} catch {
			/* An unknown number: fall back to the reason. */
		}
	}
	return REASON_CODES[reason]
}

/** The upstream receive buffer request: roundUp_MiB(2 x 1.2 s x byteRate), 64 KiB to 32 MiB. */
export function hubRcvBufBytes(byteRate: number): number {
	const mib = 1024 * 1024
	const want = Math.ceil((2 * 1.2 * byteRate) / mib) * mib
	return Math.min(32 * mib, Math.max(65_536, want))
}
