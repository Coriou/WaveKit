import type {
	FastifyError,
	FastifyPluginAsync,
	FastifyReply,
	FastifyRequest,
} from "fastify"
import {
	RECEIVER_SAMPLE_RATE_PRESETS_HZ,
	RTL_TUNER_GAIN_TABLES,
} from "@wavekit/api-types"
import type {
	ReceiverCapabilities,
	ReceiverCapabilitiesErrorCode,
} from "@wavekit/api-types"
import { TUNER_REST_COMMAND_POLICY } from "../../core/tuner-controller.js"
import { gainTableCoherent } from "../../core/tuner-capabilities/gain-table.js"
import { projectReceiverControls } from "../../core/tuner-capabilities/rtl-tcp.js"
import {
	isReceiverSourceId,
	receiverCapabilitiesPageSchema,
	receiverCapabilitiesSchema,
	sampleRatePresetsCoherent,
	RECEIVER_CAPABILITIES_LIMITS,
} from "../../core/tuner-capabilities/types.js"
import type { ReceiverCapabilitiesProvider } from "../../core/tuner-capabilities/types.js"

export interface ReceiverCapabilitiesRoutesOptions {
	provider: ReceiverCapabilitiesProvider | null | undefined
}

const prefix = "/api/receiver-capabilities"
const messages: Record<ReceiverCapabilitiesErrorCode, string> = {
	NOT_FOUND: "Receiver source not found",
	UNAVAILABLE: "Receiver capabilities unavailable",
	FAILED: "Receiver capabilities provider failed",
	CONFLICT: "Receiver capabilities evidence conflict",
	LIMIT: "Receiver capabilities bound exceeded",
	INVALID_REQUEST: "Invalid receiver capabilities request",
	METHOD_NOT_ALLOWED: "Receiver capabilities method not allowed",
}

function sendError(
	reply: FastifyReply,
	code: ReceiverCapabilitiesErrorCode,
	status: number,
) {
	const bytes = JSON.stringify({
		error: "ReceiverCapabilitiesError",
		code: `RECEIVER_CAPABILITIES_${code}`,
		message: messages[code],
	})
	return reply
		.code(status)
		.header("Cache-Control", "no-store")
		.type("application/json; charset=utf-8")
		.serializer(value => value as string)
		.send(bytes)
}

/** Strict once-only percent/UTF8 decoding, bounded BEFORE decoded allocation.
 * Literal '+' stays '+'. Bounds derive from the closed decoded field contracts.
 */
function decode(raw: string, maxBytes: number): string | null {
	const bytes: number[] = []
	for (let index = 0; index < raw.length; index++) {
		const char = raw.charCodeAt(index)
		if (char > 0x7f) return null
		if (char === 0x25) {
			const pair = raw.slice(index + 1, index + 3)
			if (!/^[0-9a-fA-F]{2}$/.test(pair)) return null
			bytes.push(Number.parseInt(pair, 16))
			index += 2
		} else bytes.push(char)
		if (bytes.length > maxBytes) return null
	}
	try {
		return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
			Uint8Array.from(bytes),
		)
	} catch {
		return null
	}
}

type Input =
	| { kind: "get"; sourceId: string }
	| { kind: "list"; after: string | null; limit: number }

// Public pages contain up to16 *15 controls; the raw-reader guard's smaller
// node allowance is not a public-page bound. Refuse holes/accessors before Zod.
// Largest array in a response: 16 page items, 15 controls, or the longest frozen gain
// table (29 R82xx values, WG7 req 5.4).
const maxOutputArrayLength = Math.max(
	16,
	...Object.values(RTL_TUNER_GAIN_TABLES).map(
		entry => entry?.valuesTenthsDb.length ?? 0,
	),
)

