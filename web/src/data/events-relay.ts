/**
 * The `/ws` socket off the main thread. A worker (events.worker.ts) owns the WebSocket, reads each
 * message's type there and limits fleet updates to one per entity per UPDATE_EVERY_MS: the first goes
 * through at once, later ones within the window wait and only the newest is sent when it ends. A busy
 * ADS-B receiver sends an `aircraft:update` per decoded message (several per aircraft per second,
 * each with its track), so most of them never reach the main thread; the Map dead-reckons between
 * reports. A `new` or `lost` sends the entity's waiting update first, so its order is kept. Every other
 * message passes straight through, sent in small batches (one postMessage per OUT_MS).
 *
 * Main thread: WorkerSocket is the EventsClient's SocketLike over that worker; each message is
 * delivered as its original text, so EventsClient parses and dispatches it as before.
 */
import type { SocketFactory, SocketLike } from "./events-client.ts"

/** The entity key field of each fleet's messages (FleetSpec.keyOf / lostKey in fleets.ts). */
const FLEET_KEYS: Readonly<Record<string, string>> = {
	aircraft: "icao",
	vessel: "mmsi",
	aprs: "key",
	mesh: "nodeId",
}

/** At most one update per fleet entity in this window (the core throttles vessels, APRS and mesh to 2 s). */
export const UPDATE_EVERY_MS = 1000
/** Outgoing messages are batched over this long (one postMessage per batch). */
export const OUT_MS = 16

/** For a fleet message, its entity (`<fleet>|<key>`) and whether it is an update; null for anything else. */
export function fleetKeyOf(
	text: string,
): { id: string; update: boolean } | null {
	let parsed: unknown
	try {
		parsed = JSON.parse(text)
	} catch {
		return null
	}
	if (typeof parsed !== "object" || parsed === null) return null
	const { type, data } = parsed as { type?: unknown; data?: unknown }
	if (typeof type !== "string") return null
	const colon = type.indexOf(":")
	const field = FLEET_KEYS[type.slice(0, colon)]
	const event = type.slice(colon + 1)
	if (
		colon < 0 ||
		field === undefined ||
		(event !== "update" && event !== "new" && event !== "lost")
	)
		return null
	const key =
		typeof data === "object" && data !== null
			? (data as Record<string, unknown>)[field]
			: undefined
	if (typeof key !== "string") return null
	return { id: `${type.slice(0, colon)}|${key}`, update: event === "update" }
}

interface EntitySlot {
	sentAt: number
	waiting: string | null
}

/** Per-entity rate limit for fleet updates; `send` receives what may go now. */
export class FleetThrottle {
	private readonly slots = new Map<string, EntitySlot>()
	private readonly send: (text: string) => void
	private readonly everyMs: number
	private droppedCount = 0
	private waitingCount = 0

	constructor(send: (text: string) => void, everyMs = UPDATE_EVERY_MS) {
		this.send = send
		this.everyMs = everyMs
	}

	/** Superseded updates dropped so far. */
	get dropped(): number {
		return this.droppedCount
	}

	/** Updates waiting for their window to end. */
	get waiting(): number {
		return this.waitingCount
	}

	push(text: string, now: number): void {
		const fleet = fleetKeyOf(text)
		if (!fleet) {
			this.send(text)
			return
		}
		const slot = this.slots.get(fleet.id)
		if (!fleet.update) {
			// new or lost: the waiting update goes first, and the entity starts afresh
			if (slot && slot.waiting !== null) {
				this.send(slot.waiting)
				this.waitingCount -= 1
			}
			this.slots.delete(fleet.id)
			this.send(text)
			return
		}
		if (!slot || now - slot.sentAt >= this.everyMs) {
			this.slots.set(fleet.id, { sentAt: now, waiting: null })
			this.send(text)
			return
		}
		if (slot.waiting !== null) this.droppedCount += 1
		else this.waitingCount += 1
		slot.waiting = text
	}

	/** Sends the waiting updates whose window has ended; forgets idle entities. */
	sweep(now: number): void {
		for (const [id, slot] of this.slots) {
			if (now - slot.sentAt < this.everyMs) continue
			if (slot.waiting !== null) {
				this.send(slot.waiting)
				this.waitingCount -= 1
				slot.waiting = null
				slot.sentAt = now
			} else if (now - slot.sentAt >= 10 * this.everyMs) this.slots.delete(id)
		}
	}

	/** Sends everything waiting (the socket closed). */
	drain(): void {
		for (const slot of this.slots.values())
			if (slot.waiting !== null) this.send(slot.waiting)
		this.slots.clear()
		this.waitingCount = 0
	}
}

// ---- worker protocol

export type MainToEventsWorker =
	| { op: "open"; url: string }
	| { op: "send"; data: string }
	| { op: "close"; code?: number; reason?: string }

export type EventsWorkerToMain =
	| { ev: "open" }
	| { ev: "messages"; texts: string[] }
	| { ev: "error" }
	| { ev: "close" }

export interface RelayDeps {
	post: (message: EventsWorkerToMain) => void
	openSocket: (url: string) => SocketLike
	now: () => number
	setTimer: (fn: () => void, ms: number) => unknown
	clearTimer: (timer: unknown) => void
}

