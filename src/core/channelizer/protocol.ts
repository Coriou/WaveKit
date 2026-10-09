import { z } from "zod"
import { WaveKitError } from "../../utils/errors.js"

/**
 * Version-1 control protocol (addendum §11): requests go to the process's `--control-fd`, events
 * come back on its stdout, one JSON object per line. The request schema accepts exactly what
 * native/wavekit-chan/src/protocol.rs parses (plus the runtime's queue floor), and the event schema
 * accepts every line native/wavekit-chan/src/runtime.rs emits (Properties 1 and 14).
 */
export const PROTOCOL_VERSION = 1

/** Largest `queueBytes` the process accepts; mirrors `MAX_QUEUE_BYTES` in protocol.rs. */
export const MAX_QUEUE_BYTES = 64 * 1024 * 1024
/** Bytes per IQ sample; the process refuses a queue that cannot hold one (runtime.rs `open`). */
const SAMPLE_BYTES = { cu8: 2, cf32: 8 } as const

const v = z.literal(PROTOCOL_VERSION)
const id = z.string().regex(/^[A-Za-z0-9._-]{1,64}$/)
const generation = z.number().int().nonnegative()
const format = z.enum(["cu8", "cf32"])
const count = z.number().int().nonnegative()

export const ChannelizerRequestSchema = z
	.discriminatedUnion("type", [
		z
			.object({
				v,
				type: z.literal("open"),
				id,
				centerHz: z.number().finite(),
				bandwidthHz: z.number().positive().finite(),
				transitionHz: z.number().positive().finite(),
				outputRateHz: z.number().int().positive(),
				format,
				gain: z.number().positive().finite().optional(),
				queueBytes: z.number().int().min(1).max(MAX_QUEUE_BYTES),
			})
			.strict(),
		z.object({ v, type: z.literal("close"), id }).strict(),
		z
			.object({
				v,
				type: z.literal("mark-gap"),
				atInputByte: count.optional(),
				droppedInputBytes: count.optional(),
			})
			.strict(),
		z.object({ v, type: z.literal("shutdown") }).strict(),
	])
	.superRefine((req, ctx) => {
		if (req.type !== "open") return
		if (req.gain !== undefined && req.format !== "cu8")
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["gain"],
				message: "gain is cu8 only",
			})
		if (req.queueBytes < SAMPLE_BYTES[req.format])
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["queueBytes"],
				message: `queueBytes below one ${req.format} sample`,
			})
	})

const OpenedEventSchema = z
	.object({
		v,
		type: z.literal("opened"),
		id,
		generation,
		socket: z.string().min(1),
		outputRateHz: z.number().int().positive(),
		format,
		// PF7: a pass-through channel (out = fs) has no filter stages.
		filterTaps: count,
		groupDelaySamples: z.number().nonnegative().finite(),
	})
	.strict()
// PF7: the runtime echoes the request's id cut to 64 (`schema_id`), even one that failed the id
// pattern, and "" when the line had no string id.
const RejectedEventSchema = z
	.object({
		v,
		type: z.literal("rejected"),
		id: z.string().max(64),
		generation,
		reasonCode: z.enum(["channel-outside-capture", "channel-request-invalid"]),
		detail: z.string(),
	})
	.strict()
export const ChannelizerEventSchema = z.discriminatedUnion("type", [
	z
		.object({
			v,
			type: z.literal("ready"),
			generation,
			pid: z.number().int().positive(),
		})
		.strict(),
	OpenedEventSchema,
	RejectedEventSchema,
	z
		.object({
			v,
			type: z.literal("discontinuity"),
			id,
			generation,
			sampleIndex: count,
			droppedSamples: count,
			cause: z.enum(["queue-overflow", "input-gap"]),
		})
		.strict(),
	z
		.object({
			v,
			type: z.literal("stats"),
			generation,
			inputSamples: count,
			channels: z.array(
				z
					.object({
						id,
						outputSamples: count,
						queueHighWaterBytes: count,
						droppedSamples: count,
						saturatedSamples: count,
					})
					.strict(),
			),
		})
		.strict(),
	z
		.object({
			v,
			type: z.literal("closed"),
			id,
			generation,
			reason: z.enum(["requested", "client-gone"]),
		})
		.strict(),
	z
		.object({
			v,
			type: z.literal("input-eof"),
			generation,
			inputSamples: count,
			discardedBytes: count,
		})
		.strict(),
])
export type ChannelizerRequest = z.infer<typeof ChannelizerRequestSchema>
export type ChannelizerEvent = z.infer<typeof ChannelizerEventSchema>
export type OpenedEvent = z.infer<typeof OpenedEventSchema>
export type RejectedEvent = z.infer<typeof RejectedEventSchema>

/** Validates and serialises one request line. Throws `CHANNELIZER_REQUEST_INVALID` for a request the process would reject while parsing. */
export function encodeRequest(req: ChannelizerRequest): string {
	const parsed = ChannelizerRequestSchema.safeParse(req)
	if (!parsed.success)
		throw new WaveKitError(
			`invalid channelizer request: ${parsed.error.message}`,
			"CHANNELIZER_REQUEST_INVALID",
			parsed.error,
		)
	return `${JSON.stringify(parsed.data)}\n`
}

export function parseEventLine(
	line: string,
): { ok: true; event: ChannelizerEvent } | { ok: false; error: string } {
	let raw: unknown
	try {
		raw = JSON.parse(line)
	} catch (err: unknown) {
		return {
			ok: false,
			error: `invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
		}
	}
	const parsed = ChannelizerEventSchema.safeParse(raw)
	return parsed.success
		? { ok: true, event: parsed.data }
		: { ok: false, error: parsed.error.message }
}