function plainOutput(value: unknown): boolean {
	let nodes = 0
	const active = new Set<object>()
	function visit(item: unknown, depth: number): boolean {
		if (++nodes > 16384 || depth > 16) return false
		if (item === null || ["string", "number", "boolean"].includes(typeof item))
			return true
		if (typeof item !== "object" || active.has(item)) return false
		active.add(item)
		const array = Array.isArray(item)
		const proto: unknown = Object.getPrototypeOf(item)
		if (
			array
				? proto !== Array.prototype
				: proto !== Object.prototype && proto !== null
		)
			return false
		if (array) {
			const d = Object.getOwnPropertyDescriptor(item, "length")
			const length: unknown = d && "value" in d ? d.value : null
			if (
				typeof length !== "number" ||
				!Number.isInteger(length) ||
				length < 0 ||
				length > maxOutputArrayLength ||
				Reflect.ownKeys(item).length !== length + 1
			)
				return false
			for (let i = 0; i < length; i++) {
				const entry = Object.getOwnPropertyDescriptor(item, String(i))
				if (!entry || !("value" in entry) || !visit(entry.value, depth + 1))
					return false
			}
		} else {
			const keys = Reflect.ownKeys(item)
			if (keys.length > 20) return false
			for (const key of keys) {
				if (typeof key !== "string") return false
				const entry = Object.getOwnPropertyDescriptor(item, key)
				if (!entry || !("value" in entry) || !visit(entry.value, depth + 1))
					return false
			}
		}
		active.delete(item)
		return true
	}
	return visit(value, 0)
}

function sameData(left: unknown, right: unknown): boolean {
	if (left === right) return true
	if (
		left === null ||
		right === null ||
		typeof left !== "object" ||
		typeof right !== "object"
	)
		return false
	if (Array.isArray(left) || Array.isArray(right))
		return (
			Array.isArray(left) &&
			Array.isArray(right) &&
			left.length === right.length &&
			left.every((value: unknown, index) => sameData(value, right[index]))
		)
	const a = left as Record<string, unknown>
	const b = right as Record<string, unknown>
	const keys = Object.keys(a)
	return (
		keys.length === Object.keys(b).length &&
		keys.every(key => Object.hasOwn(b, key) && sameData(a[key], b[key]))
	)
}

/** Correlations of already validated PUBLIC facts. No clock, raw-header/history
 * reconstruction, receiver command or stronger hidden expectedSince claim.
 */
function coherentItem(dto: ReceiverCapabilities): boolean {
	const { source, connection, delivery, peerHeader } = dto
	if (!sampleRatePresetsCoherent(dto) || !gainTableCoherent(dto)) return false
	if (
		dto.sourceIncarnation === dto.snapshotId ||
		dto.sessionId === dto.snapshotId ||
		dto.sessionId === dto.sourceIncarnation
	)
		return false
	if (source.type === "recording" && connection === "connecting") return false
	if (source.kind === "recording" && source.type !== "recording") return false
	if (
		source.kind === "iq" &&
		source.format !== "U8_IQ" &&
		source.format !== "S16_IQ"
	)
		return false
	if (
		source.kind === "audio_pcm" &&
		!["S16LE", "FLOAT32LE", "auto"].includes(source.format)
	)
		return false
	if (
		source.type === "recording"
			? dto.sessionId !== null
			: connection === "connected" || connection === "connecting"
				? dto.sessionId === null
				: dto.sessionId !== null
	)
		return false
	if (connection === "ended" && source.type !== "recording") return false
	if (
		delivery.lastSampleAt === null
			? delivery.sampleAgeMs !== null
			: delivery.sampleAgeMs === null
	)
		return false
	const captured = Date.parse(dto.capturedAt)
	if (delivery.lastSampleAt !== null) {
		const sampled = Date.parse(delivery.lastSampleAt)
		if (
			sampled > captured ||
			delivery.sampleAgeMs !==
				Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, captured - sampled))
		)
			return false
	}
	if (
		connection === "disconnected" &&
		(delivery.state !== "disconnected" || delivery.lastSampleAt !== null)
	)
		return false
	if (
		connection === "ended" &&
		(delivery.state !== "ended" || delivery.lastSampleAt !== null)
	)
		return false
	if (
		connection === "connecting" &&
		(delivery.state !== "waiting" || delivery.lastSampleAt !== null)
	)
		return false
	if (connection === "connected") {
		if (delivery.state === "disconnected" || delivery.state === "ended")
			return false
		if (
			delivery.state === "streaming" &&
			(delivery.sampleAgeMs === null || delivery.sampleAgeMs >= 10000)
		)
			return false
		if (
			delivery.state === "waiting" &&
			delivery.lastSampleAt !== null &&
			delivery.sampleAgeMs !== null &&
			delivery.sampleAgeMs < 10000
		)
			return false
		if (
			delivery.state === "stale" &&
			delivery.sampleAgeMs !== null &&
			delivery.sampleAgeMs < 10000
		)
			return false
	}
	if (source.type !== "rtl_tcp") {
		if (
			peerHeader.state !== "not-applicable" ||
			peerHeader.reason !== "non-rtl-transport"
		)
			return false
	} else if (source.kind !== "iq") {
		if (
			peerHeader.state !== "not-applicable" ||
			peerHeader.reason !== "non-iq-source"
		)
			return false
	} else if (source.format !== "U8_IQ") {
		if (
			peerHeader.state !== "unknown" ||
			peerHeader.reason !== "format-not-captured"
		)
			return false
	} else if (connection !== "connected") {
		if (peerHeader.state !== "unknown" || peerHeader.reason !== "not-connected")
			return false
	} else if (peerHeader.state === "advertised") {
		if (
			dto.sessionId === null ||
			peerHeader.sessionId !== dto.sessionId ||
			Date.parse(peerHeader.observedAt) > captured
		)
			return false
	} else if (
		peerHeader.state !== "unknown" ||
		!["awaiting-header", "partial-header", "invalid-header"].includes(
			peerHeader.reason,
		)
	)
		return false
	return sameData(
		dto.controls,
		projectReceiverControls(
			TUNER_REST_COMMAND_POLICY,
			source.type === "rtl_tcp",
		),
	)
}

