// What the core changes or reports on the receiver by itself, in words: the 1090 MHz rate policy (a sample-rate
// raise for ADS-B, its restore, a raise it skipped) and lost samples on a receiver link. Formatters are pure;
// LinkNotices turns the resources snapshots' `linkAdvisories` into `link:<sourceId>` conditions (the only source
// of link notices) and watchReceiverNotices wires it and the rate policy to the notice service.
//
// The link rule (docs/WEB-APP.md, "Notices"): an episode is the core's (sourceId, episodeSince). It toasts once
// its dropping time within the episode, by the core's clock, reaches ONSET_MS; each distinct text at most once per
// episode; a change to an unknown cause never toasts; ✕ quiets the whole episode. The first snapshot of a page
// load marks every episode it lists as already told (status place only). No fresh snapshot for STALE_MS, or the
// socket down, is stale: the floating toast goes, the onset clock stops and the status place greys.
import type {
	TunerCommandOrigin,
	TunerRatePolicyEventData,
	TunerState,
} from "@wavekit/api-types"
import { z } from "zod"

import type { ApiClient } from "../../data/api-client.ts"
import type { EventsClient } from "../../data/events-client.ts"
import {
	notices as defaultNotices,
	type ConditionKey,
	type NoticeService,
} from "../../shell/notices/service.ts"
import { formatRate } from "../format.ts"

/** Who wrote a tuner setting. */
export const TUNER_ORIGINS: Readonly<Record<TunerCommandOrigin, string>> = {
	rest: "you",
	scanner: "the scanner",
	replay: "the reconnect",
	config: "the configuration",
	"decoder-rate": "the 1090 MHz rate policy",
}

/** The note under Sample rate while the policy holds a raise: "Raised from 2 MS/s by the 1090 MHz rate policy …". */
export function ratePolicyNote(tuner: TunerState | undefined): string | null {
	const p = tuner?.ratePolicy
	if (!p) return null
	return `Raised from ${formatRate(p.raisedFromHz)} by ${TUNER_ORIGINS["decoder-rate"]} for ADS-B; it goes back once ADS-B no longer needs it.`
}

/** Dropping time within an episode, by the core's clock, before it toasts (ms). */
export const ONSET_MS = 6000
/** No snapshot for this long reads stale (the core sends one every 2 s). */
export const STALE_MS = 10_000
/** A skipped raise stays a condition this long after its last event (ms). */
export const RATE_SKIP_TTL_MS = 5 * 60_000
/** The same rate-policy receipt is not repeated within this (ms). */
export const RECEIPT_REPEAT_MS = 60_000

/** Loss on the receiver link: the only cause a lower sample rate fixes. */
export const LINK_LOSS_TEXT =
	"Receiver link dropping samples — lower the sample rate"
/** The core's own loop was too busy to read its socket. */
export const CORE_BUSY_TEXT = "Samples lost: WaveKit is too busy to keep up"
/** The core cannot tell the two apart. */
export const UNKNOWN_LOSS_TEXT = "Receiver samples lost"
/** The Receiver chip's short label while a link condition is active. */
export const SAMPLES_LOST_LABEL = "Samples lost"

/** A link advisory entry as this module reads it (validated at the boundary). */
export interface LinkEntry {
	readonly sourceId: string
	readonly level: string
	readonly lossReason?: string
	readonly since: string
	readonly episodeSince?: string
}

/**
 * The condition text for one advisory entry, or null when it says nothing: only `dropping` lost samples
 * (`unproven` has lost nothing; `branch-congestion` is never on `dropping` and is not the link's fault).
 * Receiver-link loss while the rate policy holds a raise names the raised rate instead of asking for a lower one.
 */
export function linkConditionText(
	entry: Pick<LinkEntry, "level" | "lossReason">,
	tuner: TunerState | undefined,
): string | null {
	if (entry.level !== "dropping") return null
	switch (entry.lossReason) {
		case "source":
		case undefined:
			return tuner?.ratePolicy
				? `Receiver link dropping samples at ${formatRate(tuner.sampleRate)} (raised for ADS-B)`
				: LINK_LOSS_TEXT
		case "core-busy":
			return CORE_BUSY_TEXT
		case "branch-congestion":
			return null
		default:
			// "unknown", and any cause a newer core names
			return UNKNOWN_LOSS_TEXT
	}
}

/** A rate-policy event as a receipt (raised, restored) or a condition (skipped), or null (already above). */
export function ratePolicyNotice(
	e: TunerRatePolicyEventData,
): { kind: "receipt" | "condition"; text: string } | null {
	switch (e.action) {
		case "raised":
			return {
				kind: "receipt",
				text: `Sample rate raised to ${formatRate(e.toHz)} for ADS-B (1090 MHz)`,
			}
		case "restored":
			return {
				kind: "receipt",
				text: `Sample rate back to ${formatRate(e.toHz)}`,
			}
		case "skipped":
			if (e.skipped === "external-control")
				return {
					kind: "condition",
					text: `ADS-B needs ${formatRate(e.toHz)}, but another client has the tuner`,
				}
			if (e.skipped === "write-failed")
				return {
					kind: "condition",
					text: `The receiver refused ${formatRate(e.toHz)} for ADS-B`,
				}
			return null
	}
}

