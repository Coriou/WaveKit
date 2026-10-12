/**
 * Transport-agnostic Activity WebSocket adapter.
 * Main owns the socket. This module enforces subscription admission, validates
 * the activity messages, and applies the per-client queue limit. It does not
 * register a route and it does not edit the broadcaster.
 */
import { z } from "zod"
import type {
	ActivityQuery,
	ActivityQueryService,
	ActivityReplayFrame,
	ActivityReplayHandle,
} from "../core/activity/storage/contract.js"
import { ActivityQueryError } from "../core/activity/query/errors.js"
import { withActivityClient } from "../core/activity/query/service.js"

export const ACTIVITY_RESUMABLE_CLOSE_CODE = 4001
export const ACTIVITY_RESUMABLE_CLOSE_REASON = "activity-resumable"

export interface ActivityWireMessage {
	type: string
	channel?: "activity"
	data: unknown
}

/**
 * `send` returns false when the message was NOT accepted and must stay queued
 * for a later `resume`. Returning true means the transport took the message.
 */
export interface ActivityClientTransport {
	readonly key: string
	send(message: ActivityWireMessage): boolean
	close(code: number, reason: string): void
}

export interface ActivitySubscriptionLimits {
	perClient: number
	global: number
	maxMessages: number
	maxBytes: number
}

export interface ActivitySubscriptionHub {
	handleMessage(transport: ActivityClientTransport, raw: unknown): void
	/** Call when the transport can accept messages again. */
	resume(key: string): void
	/** Call on socket close. Does not close the transport again. */
	detach(key: string): void
	close(): void
}

const DEFAULT_LIMITS: ActivitySubscriptionLimits = {
	perClient: 2,
	global: 8,
	maxMessages: 256,
	maxBytes: 1024 * 1024,
}

const subscribeSchema = z
	.object({
		type: z.literal("activity:subscribe"),
		id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
		query: z.unknown(),
		cursor: z.string().min(1).max(8192).optional(),
	})
	.strict()

const unsubscribeSchema = z
	.object({
		type: z.literal("activity:unsubscribe"),
		id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
	})
	.strict()

interface Queued {
	message: ActivityWireMessage
	bytes: number
}

interface Subscription {
	id: string
	handle: ActivityReplayHandle
	lastCursor: string | null
	paused: boolean
	release: () => void
}

interface Slot {
	transport: ActivityClientTransport
	queue: Queued[]
	queuedBytes: number
	blocked: boolean
	flushing: boolean
	closing: boolean
	subs: Map<string, Subscription>
}

function resolveLimits(
	overrides: Partial<ActivitySubscriptionLimits> | undefined,
): ActivitySubscriptionLimits {
	const limits = { ...DEFAULT_LIMITS }
	if (!overrides) return limits
	for (const key of Object.keys(overrides) as (keyof ActivitySubscriptionLimits)[]) {
		const value = overrides[key]
		if (value !== undefined) limits[key] = value
	}
	return limits
}

function parseRaw(raw: unknown): unknown {
	if (typeof raw === "string") {
		try {
			return JSON.parse(raw) as unknown
		} catch {
			return undefined
		}
	}
	if (raw instanceof Uint8Array) {
		try {
			return JSON.parse(Buffer.from(raw).toString("utf8")) as unknown
		} catch {
			return undefined
		}
	}
	return raw
}

function frameMessage(id: string, frame: ActivityReplayFrame): ActivityWireMessage {
	if (frame.type === "records") {
		return {
			type: "activity:records",
			channel: "activity",
			data: {
				id,
				items: frame.items,
				scannedThrough: frame.scannedThrough,
				cursor: frame.cursor,
			},
		}
	}
	if (frame.type === "progress") {
		return {
			type: "activity:progress",
			channel: "activity",
			data: { id, scannedThrough: frame.scannedThrough, cursor: frame.cursor },
		}
	}
	return {
		type: "activity:reset",
		channel: "activity",
		data: { id, reason: frame.reason },
	}
}