function parseInput(target: string, single: boolean): Input | null {
	const question = target.indexOf("?")
	const path = question < 0 ? target : target.slice(0, question)
	const query = question < 0 ? "" : target.slice(question + 1)
	if (single) {
		if (query !== "" || !path.startsWith(prefix + "/")) return null
		const id = decode(path.slice(prefix.length + 1), 256)
		return isReceiverSourceId(id) ? { kind: "get", sourceId: id } : null
	}
	if (path !== prefix) return null
	let after: string | null = null
	let limit = 8
	const seen = new Set<string>()
	let start = 0
	while (start < query.length) {
		if (seen.size === 2) return null
		const amp = query.indexOf("&", start)
		const end = amp < 0 ? query.length : amp
		const equal = query.indexOf("=", start)
		if (
			equal < start ||
			equal >= end ||
			(query.indexOf("=", equal + 1) >= 0 &&
				query.indexOf("=", equal + 1) < end)
		)
			return null
		const key = decode(query.slice(start, equal), 5)
		if (key === null || !["after", "limit"].includes(key) || seen.has(key))
			return null
		seen.add(key)
		const value = decode(query.slice(equal + 1, end), key === "after" ? 256 : 2)
		if (key === "after") {
			if (!isReceiverSourceId(value)) return null
			after = value
		} else {
			if (value === null || !/^(?:[1-9]|1[0-6])$/.test(value)) return null
			limit = Number(value)
		}
		if (amp < 0) break
		start = amp + 1
		if (start === query.length) return null
	}
	return { kind: "list", after, limit }
}