/** The worker side: one WebSocket, fleet updates rate limited, everything else passed on in batches. */
export class EventsRelay {
	private socket: SocketLike | null = null
	private out: string[] = []
	private outTimer: unknown = null
	private sweepTimer: unknown = null
	private readonly throttle: FleetThrottle
	private readonly deps: RelayDeps

	constructor(deps: RelayDeps) {
		this.deps = deps
		this.throttle = new FleetThrottle(text => this.queue(text))
	}

	handle(msg: MainToEventsWorker): void {
		if (msg.op === "open") this.open(msg.url)
		else if (msg.op === "send") {
			try {
				this.socket?.send(msg.data)
			} catch {
				// not open: EventsClient resends its subscriptions on the next open
			}
		} else {
			try {
				this.socket?.close(msg.code, msg.reason)
			} catch {
				// already closed
			}
		}
	}

	private open(url: string): void {
		let socket: SocketLike
		try {
			socket = this.deps.openSocket(url)
		} catch {
			this.deps.post({ ev: "error" })
			this.deps.post({ ev: "close" })
			return
		}
		this.socket = socket
		socket.onopen = () => this.deps.post({ ev: "open" })
		socket.onmessage = event => {
			if (typeof event.data !== "string") return
			this.throttle.push(event.data, this.deps.now())
			if (this.throttle.waiting > 0) this.scheduleSweep()
		}
		socket.onerror = () => this.deps.post({ ev: "error" })
		socket.onclose = () => {
			this.socket = null
			this.stopSweep()
			this.throttle.drain()
			this.flush()
			this.deps.post({ ev: "close" })
		}
	}

	private queue(text: string): void {
		this.out.push(text)
		this.outTimer ??= this.deps.setTimer(() => {
			this.outTimer = null
			this.flush()
		}, OUT_MS)
	}

	private flush(): void {
		if (this.outTimer !== null) {
			this.deps.clearTimer(this.outTimer)
			this.outTimer = null
		}
		if (this.out.length === 0) return
		const texts = this.out
		this.out = []
		this.deps.post({ ev: "messages", texts })
	}

	private scheduleSweep(): void {
		this.sweepTimer ??= this.deps.setTimer(() => {
			this.sweepTimer = null
			this.throttle.sweep(this.deps.now())
			if (this.throttle.waiting > 0) this.scheduleSweep()
		}, UPDATE_EVERY_MS / 4)
	}

	private stopSweep(): void {
		if (this.sweepTimer !== null) this.deps.clearTimer(this.sweepTimer)
		this.sweepTimer = null
	}
}

// ---- main thread

export interface WorkerLike {
	postMessage(message: MainToEventsWorker): void
	onmessage: ((event: { data: EventsWorkerToMain }) => void) | null
	onerror: ((event: unknown) => void) | null
	terminate(): void
}

/** SocketLike over an events worker: one worker per connection, ended with it. */
export class WorkerSocket implements SocketLike {
	readyState = 0
	onopen: ((event: unknown) => void) | null = null
	onclose: ((event: unknown) => void) | null = null
	onerror: ((event: unknown) => void) | null = null
	onmessage: ((event: { data: unknown }) => void) | null = null
	private worker: WorkerLike | null

	constructor(url: string, worker: WorkerLike) {
		this.worker = worker
		worker.onmessage = event => this.receive(event.data)
		worker.onerror = () => {
			this.onerror?.({})
			this.closed()
		}
		worker.postMessage({ op: "open", url })
	}

	send(data: string): void {
		if (this.readyState !== 1) throw new Error("socket is not open")
		this.worker?.postMessage({ op: "send", data })
	}

	close(code?: number, reason?: string): void {
		if (this.readyState >= 2) return
		this.readyState = 2
		this.worker?.postMessage({
			op: "close",
			...(code !== undefined ? { code } : {}),
			...(reason !== undefined ? { reason } : {}),
		})
	}

	private receive(msg: EventsWorkerToMain): void {
		switch (msg.ev) {
			case "open":
				if (this.readyState !== 0) return
				this.readyState = 1
				this.onopen?.({})
				return
			case "messages":
				for (const data of msg.texts) {
					if (this.readyState === 3) return
					this.onmessage?.({ data })
				}
				return
			case "error":
				this.onerror?.({})
				return
			case "close":
				this.closed()
		}
	}

	private closed(): void {
		if (this.readyState === 3) return
		this.readyState = 3
		this.worker?.terminate()
		this.worker = null
		this.onclose?.({})
	}
}

/**
 * The browser's socket factory: a WorkerSocket when module workers are available, else the plain
 * WebSocket (null leaves EventsClient on its default).
 */
export function workerSocketFactory(
	createWorker: () => WorkerLike,
): SocketFactory | null {
	if (typeof Worker !== "function") return null
	return url => {
		try {
			return new WorkerSocket(url, createWorker())
		} catch {
			return new (
				globalThis as unknown as {
					WebSocket: new (url: string) => SocketLike
				}
			).WebSocket(url)
		}
	}
}