export function createActivitySubscriptions(options: {
	service: ActivityQueryService
	enabled: boolean
	limits?: Partial<ActivitySubscriptionLimits>
}): ActivitySubscriptionHub {
	const limits = resolveLimits(options.limits)
	const slots = new Map<string, Slot>()
	let globalSubs = 0

	function slotFor(transport: ActivityClientTransport): Slot {
		const existing = slots.get(transport.key)
		if (existing && !existing.closing) {
			existing.transport = transport
			return existing
		}
		const created: Slot = {
			transport,
			queue: [],
			queuedBytes: 0,
			blocked: false,
			flushing: false,
			closing: false,
			subs: new Map(),
		}
		slots.set(transport.key, created)
		return created
	}

	function latestCursor(slot: Slot): string | null {
		let cursor: string | null = null
		for (const sub of slot.subs.values()) {
			if (sub.lastCursor !== null) cursor = sub.lastCursor
		}
		return cursor
	}

	function overflow(slot: Slot): void {
		if (slot.closing) return
		slot.closing = true
		const notice: ActivityWireMessage = {
			type: "activity:closed",
			channel: "activity",
			data: { reason: "resumable", cursor: latestCursor(slot) },
		}
		try {
			slot.transport.send(notice)
		} catch {
			// The close below is the resumable signal if the notice cannot be written.
		}
		for (const sub of [...slot.subs.values()]) {
			sub.handle.stop()
			sub.release()
		}
		slot.subs.clear()
		slot.queue = []
		slot.queuedBytes = 0
		slots.delete(slot.transport.key)
		try {
			slot.transport.close(
				ACTIVITY_RESUMABLE_CLOSE_CODE,
				ACTIVITY_RESUMABLE_CLOSE_REASON,
			)
		} catch {
			// The transport may already be gone.
		}
	}

	function flush(slot: Slot): void {
		if (slot.flushing || slot.closing) return
		slot.flushing = true
		try {
			while (slot.queue.length > 0) {
				const next = slot.queue[0]
				if (!next) break
				let accepted = false
				try {
					accepted = slot.transport.send(next.message)
				} catch {
					overflow(slot)
					return
				}
				if (!accepted) {
					slot.blocked = true
					return
				}
				slot.queue.shift()
				slot.queuedBytes -= next.bytes
			}
			slot.blocked = false
		} finally {
			slot.flushing = false
		}
	}

	function enqueue(slot: Slot, message: ActivityWireMessage): "queued" | "pause" | "closed" {
		if (slot.closing) return "closed"
		const bytes = Buffer.byteLength(JSON.stringify(message))
		if (slot.queue.length >= limits.maxMessages || slot.queuedBytes + bytes > limits.maxBytes) {
			overflow(slot)
			return "closed"
		}
		slot.queue.push({ message, bytes })
		slot.queuedBytes += bytes
		flush(slot)
		if (slot.closing) return "closed"
		if (slot.blocked) return "pause"
		return "queued"
	}

	function sendError(
		transport: ActivityClientTransport,
		code: string,
		message: string,
		id?: string,
	): void {
		const slot = slotFor(transport)
		const data: { code: string; message: string; id?: string } = { code, message }
		if (id !== undefined) data.id = id
		enqueue(slot, { type: "error", channel: "activity", data })
	}

	function subscribe(transport: ActivityClientTransport, raw: unknown): void {
		const parsed = subscribeSchema.safeParse(raw)
		if (!parsed.success) {
			sendError(transport, "ACTIVITY_QUERY_INVALID", "Invalid activity subscribe message")
			return
		}
		const { id, cursor } = parsed.data
		if (!options.enabled) {
			sendError(transport, "ACTIVITY_DISABLED", "Activity is disabled", id)
			return
		}
		const slot = slotFor(transport)
		if (slot.subs.has(id)) {
			sendError(transport, "ACTIVITY_QUERY_INVALID", "Activity subscription id already exists", id)
			return
		}
		if (slot.subs.size >= limits.perClient) {
			sendError(
				transport,
				"ACTIVITY_QUERY_BUSY",
				`At most ${limits.perClient} activity subscriptions are allowed per client`,
				id,
			)
			return
		}
		if (globalSubs >= limits.global) {
			sendError(
				transport,
				"ACTIVITY_QUERY_BUSY",
				`At most ${limits.global} activity subscriptions are allowed`,
				id,
			)
			return
		}
		globalSubs += 1
		let released = false
		const release = (): void => {
			if (released) return
			released = true
			globalSubs -= 1
			slot.subs.delete(id)
		}
		const sub: Subscription = {
			id,
			lastCursor: null,
			paused: false,
			release,
			handle: { resume() {}, stop() {} },
		}
		// Register before replay so a synchronous first frame can see this sub.
		slot.subs.set(id, sub)
		try {
			const request: { query: ActivityQuery; cursor?: string } = {
				query: parsed.data.query as ActivityQuery,
			}
			if (cursor !== undefined) request.cursor = cursor
			sub.handle = withActivityClient(transport.key, () =>
				options.service.replay(request, {
					send(frame) {
						if (slot.closing) return false
						const outcome = enqueue(slot, frameMessage(id, frame))
						if (
							outcome !== "closed" &&
							(frame.type === "records" || frame.type === "progress")
						) {
							sub.lastCursor = frame.cursor
						}
						if (frame.type === "reset") queueMicrotask(release)
						if (outcome !== "queued") sub.paused = true
						return outcome === "queued"
					},
				}),
			)
		} catch (error) {
			release()
			const code =
				error instanceof ActivityQueryError ? error.code : "ACTIVITY_QUERY_INVALID"
			const message = error instanceof Error ? error.message : "Invalid activity query"
			sendError(transport, code, message, id)
			return
		}
		if (released || slot.closing) return
		enqueue(slot, {
			type: "activity:subscribed",
			channel: "activity",
			data: { id },
		})
	}

	function unsubscribe(transport: ActivityClientTransport, raw: unknown): void {
		const parsed = unsubscribeSchema.safeParse(raw)
		if (!parsed.success) {
			sendError(transport, "ACTIVITY_QUERY_INVALID", "Invalid activity unsubscribe message")
			return
		}
		const slot = slots.get(transport.key)
		const sub = slot?.subs.get(parsed.data.id)
		if (!slot || !sub) {
			sendError(transport, "ACTIVITY_QUERY_INVALID", "Unknown activity subscription", parsed.data.id)
			return
		}
		sub.handle.stop()
		sub.release()
		enqueue(slot, {
			type: "activity:unsubscribed",
			channel: "activity",
			data: { id: parsed.data.id },
		})
	}

	return {
		handleMessage(transport, raw): void {
			const message = parseRaw(raw)
			if (typeof message !== "object" || message === null || !("type" in message)) {
				sendError(transport, "ACTIVITY_QUERY_INVALID", "Invalid activity message")
				return
			}
			const type = (message as { type?: unknown }).type
			if (type === "activity:subscribe") {
				subscribe(transport, message)
				return
			}
			if (type === "activity:unsubscribe") {
				unsubscribe(transport, message)
				return
			}
			sendError(transport, "ACTIVITY_QUERY_INVALID", "Invalid activity message")
		},
		resume(key): void {
			const slot = slots.get(key)
			if (!slot || slot.closing) return
			slot.blocked = false
			flush(slot)
			if (slot.blocked || slot.closing) return
			for (const sub of slot.subs.values()) {
				if (!sub.paused) continue
				sub.paused = false
				sub.handle.resume()
			}
		},
		detach(key): void {
			const slot = slots.get(key)
			if (!slot) return
			slot.closing = true
			slots.delete(key)
			for (const sub of slot.subs.values()) {
				sub.handle.stop()
				sub.release()
			}
			slot.subs.clear()
			slot.queue = []
			slot.queuedBytes = 0
		},
		close(): void {
			for (const key of [...slots.keys()]) this.detach(key)
		},
	}
}