// Closed response documentation. Runtime output is validated by the approved
// strict Zod schemas and sent as explicitly serialized bytes, never AJV-stripped.
const str = { type: "string" } as const
const integer = {
	type: "integer",
	minimum: 0,
	maximum: Number.MAX_SAFE_INTEGER,
} as const
const nullable = (schema: object) => ({ anyOf: [schema, { type: "null" }] })
const closed = (properties: Record<string, object>) => ({
	type: "object",
	additionalProperties: false,
	required: Object.keys(properties),
	properties,
})
const literal = (value: string | number) => ({ const: value })
const token = {
	type: "string",
	pattern: "^[0-9a-f]{32}$",
	minLength: 32,
	maxLength: 32,
}
const id = { type: "string", minLength: 1, maxLength: 100 }
const date = {
	type: "string",
	format: "date-time",
	minLength: 24,
	maxLength: 24,
}
const range = closed({ min: { type: "integer" }, max: { type: "integer" } })
const validation = {
	anyOf: [
		closed({
			kind: literal("integer-range"),
			min: { type: "integer" },
			max: { type: "integer" },
		}),
		closed({
			kind: literal("integer-ranges"),
			ranges: { type: "array", minItems: 2, maxItems: 2, items: range },
		}),
		closed({
			kind: literal("enum"),
			values: { type: "array", minItems: 1, maxItems: 3, items: str },
		}),
		closed({ kind: literal("boolean") }),
		closed({ kind: literal("uint16-pair") }),
	],
}
const unknownPhysical = closed({
	state: literal("unknown"),
	reason: literal("no-qualified-readback"),
})
const control = closed({
	id: {
		enum: [
			"frequency",
			"sampleRate",
			"gainMode",
			"gain",
			"ppm",
			"ifGain",
			"testMode",
			"agcMode",
			"directSampling",
			"offsetTuning",
			"rtlXtal",
			"tunerXtal",
			"gainIndex",
			"biasTee",
			"tunerIfGain",
		],
	},
	unit: {
		enum: [
			"Hz",
			"enum",
			"tenthsDb",
			"ppm",
			"rawInteger",
			"boolean",
			"index",
			"stageRawPair",
		],
	},
	command: closed({
		state: literal("implemented"),
		opcode: { type: "integer", minimum: 1, maximum: 15 },
		validation: closed({
			authority: literal("admitted-rest-argument-policy"),
			rule: validation,
		}),
	}),
	transport: {
		anyOf: [
			closed({ state: literal("applicable"), reason: literal("rtl-tcp") }),
			closed({
				state: literal("not-applicable"),
				reason: literal("non-rtl-transport"),
			}),
		],
	},
	physical: unknownPhysical,
	currentValue: closed({
		state: literal("unknown"),
		reason: literal("session-qualified-command-evidence-not-provided"),
	}),
})
const capabilities = closed({
	schemaVersion: literal(1),
	sourceId: id,
	sourceIncarnation: token,
	sessionId: nullable(token),
	snapshotId: token,
	capturedAt: date,
	source: closed({
		type: { enum: ["rtl_tcp", "sdrpp-network", "recording"] },
		kind: { enum: ["iq", "audio_pcm", "recording"] },
		format: { enum: ["U8_IQ", "S16_IQ", "S16LE", "FLOAT32LE", "auto"] },
	}),
	connection: { enum: ["connecting", "connected", "disconnected", "ended"] },
	delivery: closed({
		state: {
			enum: [
				"disconnected",
				"waiting",
				"streaming",
				"stale",
				"paused",
				"ended",
			],
		},
		lastSampleAt: nullable(date),
		sampleAgeMs: nullable(integer),
		timeoutMs: literal(10000),
	}),
	peerHeader: {
		anyOf: [
			closed({
				state: literal("advertised"),
				provenance: literal("rtl-peer-header"),
				sessionId: token,
				observedAt: date,
				tunerType: { ...integer, maximum: 0xffffffff },
				gainCount: { ...integer, maximum: 0xffffffff },
			}),
			closed({
				state: literal("unknown"),
				reason: {
					enum: [
						"not-connected",
						"awaiting-header",
						"partial-header",
						"invalid-header",
						"format-not-captured",
					],
				},
			}),
			closed({
				state: literal("not-applicable"),
				reason: { enum: ["non-rtl-transport", "non-iq-source"] },
			}),
		],
	},
	controls: { type: "array", minItems: 15, maxItems: 15, items: control },
	declaredStream: closed({
		provenance: literal("source-config-or-core-metadata"),
		sampleRateHz: { ...integer, minimum: 1 },
		centerFrequencyHz: nullable({ ...integer, minimum: 1 }),
	}),
	sampleRatePresets: {
		anyOf: [
			closed({
				state: literal("suggested"),
				provenance: literal("wavekit-rtl-rate-presets"),
				valuesHz: {
					type: "array",
					maxItems: RECEIVER_SAMPLE_RATE_PRESETS_HZ.length,
					uniqueItems: true,
					items: { ...integer, enum: [...RECEIVER_SAMPLE_RATE_PRESETS_HZ] },
				},
			}),
			closed({
				state: literal("not-applicable"),
				reason: literal("non-rtl-transport"),
			}),
		],
	},
	gainTable: {
		anyOf: [
			...Object.values(RTL_TUNER_GAIN_TABLES)
				.filter(entry => entry !== undefined)
				.map(entry =>
					closed({
						state: literal("suggested"),
						provenance: literal("librtlsdr-tuner-gains"),
						tuner: literal(entry.tuner),
						valuesTenthsDb: { const: [...entry.valuesTenthsDb] },
					}),
				),
			closed({
				state: literal("unknown"),
				reason: {
					enum: [
						"header-not-advertised",
						"unlisted-tuner-type",
						"gain-count-mismatch",
						"no-gain-table",
					],
				},
			}),
			closed({
				state: literal("not-applicable"),
				reason: literal("non-rtl-transport"),
			}),
		],
	},
})
capabilities.properties["iqDelivery"] = closed({
	advertised: nullable({ type: "array", items: { enum: ["raw", "channels"] } }),
	configured: { enum: ["raw", "channels", "auto"] },
	resolved: literal("raw"),
})
const page = closed({
	schemaVersion: literal(1),
	items: { type: "array", maxItems: 16, items: capabilities },
	nextAfter: nullable(id),
})
const errorSchema = closed({
	error: literal("ReceiverCapabilitiesError"),
	code: {
		enum: Object.keys(messages).map(code => `RECEIVER_CAPABILITIES_${code}`),
	},
	message: { enum: Object.values(messages) },
})
// Root admission has a forced serializer and must retain its distinct shape.
const errorResponse = { anyOf: [errorSchema, closed({ code: str })] }