const entrySchema = z.object({
	sourceId: z.string().min(1),
	level: z.string(),
	lossReason: z.string().optional(),
	since: z.string(),
	episodeSince: z.string().optional(),
})
const snapshotSchema = z.object({
	timestamp: z.string(),
	linkAdvisories: z.array(z.unknown()).optional(),
})

/** A snapshot's time and link entries, or null when it is not one. `linkAdvisories` absent reads as none. */
export function parseLinkSnapshot(
	value: unknown,
): { ts: number; entries: LinkEntry[] } | null {
	const snap = snapshotSchema.safeParse(value)
	if (!snap.success) return null
	const ts = Date.parse(snap.data.timestamp)
	if (!Number.isFinite(ts)) return null
	const entries: LinkEntry[] = []
	for (const raw of snap.data.linkAdvisories ?? []) {
		const e = entrySchema.safeParse(raw)
		if (!e.success || !Number.isFinite(Date.parse(e.data.since))) continue
		entries.push(stripUndefined(e.data))
	}
	return { ts, entries }
}

function stripUndefined(e: z.infer<typeof entrySchema>): LinkEntry {
	return {
		sourceId: e.sourceId,
		level: e.level,
		since: e.since,
		...(e.lossReason !== undefined ? { lossReason: e.lossReason } : {}),
		...(e.episodeSince !== undefined ? { episodeSince: e.episodeSince } : {}),
	}
}

interface Episode {
	/** The core's episodeSince: the episode's identity with the source id. */
	readonly id: string
	/** Texts already toasted in it. */
	readonly told: Set<string>
	/** No toast at all: seeded from a page load or reconnect, or dismissed with ✕. */
	quiet: boolean
	/** Dropping time so far, by the core's clock (ms). */
	droppingMs: number
	/** The last fresh snapshot's time that listed this source, and whether it was dropping then. */
	lastTs: number | null
	lastDropping: boolean
}

const linkKey = (sourceId: string): ConditionKey => `link:${sourceId}`
const sourceOfKey = (key: string): string | null =>
	key.startsWith("link:") ? key.slice(5) : null

/** The link rule over a stream of snapshots. Timers are the page's (fake timers in tests). */
export class LinkNotices {
	private readonly episodes = new Map<string, Episode>()
	private seenFirst = false
	private reseedNext = false
	private stale = false
	private lastTs = -Infinity
	private staleTimer: ReturnType<typeof setTimeout> | null = null

	constructor(
		private readonly service: NoticeService,
		private readonly tunerOf: (sourceId: string) => TunerState | undefined,
	) {}

	/** A resources snapshot from the socket or GET /api/resources. */
	snapshot(value: unknown): void {
		const snap = parseLinkSnapshot(value)
		// an older tick (a slow GET after a socket snapshot) changes nothing
		if (!snap || snap.ts < this.lastTs) return
		this.lastTs = snap.ts
		const first = !this.seenFirst
		this.seenFirst = true
		const reseed = this.reseedNext
		this.reseedNext = false
		const afterStale = this.stale
		this.stale = false
		this.armStale()

		const listed = new Set<string>()
		for (const e of snap.entries) {
			listed.add(e.sourceId)
			// a page load seeds every episode; a reconnect only sources with no episode in memory
			const seed = first || (reseed && !this.episodes.has(e.sourceId))
			this.entry(e, snap.ts, seed, afterStale)
		}
		// absent from a fresh snapshot: the condition and its episode end
		for (const key of this.service.conditions.get().keys()) {
			const id = sourceOfKey(key)
			if (id !== null && !listed.has(id)) this.service.clear(key)
		}
		for (const id of [...this.episodes.keys()])
			if (!listed.has(id)) this.episodes.delete(id)
	}

	/** The socket closed: everything it said may be out of date. */
	socketDown(): void {
		this.goStale()
	}

	/** The socket reconnected: the next snapshot seeds episodes the page has not seen. */
	reconnected(): void {
		this.reseedNext = true
	}

	dispose(): void {
		if (this.staleTimer !== null) clearTimeout(this.staleTimer)
		this.staleTimer = null
	}

	private entry(
		e: LinkEntry,
		ts: number,
		seed: boolean,
		afterStale: boolean,
	): void {
		const key = linkKey(e.sourceId)
		const epId =
			e.episodeSince ?? (e.level === "dropping" ? e.since : undefined)
		let ep: Episode | undefined
		if (epId === undefined) this.episodes.delete(e.sourceId)
		else {
			ep = this.episodes.get(e.sourceId)
			if (!ep || ep.id !== epId) {
				ep = {
					id: epId,
					told: new Set(),
					quiet: seed,
					droppingMs: 0,
					lastTs: null,
					lastDropping: false,
				}
				this.episodes.set(e.sourceId, ep)
			}
		}
		const text = linkConditionText(e, this.tunerOf(e.sourceId))
		if (text === null) {
			this.service.clear(key)
			if (ep) {
				ep.lastTs = ts
				ep.lastDropping = false
			}
			return
		}
		let toast = false
		if (ep) {
			// the onset clock stops while stale: the first snapshot after it only sets the reference
			if (!afterStale) {
				const since = Date.parse(e.since)
				const start =
					ep.lastDropping && ep.lastTs !== null
						? ep.lastTs
						: Math.max(since, ep.lastTs ?? -Infinity)
				ep.droppingMs += Math.max(0, ts - start)
			}
			ep.lastTs = ts
			ep.lastDropping = true
			const unknownChange = text === UNKNOWN_LOSS_TEXT && ep.told.size > 0
			toast =
				!ep.quiet &&
				!ep.told.has(text) &&
				!unknownChange &&
				ep.droppingMs >= ONSET_MS
		}
		const episode = ep
		this.service.raise(
			key,
			{
				text,
				tone: "warn",
				onDismiss: () => {
					if (episode) episode.quiet = true
				},
				// a text is told once its toast shows (or the open Receiver panel hid it), not while it waits
				onToast: shown => episode?.told.add(shown),
			},
			toast,
		)
	}

	private armStale(): void {
		if (this.staleTimer !== null) clearTimeout(this.staleTimer)
		this.staleTimer = setTimeout(() => {
			this.staleTimer = null
			this.goStale()
		}, STALE_MS)
	}

	private goStale(): void {
		if (this.staleTimer !== null) clearTimeout(this.staleTimer)
		this.staleTimer = null
		if (this.stale) return
		this.stale = true
		for (const [key, c] of this.service.conditions.get()) {
			if (sourceOfKey(key) === null) continue
			this.service.fold(key)
			this.service.raise(key, { ...c, stale: true })
		}
	}
}

/** The rate policy's notices: raised and restored as receipts, a skipped raise as a condition with a TTL. */
export class RatePolicyNotices {
	private readonly receiptAt = new Map<string, number>()
	private readonly ttl = new Map<string, ReturnType<typeof setTimeout>>()

	constructor(private readonly service: NoticeService) {}

	event(e: TunerRatePolicyEventData): void {
		const n = ratePolicyNotice(e)
		if (!n) return
		const key: ConditionKey = `rate-policy-skip:${e.sourceId}`
		if (n.kind === "receipt") {
			this.endSkip(key)
			const now = Date.now()
			const at = this.receiptAt.get(n.text)
			if (at !== undefined && now - at < RECEIPT_REPEAT_MS) return
			this.receiptAt.set(n.text, now)
			this.service.showReceipt(n.text)
			return
		}
		const active = this.service.conditions.get().get(key)
		this.service.raise(
			key,
			{ text: n.text, tone: "warn" },
			active?.text !== n.text,
		)
		const old = this.ttl.get(key)
		if (old !== undefined) clearTimeout(old)
		this.ttl.set(
			key,
			setTimeout(() => this.endSkip(key), RATE_SKIP_TTL_MS),
		)
	}

	dispose(): void {
		for (const t of this.ttl.values()) clearTimeout(t)
		this.ttl.clear()
	}

	private endSkip(key: ConditionKey): void {
		const t = this.ttl.get(key)
		if (t !== undefined) clearTimeout(t)
		this.ttl.delete(key)
		this.service.clear(key)
	}
}

export interface ReceiverNoticeDeps {
	readonly api: Pick<ApiClient, "get">
	readonly tunerOf: (sourceId: string) => TunerState | undefined
	readonly service?: NoticeService
}

/** Wires the link and rate-policy notices to the page's event socket and GET /api/resources. */
export function watchReceiverNotices(
	events: Pick<
		EventsClient,
		"subscribe" | "on" | "onAny" | "onState" | "onReconnected"
	>,
	deps: ReceiverNoticeDeps,
): () => void {
	const service = deps.service ?? defaultNotices
	const link = new LinkNotices(service, deps.tunerOf)
	const policy = new RatePolicyNotices(service)
	let disposed = false
	const load = () => {
		deps.api.get<unknown>("/api/resources").then(
			body => {
				if (!disposed) link.snapshot(body)
			},
			() => undefined,
		)
	}
	let opened = false
	const offs = [
		events.subscribe(["resources"]),
		events.on("tuner:rate-policy", e => policy.event(e)),
		events.onAny(m => {
			if (m.type === "resources:snapshot") link.snapshot(m.data)
		}),
		events.onState(state => {
			if (state === "open") {
				// the first open: the core is reachable and the session settled
				if (!opened) load()
				opened = true
			} else if (state === "closed") link.socketDown()
		}),
		events.onReconnected(() => {
			link.reconnected()
			load()
		}),
	]
	return () => {
		disposed = true
		for (const off of offs.splice(0)) off()
		link.dispose()
		policy.dispose()
	}
}