export const receiverCapabilitiesRoutes: FastifyPluginAsync<
	ReceiverCapabilitiesRoutesOptions
> = async (app, options) => {
	const inputs = new WeakMap<FastifyRequest, Input>()
	const localReplies = new WeakSet<FastifyReply>()
	app.addHook("onRequest", async (request, reply) => {
		localReplies.add(reply)
		reply.header("Cache-Control", "no-store")
		if (request.method !== "GET") {
			reply.header("Allow", "GET")
			return sendError(reply, "METHOD_NOT_ALLOWED", 405)
		}
		if (
			request.headers["transfer-encoding"] !== undefined ||
			(request.headers["content-length"] !== undefined &&
				Number(request.headers["content-length"]) !== 0)
		)
			return sendError(reply, "INVALID_REQUEST", 400)
		const input = parseInput(
			request.raw.url ?? "",
			request.routeOptions.url === prefix + "/:sourceId",
		)
		if (input === null) return sendError(reply, "INVALID_REQUEST", 400)
		inputs.set(request, input)
	})
	app.addHook("onSend", async (_request, reply, payload) => {
		if (localReplies.has(reply)) reply.header("Cache-Control", "no-store")
		return payload
	})
	app.setErrorHandler<FastifyError>((error, _request, reply) => {
		// Parent admission failures preceding our hook retain the parent handler.
		if (!localReplies.has(reply)) {
			// Delegation retains child route-context schemas. Explicit JSON preserves
			// the parent's complete envelope despite those schemas or inherited poison.
			reply.serializer(value => {
				// Parent-handler entry clears media headers; restore only at serialization.
				if (!reply.hasHeader("Content-Type"))
					reply.type("application/json; charset=utf-8")
				return JSON.stringify(value)
			})
			throw error
		}
		if (
			error.code === "FST_ERR_FAILED_ERROR_SERIALIZATION" ||
			error.code === "FST_ERR_FAILED_SERIALIZATION"
		)
			return sendError(reply, "FAILED", 500)
		if (
			error.validation ||
			error.statusCode === 400 ||
			error.code?.startsWith("FST_ERR_")
		)
			return sendError(reply, "INVALID_REQUEST", 400)
		return sendError(reply, "FAILED", 503)
	})
	const handler = async (request: FastifyRequest, reply: FastifyReply) => {
		const input = inputs.get(request)
		if (!input) return sendError(reply, "INVALID_REQUEST", 400)
		inputs.delete(request)
		if (!options.provider) return sendError(reply, "UNAVAILABLE", 503)
		let result: unknown
		try {
			result =
				input.kind === "get"
					? options.provider.get(input.sourceId)
					: options.provider.list({ after: input.after, limit: input.limit })
		} catch {
			return sendError(reply, "FAILED", 503)
		}
		try {
			if (
				!plainOutput(result) ||
				result === null ||
				typeof result !== "object" ||
				Array.isArray(result)
			)
				return sendError(reply, "CONFLICT", 503)
			const outcome = result as Record<string, unknown>
			if (outcome["ok"] === false) {
				const code = outcome["code"]
				if (
					Reflect.ownKeys(outcome).length !== 2 ||
					typeof code !== "string" ||
					!["NOT_FOUND", "UNAVAILABLE", "FAILED", "CONFLICT", "LIMIT"].includes(
						code,
					) ||
					(input.kind === "list" && code === "NOT_FOUND")
				)
					return sendError(reply, "CONFLICT", 503)
				return sendError(
					reply,
					code as ReceiverCapabilitiesErrorCode,
					code === "NOT_FOUND" ? 404 : 503,
				)
			}
			if (
				outcome["ok"] !== true ||
				Reflect.ownKeys(outcome).length !== 2 ||
				!Object.hasOwn(outcome, "value")
			)
				return sendError(reply, "CONFLICT", 503)
			let value: unknown
			if (input.kind === "get") {
				const parsed = receiverCapabilitiesSchema.safeParse(outcome["value"])
				if (
					!parsed.success ||
					parsed.data.sourceId !== input.sourceId ||
					!coherentItem(parsed.data)
				)
					return sendError(reply, "CONFLICT", 503)
				value = parsed.data
			} else {
				const parsed = receiverCapabilitiesPageSchema.safeParse(
					outcome["value"],
				)
				if (
					!parsed.success ||
					parsed.data.items.length > input.limit ||
					(parsed.data.nextAfter !== null &&
						(parsed.data.items.length !== input.limit ||
							parsed.data.nextAfter !== parsed.data.items.at(-1)?.sourceId))
				)
					return sendError(reply, "CONFLICT", 503)
				let previous = input.after
				const first = parsed.data.items[0]
				for (const item of parsed.data.items) {
					if (
						!first ||
						!coherentItem(item) ||
						item.snapshotId !== first.snapshotId ||
						item.capturedAt !== first.capturedAt
					)
						return sendError(reply, "CONFLICT", 503)
					if (
						previous !== null &&
						Buffer.compare(
							Buffer.from(previous, "utf8"),
							Buffer.from(item.sourceId, "utf8"),
						) >= 0
					)
						return sendError(reply, "CONFLICT", 503)
					if (
						Buffer.byteLength(JSON.stringify(item), "utf8") >
						RECEIVER_CAPABILITIES_LIMITS.itemBytes
					)
						return sendError(reply, "LIMIT", 503)
					previous = item.sourceId
				}
				value = parsed.data
			}
			const bytes = JSON.stringify(value)
			if (
				Buffer.byteLength(bytes, "utf8") >
				(input.kind === "get"
					? RECEIVER_CAPABILITIES_LIMITS.itemBytes
					: RECEIVER_CAPABILITIES_LIMITS.pageBytes)
			)
				return sendError(reply, "LIMIT", 503)
			return reply
				.type("application/json; charset=utf-8")
				.serializer(value => value as string)
				.send(bytes)
		} catch {
			return sendError(reply, "FAILED", 500)
		}
	}
	for (const url of [prefix, prefix + "/:sourceId"]) {
		app.get(
			url,
			{
				exposeHeadRoute: false,
				schema: {
					response: {
						200: url === prefix ? page : capabilities,
						400: errorResponse,
						401: errorResponse,
						403: errorResponse,
						404: errorResponse,
						405: errorResponse,
						500: errorResponse,
						503: errorResponse,
					},
				},
			},
			handler,
		)
		for (const method of ["HEAD", "POST", "PUT", "PATCH", "DELETE"] as const)
			app.route({
				method,
				url,
				schema: {
					response: {
						400: errorResponse,
						401: errorResponse,
						403: errorResponse,
						405: errorResponse,
						503: errorResponse,
					},
				},
				handler,
			})
	}
}
