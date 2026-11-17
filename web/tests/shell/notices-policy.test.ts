// The notice policy (docs/WEB-APP.md "Notices"), one row per rule: the notice service (src/shell/notices) and the
// link and rate-policy rules (src/features/receiver/notices.ts) on fake timers, snapshots fed with explicit core
// timestamps.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { TunerRatePolicyEventData, TunerState } from "@wavekit/api-types"

import {
	CORE_BUSY_TEXT,
	LINK_LOSS_TEXT,
	LinkNotices,
	ONSET_MS,
	RATE_SKIP_TTL_MS,
	RatePolicyNotices,
	STALE_MS,
	UNKNOWN_LOSS_TEXT,
	linkConditionText,
	watchReceiverNotices,
} from "../../src/features/receiver/notices.ts"
import {
	CONDITION_TOAST_MS,
	NoticeService,
	RECEIPT_MS,
} from "../../src/shell/notices/service.ts"
import { regionTop } from "../../src/shell/notices/top-centre.ts"
import { shellLayout, DEFAULT_GEOMETRY } from "../../src/shell/layout.ts"

const T0 = Date.parse("2026-11-16T10:00:00.000Z")
const iso = (ms: number) => new Date(T0 + ms).toISOString()

type Reason = "source" | "core-busy" | "unknown" | "branch-congestion"
const drop = (since: number, ep: number, lossReason: Reason = "source") => ({
	sourceId: "rx",
	level: "dropping",
	lossReason,
	since: iso(since),
	episodeSince: iso(ep),
})
const calm = (since: number, ep?: number, level = "none") => ({
	sourceId: "rx",
	level,
	since: iso(since),
	...(ep !== undefined ? { episodeSince: iso(ep) } : {}),
})

interface Harness {
	svc: NoticeService
	link: LinkNotices
	policy: RatePolicyNotices
	tuner: { current: TunerState | undefined }
	/** Every condition toast that appeared (by id), in order. */
	toasts: string[]
	/** Feeds a snapshot at core time `t` (ms after T0); the page clock moves to it first. */
	feed: (t: number, entries: unknown[] | undefined) => void
	/** Moves the page clock to `t` without a snapshot. */
	wait: (t: number) => void
	condition: () => { text: string; stale?: boolean } | undefined
}

function harness(): Harness {
	const svc = new NoticeService()
	const tuner = { current: undefined as TunerState | undefined }
	const link = new LinkNotices(svc, () => tuner.current)
	const policy = new RatePolicyNotices(svc)
	const toasts: string[] = []
	let lastId = -1
	svc.shown.subscribe(s => {
		if (s && s.id !== lastId) toasts.push(s.text)
		lastId = s?.id ?? -1
	})
	let now = 0
	const wait = (t: number) => {
		if (t > now) vi.advanceTimersByTime(t - now)
		now = Math.max(now, t)
	}
	const feed = (t: number, entries: unknown[] | undefined) => {
		wait(t)
		link.snapshot({
			timestamp: iso(t),
			...(entries ? { linkAdvisories: entries } : {}),
		})
	}
	return {
		svc,
		link,
		policy,
		tuner,
		toasts,
		feed,
		wait,
		condition: () => svc.conditions.get().get("link:rx"),
	}
}

/** A page that has seen one quiet snapshot (so the page-load seed is behind it). */
function loaded(): Harness {
	const h = harness()
	h.feed(0, [])
	return h
}

/** Dropping from `from` every 2 s through `to` (core time), one episode starting at `ep`. */
function dropping(
	h: Harness,
	from: number,
	to: number,
	ep: number,
	reason: Reason = "source",
	since = from,
) {
	for (let t = from; t <= to; t += 2000) h.feed(t, [drop(since, ep, reason)])
}

const raised = (
	over: Partial<TunerRatePolicyEventData> = {},
): TunerRatePolicyEventData => ({
	sourceId: "rx",
	action: "raised",
	reason: "adsb-1090",
	fromHz: 2_048_000,
	toHz: 2_400_000,
	...over,
})

const lowerWords = (text: string) => /lower|sample rate/i.test(text)

beforeEach(() => {
	vi.useFakeTimers()
	vi.setSystemTime(T0)
})
afterEach(() => {
	vi.useRealTimers()
})

const RULES: { rule: string; run: () => void }[] = [
	{
		rule: "onset: an episode toasts once its dropping time by the core's clock reaches 6 s, the status place at once",
		run: () => {
			const h = loaded()
			h.feed(2000, [drop(2000, 2000)])
			expect(h.condition()?.text).toBe(LINK_LOSS_TEXT)
			expect(h.toasts).toEqual([])
			h.feed(4000, [drop(2000, 2000)])
			h.feed(6000, [drop(2000, 2000)])
			expect(h.toasts).toEqual([])
			h.feed(2000 + ONSET_MS, [drop(2000, 2000)])
			expect(h.toasts).toEqual([LINK_LOSS_TEXT])
		},
	},
	{
		rule: "onset counts the time before the first snapshot from the entry's since",
		run: () => {
			const h = loaded()
			h.feed(2000, [drop(-2000, -2000)])
			expect(h.toasts).toEqual([])
			h.feed(4000, [drop(-2000, -2000)])
			expect(h.toasts).toEqual([LINK_LOSS_TEXT])
		},
	},
	{
		rule: "dropping → recovered → dropping within one episode is one toast",
		run: () => {
			const h = loaded()
			dropping(h, 2000, 10_000, 2000)
			h.feed(12_000, [calm(11_000, 2000)])
			expect(h.condition()).toBeUndefined()
			dropping(h, 14_000, 30_000, 2000)
			h.feed(32_000, [calm(31_000, 2000)])
			dropping(h, 34_000, 50_000, 2000)
			expect(h.toasts).toEqual([LINK_LOSS_TEXT])
		},
	},
	{
		rule: "short drops within one episode add up to the onset",
		run: () => {
			const h = loaded()
			h.feed(2000, [drop(2000, 2000)])
			h.feed(4000, [drop(2000, 2000)])
			h.feed(6000, [calm(5000, 2000)])
			h.feed(8000, [drop(7000, 2000)])
			h.feed(10_000, [drop(7000, 2000)])
			expect(h.toasts).toEqual([])
			h.feed(12_000, [drop(7000, 2000)])
			// 2000→4000 (2 s), then 7000→12000 (5 s): 7 s
			expect(h.toasts).toEqual([LINK_LOSS_TEXT])
		},
	},
	{
		rule: "dismiss (✕) quiets the whole episode: no re-toast while it persists, nor for a cause change",
		run: () => {
			const h = loaded()
			dropping(h, 2000, 8000, 2000)
			expect(h.toasts).toHaveLength(1)
			h.svc.dismissShown()
			expect(h.svc.shown.get()).toBeNull()
			expect(h.condition()?.text).toBe(LINK_LOSS_TEXT)
			dropping(h, 10_000, 40_000, 2000)
			dropping(h, 42_000, 60_000, 2000, "core-busy", 42_000)
			expect(h.toasts).toHaveLength(1)
			expect(h.condition()?.text).toBe(CORE_BUSY_TEXT)
		},
	},
	{
		rule: "an episode the core ends (episodeSince removed) and a new one is one new toast",
		run: () => {
			const h = loaded()
			dropping(h, 2000, 8000, 2000)
			h.svc.dismissShown()
			h.feed(10_000, [calm(9000, 2000)])
			h.feed(70_000, [calm(9000)])
			dropping(h, 72_000, 78_000, 72_000)
			expect(h.toasts).toEqual([LINK_LOSS_TEXT, LINK_LOSS_TEXT])
			dropping(h, 80_000, 90_000, 72_000)
			expect(h.toasts).toHaveLength(2)
		},
	},
	{
		rule: "each distinct text toasts at most once per episode",
		run: () => {
			const h = loaded()
			dropping(h, 2000, 8000, 2000)
			h.wait(20_000)
			dropping(h, 20_000, 22_000, 2000, "core-busy", 19_000)
			expect(h.toasts).toEqual([LINK_LOSS_TEXT, CORE_BUSY_TEXT])
			dropping(h, 24_000, 26_000, 2000, "source", 23_000)
			dropping(h, 28_000, 30_000, 2000, "core-busy", 27_000)
			expect(h.toasts).toEqual([LINK_LOSS_TEXT, CORE_BUSY_TEXT])
		},
	},
	{
		rule: "a change to cause unknown never toasts; the status place takes its text",
		run: () => {
			const h = loaded()
			dropping(h, 2000, 8000, 2000)
			dropping(h, 10_000, 20_000, 2000, "unknown", 9000)
			expect(h.toasts).toEqual([LINK_LOSS_TEXT])
			expect(h.condition()?.text).toBe(UNKNOWN_LOSS_TEXT)
		},
	},
	{
		rule: "an episode that starts unknown toasts its own text",
		run: () => {
			const h = loaded()
			dropping(h, 2000, 8000, 2000, "unknown")
			expect(h.toasts).toEqual([UNKNOWN_LOSS_TEXT])
		},
	},
	{
		rule: "core-busy and unknown never speak of lowering the sample rate (toast, status place, raised receipt)",
		run: () => {
			for (const reason of ["core-busy", "unknown"] as const) {
				const h = loaded()
				h.tuner.current = {
					sampleRate: 2_400_000,
					ratePolicy: { raisedFromHz: 2_048_000, since: iso(0) },
				} as TunerState
				dropping(h, 2000, 8000, 2000, reason)
				expect(h.toasts).toHaveLength(1)
				expect(lowerWords(h.toasts[0] ?? "lower")).toBe(false)
				expect(lowerWords(h.condition()?.text ?? "lower")).toBe(false)
				h.policy.event(raised())
				const receipt = h.svc.receipt.get()?.text ?? ""
				expect(receipt).toBe(
					"Sample rate raised to 2.4 MS/s for ADS-B (1090 MHz)",
				)
				expect(receipt).not.toMatch(/lower|link|dropping/i)
			}
		},
	},
	{
		rule: "receiver-link loss while the rate policy holds a raise names the raised rate",
		run: () => {
			const h = loaded()
			h.tuner.current = {
				sampleRate: 2_400_000,
				ratePolicy: { raisedFromHz: 2_048_000, since: iso(0) },
			} as TunerState
			dropping(h, 2000, 8000, 2000)
			expect(h.toasts).toEqual([
				"Receiver link dropping samples at 2.4 MS/s (raised for ADS-B)",
			])
		},
	},
	{
		rule: "branch-congestion, unproven and none say nothing",
		run: () => {
			const h = loaded()
			h.feed(2000, [calm(0, undefined, "unproven")])
			h.feed(4000, [
				{ ...calm(0, undefined, "unproven"), lossReason: "branch-congestion" },
			])
			h.feed(6000, [calm(0)])
			expect(h.condition()).toBeUndefined()
			expect(h.toasts).toEqual([])
			expect(
				linkConditionText(
					{ level: "dropping", lossReason: "branch-congestion" },
					undefined,
				),
			).toBeNull()
		},
	},
	{
		rule: "the first snapshot of a page load marks every listed episode told: status place, no toast",
		run: () => {
			const h = harness()
			h.feed(0, [drop(-30_000, -30_000)])
			expect(h.condition()?.text).toBe(LINK_LOSS_TEXT)
			dropping(h, 2000, 30_000, -30_000, "source", -30_000)
			expect(h.toasts).toEqual([])
		},
	},
	{
		rule: "the first snapshot seeds an episode that is not dropping now: its return is no toast",
		run: () => {
			const h = harness()
			h.feed(0, [calm(-10_000, -30_000)])
			expect(h.condition()).toBeUndefined()
			dropping(h, 2000, 20_000, -30_000)
			expect(h.toasts).toEqual([])
			expect(h.condition()?.text).toBe(LINK_LOSS_TEXT)
		},
	},
	{
		rule: "reconnect never wipes a dismissal",
		run: () => {
			const h = loaded()
			dropping(h, 2000, 8000, 2000)
			h.svc.dismissShown()
			h.link.socketDown()
			h.link.reconnected()
			dropping(h, 20_000, 40_000, 2000)
			expect(h.toasts).toHaveLength(1)
		},
	},
	{
		rule: "reconnect seeds a source with no episode in memory: status place, no toast",
		run: () => {
			const h = loaded()
			h.link.socketDown()
			h.link.reconnected()
			dropping(h, 30_000, 50_000, 25_000, "source", 25_000)
			expect(h.condition()?.text).toBe(LINK_LOSS_TEXT)
			expect(h.toasts).toEqual([])
		},
	},
	{
		rule: "reconnect does not seed a source with an episode in memory: a new episode there toasts",
		run: () => {
			const h = loaded()
			dropping(h, 2000, 8000, 2000)
			// the condition ended before the socket went down
			h.feed(10_000, [calm(10_000, 2000)])
			h.link.socketDown()
			h.link.reconnected()
			dropping(h, 100_000, 106_000, 99_000)
			expect(h.toasts).toEqual([LINK_LOSS_TEXT, LINK_LOSS_TEXT])
		},
	},
	{
		rule: "a core restart mid-condition (new episode id on the first snapshot after a reconnect) never re-toasts",
		run: () => {
			const h = loaded()
			dropping(h, 2000, 8000, 2000)
			expect(h.toasts).toEqual([LINK_LOSS_TEXT])
			h.link.socketDown()
			h.link.reconnected()
			// the new process starts its own episode for the same, still-active condition
			dropping(h, 40_000, 60_000, 39_000, "source", 39_000)
			expect(h.toasts).toEqual([LINK_LOSS_TEXT])
			expect(h.condition()?.text).toBe(LINK_LOSS_TEXT)
		},
	},
	{
		rule: "a core restart mid-condition keeps the ✕: no toast, a new text included",
		run: () => {
			const h = loaded()
			dropping(h, 2000, 8000, 2000)
			h.svc.dismissShown()
			h.link.socketDown()
			h.link.reconnected()
			dropping(h, 40_000, 60_000, 39_000, "source", 39_000)
			dropping(h, 62_000, 80_000, 39_000, "core-busy", 39_000)
			expect(h.toasts).toEqual([LINK_LOSS_TEXT])
			expect(h.condition()?.text).toBe(CORE_BUSY_TEXT)
		},
	},
	{
		rule: "a core restart mid-condition, not dismissed: a new text still toasts once",
		run: () => {
			const h = loaded()
			dropping(h, 2000, 8000, 2000)
			h.link.socketDown()
			h.link.reconnected()
			dropping(h, 40_000, 50_000, 39_000, "source", 39_000)
			dropping(h, 52_000, 70_000, 39_000, "core-busy", 39_000)
			expect(h.toasts).toEqual([LINK_LOSS_TEXT, CORE_BUSY_TEXT])
		},
	},
	{
		rule: "a core restart mid-condition before the onset: the carried episode still toasts at its onset",
		run: () => {
			const h = loaded()
			dropping(h, 2000, 4000, 2000)
			expect(h.toasts).toEqual([])
			h.link.socketDown()
			h.link.reconnected()
			// the first snapshot after the gap only sets the reference: 2 s + 2 s + 2 s
			dropping(h, 30_000, 32_000, 29_000, "source", 29_000)
			expect(h.toasts).toEqual([])
			h.feed(34_000, [drop(29_000, 29_000)])
			expect(h.toasts).toEqual([LINK_LOSS_TEXT])
		},
	},
	{
		rule: "a core restart mid-condition with a new cause, not dismissed: the new text toasts",
		run: () => {
			const h = loaded()
			dropping(h, 2000, 8000, 2000)
			h.link.socketDown()
			h.link.reconnected()
			dropping(h, 40_000, 50_000, 39_000, "core-busy", 39_000)
			expect(h.toasts).toEqual([LINK_LOSS_TEXT, CORE_BUSY_TEXT])
		},
	},
	{
		rule: "reconnect keeps a pending episode the page knows: it still toasts at its onset",
		run: () => {
			const h = loaded()
			dropping(h, 2000, 4000, 2000)
			h.link.socketDown()
			h.link.reconnected()
			// the first snapshot after the gap only sets the reference: 2 s + 2 s + 2 s
			dropping(h, 30_000, 32_000, 2000, "source", 2000)
			expect(h.toasts).toEqual([])
			h.feed(34_000, [drop(2000, 2000)])
			expect(h.toasts).toEqual([LINK_LOSS_TEXT])
		},
	},
	{
		rule: "no snapshot for over 10 s is stale: the toast goes, the status place greys, fresh again ungreys",
		run: () => {
			const h = loaded()
			dropping(h, 2000, 8000, 2000)
			expect(h.svc.shown.get()).not.toBeNull()
			h.wait(8000 + STALE_MS)
			expect(h.svc.shown.get()).toBeNull()
			expect(h.condition()?.stale).toBe(true)
			h.feed(20_000, [drop(2000, 2000)])
			expect(h.condition()?.stale).toBeUndefined()
			expect(h.toasts).toHaveLength(1)
		},
	},
	{
		rule: "a closed socket is stale at once",
		run: () => {
			const h = loaded()
			dropping(h, 2000, 8000, 2000)
			h.link.socketDown()
			expect(h.svc.shown.get()).toBeNull()
			expect(h.condition()?.stale).toBe(true)
		},
	},
	{
		rule: "stale freezes the onset clock",
		run: () => {
			const h = loaded()
			dropping(h, 2000, 6000, 2000)
			h.wait(30_000)
			h.feed(30_000, [drop(2000, 2000)])
			expect(h.toasts).toEqual([])
			h.feed(32_000, [drop(2000, 2000)])
			expect(h.toasts).toEqual([LINK_LOSS_TEXT])
		},
	},
	{
		rule: "a key absent from a fresh snapshot is cleared",
		run: () => {
			const h = loaded()
			h.feed(2000, [drop(2000, 2000)])
			h.feed(4000, [])
			expect(h.condition()).toBeUndefined()
		},
	},
	{
		rule: "linkAdvisories undefined (an older core) is no link condition",
		run: () => {
			const h = loaded()
			h.feed(2000, [drop(2000, 2000)])
			h.feed(4000, undefined)
			expect(h.condition()).toBeUndefined()
		},
	},
	{
		rule: "an older tick (a slow GET after a socket snapshot) changes nothing",
		run: () => {
			const h = loaded()
			h.feed(4000, [drop(4000, 4000)])
			h.link.snapshot({ timestamp: iso(3000), linkAdvisories: [] })
			expect(h.condition()?.text).toBe(LINK_LOSS_TEXT)
		},
	},
	{
		rule: "a condition toast shows 8 s, then folds into the status place",
		run: () => {
			const h = loaded()
			dropping(h, 2000, 8000, 2000)
			h.wait(8000 + CONDITION_TOAST_MS - 1)
			expect(h.svc.shown.get()).not.toBeNull()
			h.wait(8000 + CONDITION_TOAST_MS)
			expect(h.svc.shown.get()).toBeNull()
			expect(h.condition()).toBeDefined()
		},
	},
	{
		rule: "a condition toast finishes its 8 s when the condition clears meanwhile",
		run: () => {
			const h = loaded()
			dropping(h, 2000, 8000, 2000)
			h.feed(10_000, [calm(9000, 2000)])
			expect(h.condition()).toBeUndefined()
			expect(h.svc.shown.get()?.text).toBe(LINK_LOSS_TEXT)
			h.wait(8000 + CONDITION_TOAST_MS)
			expect(h.svc.shown.get()).toBeNull()
		},
	},
	{
		rule: "no floating link toast while the Receiver panel is open",
		run: () => {
			const h = loaded()
			h.svc.setLinkToastsHidden(true)
			dropping(h, 2000, 8000, 2000)
			expect(h.svc.shown.get()).toBeNull()
			expect(h.condition()).toBeDefined()
			h.svc.setLinkToastsHidden(false)
			dropping(h, 10_000, 20_000, 2000)
			expect(h.toasts).toEqual([])
		},
	},
	{
		rule: "a receipt never displaces a condition toast, nor a condition toast a receipt and its Undo",
		run: () => {
			const h = loaded()
			const undo = vi.fn()
			dropping(h, 2000, 6000, 2000)
			h.svc.showReceipt("Removed band", { undo })
			h.feed(8000, [drop(2000, 2000)])
			expect(h.svc.receipt.get()?.text).toBe("Removed band")
			expect(h.svc.receipt.get()?.undo).toBe(undo)
			expect(h.svc.shown.get()?.text).toBe(LINK_LOSS_TEXT)
			h.svc.showReceipt("Copied 145.000")
			expect(h.svc.shown.get()?.text).toBe(LINK_LOSS_TEXT)
			expect(h.svc.receipt.get()?.text).toBe("Copied 145.000")
		},
	},
	{
		rule: "a receipt shows 6 s and replaces only the previous receipt",
		run: () => {
			const h = loaded()
			h.svc.showReceipt("Saved")
			h.wait(RECEIPT_MS - 1)
			expect(h.svc.receipt.get()?.text).toBe("Saved")
			h.wait(RECEIPT_MS)
			expect(h.svc.receipt.get()).toBeNull()
		},
	},
	{
		rule: "the PWA update persists until Reload or ✕ and is never displaced",
		run: () => {
			const h = loaded()
			const run = vi.fn()
			h.svc.raise(
				"pwa-update",
				{
					text: "WaveKit was updated",
					persist: true,
					dismissEnds: true,
					action: { label: "Reload", run },
				},
				true,
			)
			h.svc.raise("voice-start", { text: "Voice failed", tone: "warn" }, true)
			h.svc.showReceipt("Saved")
			h.wait(600_000)
			expect(h.svc.shown.get()?.key).toBe("pwa-update")
			expect(h.svc.receipt.get()).toBeNull()
			// the other condition waited; Reload ends the update and it shows
			h.svc.runShownAction()
			expect(run).toHaveBeenCalledOnce()
			expect(h.svc.conditions.get().has("pwa-update")).toBe(false)
			expect(h.svc.shown.get()?.key).toBe("voice-start")
			// ✕ on an update ends it too; a new update waits for the toast on screen
			h.svc.raise(
				"pwa-update",
				{ text: "WaveKit was updated", persist: true, dismissEnds: true },
				true,
			)
			expect(h.svc.shown.get()?.key).toBe("voice-start")
			h.wait(600_000 + CONDITION_TOAST_MS)
			expect(h.svc.shown.get()?.key).toBe("pwa-update")
			h.svc.dismissShown()
			expect(h.svc.conditions.get().has("pwa-update")).toBe(false)
		},
	},
	{
		rule: "a condition toast is never displaced: another condition waits and shows next if still active",
		run: () => {
			const h = loaded()
			dropping(h, 2000, 8000, 2000)
			expect(h.svc.shown.get()?.key).toBe("link:rx")
			h.svc.raise("voice-start", { text: "Voice failed", tone: "warn" }, true)
			h.svc.raise(
				"rate-policy-skip:rx",
				{ text: "Raise skipped", tone: "warn" },
				true,
			)
			// the link toast keeps its full time
			h.wait(8000 + CONDITION_TOAST_MS - 1)
			expect(h.svc.shown.get()?.key).toBe("link:rx")
			// voice-start cleared while it waited: it is skipped, the next one shows
			h.svc.clear("voice-start")
			h.wait(8000 + CONDITION_TOAST_MS)
			expect(h.svc.shown.get()?.key).toBe("rate-policy-skip:rx")
			expect(h.toasts).toEqual([LINK_LOSS_TEXT, "Raise skipped"])
			// a toast of the same key takes the new text in place
			h.svc.raise(
				"rate-policy-skip:rx",
				{ text: "Raise skipped again", tone: "warn" },
				true,
			)
			expect(h.svc.shown.get()?.text).toBe("Raise skipped again")
		},
	},
	{
		rule: "palette open pauses both timers; a condition resuming after its condition cleared is dropped",
		run: () => {
			const h = loaded()
			dropping(h, 2000, 8000, 2000)
			h.svc.showReceipt("Saved")
			h.svc.setPaused("palette", true)
			// fresh snapshots keep coming while the palette is open
			dropping(h, 10_000, 58_000, 2000, "source", 2000)
			expect(h.svc.receipt.get()?.text).toBe("Saved")
			expect(h.svc.shown.get()?.text).toBe(LINK_LOSS_TEXT)
			h.feed(60_000, [calm(59_000, 2000)])
			h.svc.setPaused("palette", false)
			expect(h.svc.shown.get()).toBeNull()
			expect(h.svc.receipt.get()?.text).toBe("Saved")
			h.wait(60_000 + RECEIPT_MS - 1)
			expect(h.svc.receipt.get()?.text).toBe("Saved")
			h.wait(60_000 + RECEIPT_MS)
			expect(h.svc.receipt.get()).toBeNull()
		},
	},
	{
		rule: "hover and focus inside the toast pause its timers too",
		run: () => {
			const h = loaded()
			h.svc.raise("voice-start", { text: "Voice failed", tone: "warn" }, true)
			h.svc.setPaused("hover", true)
			h.svc.setPaused("focus", true)
			h.wait(100_000)
			h.svc.setPaused("hover", false)
			h.wait(100_001)
			expect(h.svc.shown.get()?.key).toBe("voice-start")
			// it resumes with the 8 s it had left
			h.svc.setPaused("focus", false)
			h.wait(100_001 + CONDITION_TOAST_MS - 1)
			expect(h.svc.shown.get()).not.toBeNull()
			h.wait(100_001 + CONDITION_TOAST_MS)
			expect(h.svc.shown.get()).toBeNull()
		},
	},
	{
		rule: "focus pause ends when the toast holding focus goes (no blur when its ✕ unmounts)",
		run: () => {
			const h = loaded()
			dropping(h, 2000, 8000, 2000)
			h.svc.showReceipt("Saved")
			const shown = h.svc.shown.get()
			if (!shown) throw new Error("no condition toast")
			// focus on the condition toast's ✕, then ✕: the button unmounts with no blur
			h.svc.setFocusedToast(shown.id)
			h.wait(8000 + RECEIPT_MS)
			expect(h.svc.receipt.get()?.text).toBe("Saved")
			h.svc.dismissShown()
			h.wait(8000 + 2 * RECEIPT_MS - 1)
			expect(h.svc.receipt.get()?.text).toBe("Saved")
			h.wait(8000 + 2 * RECEIPT_MS)
			expect(h.svc.receipt.get()).toBeNull()
		},
	},
	{
		rule: "focus pause ends when the receipt holding focus goes by Undo",
		run: () => {
			const h = loaded()
			const undo = vi.fn()
			// a condition with no stale clock of its own (a link one folds when snapshots stop)
			h.svc.raise("voice-start", { text: "Voice failed", tone: "warn" }, true)
			h.svc.showReceipt("Removed band", { undo })
			const receipt = h.svc.receipt.get()
			if (!receipt) throw new Error("no receipt")
			h.svc.setFocusedToast(receipt.id)
			h.wait(2 * CONDITION_TOAST_MS)
			expect(h.svc.shown.get()?.key).toBe("voice-start")
			// Undo runs and dismisses the receipt: its button unmounts with no blur
			receipt.undo?.()
			h.svc.dismissReceipt()
			expect(undo).toHaveBeenCalledOnce()
			h.wait(3 * CONDITION_TOAST_MS - 1)
			expect(h.svc.shown.get()?.key).toBe("voice-start")
			h.wait(3 * CONDITION_TOAST_MS)
			expect(h.svc.shown.get()).toBeNull()
		},
	},
	{
		rule: "focus moving from one toast to the other keeps the pause until that one goes",
		run: () => {
			const h = loaded()
			dropping(h, 2000, 8000, 2000)
			h.svc.showReceipt("Saved")
			const shown = h.svc.shown.get()
			const receipt = h.svc.receipt.get()
			if (!shown || !receipt) throw new Error("no toasts")
			h.svc.setFocusedToast(shown.id)
			h.svc.setFocusedToast(receipt.id)
			h.svc.dismissShown()
			h.wait(8000 + 2 * RECEIPT_MS)
			expect(h.svc.receipt.get()?.text).toBe("Saved")
			h.svc.setFocusedToast(null)
			h.wait(8000 + 3 * RECEIPT_MS)
			expect(h.svc.receipt.get()).toBeNull()
		},
	},
	{
		rule: "✕ on a toast finishing its 8 s after its condition cleared still quiets the episode",
		run: () => {
			const h = loaded()
			dropping(h, 2000, 8000, 2000)
			h.feed(10_000, [calm(9000, 2000)])
			expect(h.condition()).toBeUndefined()
			expect(h.svc.shown.get()?.text).toBe(LINK_LOSS_TEXT)
			h.svc.dismissShown()
			// the same episode drops again, now for a cause not yet told: quiet after ✕
			dropping(h, 12_000, 30_000, 2000, "core-busy", 12_000)
			expect(h.toasts).toEqual([LINK_LOSS_TEXT])
			expect(h.condition()?.text).toBe(CORE_BUSY_TEXT)
		},
	},
	{
		rule: "a link toast waiting behind the PWA update is told only for the text it shows",
		run: () => {
			const h = loaded()
			h.svc.raise(
				"pwa-update",
				{ text: "WaveKit was updated", persist: true, dismissEnds: true },
				true,
			)
			// loss on the link waits behind the update, then the cause turns to a busy core
			dropping(h, 2000, 8000, 2000)
			dropping(h, 10_000, 12_000, 2000, "core-busy", 2000)
			expect(h.svc.shown.get()?.key).toBe("pwa-update")
			h.svc.dismissShown()
			// the waiting toast shows the current text, and only that text is told
			expect(h.svc.shown.get()?.text).toBe(CORE_BUSY_TEXT)
			h.wait(12_000 + CONDITION_TOAST_MS)
			expect(h.svc.shown.get()).toBeNull()
			// link loss, never shown, still toasts once in this episode; the busy core does not repeat
			dropping(h, 22_000, 24_000, 2000, "source", 2000)
			dropping(h, 26_000, 28_000, 2000, "core-busy", 2000)
			expect(h.toasts).toEqual([
				"WaveKit was updated",
				CORE_BUSY_TEXT,
				LINK_LOSS_TEXT,
			])
		},
	},
	{
		rule: "a link toast held back by the open Receiver panel counts as told",
		run: () => {
			const h = loaded()
			h.svc.raise(
				"pwa-update",
				{ text: "WaveKit was updated", persist: true, dismissEnds: true },
				true,
			)
			dropping(h, 2000, 8000, 2000)
			// the panel opens while it waits: dequeued hidden, counted told
			h.svc.setLinkToastsHidden(true)
			h.svc.dismissShown()
			h.svc.setLinkToastsHidden(false)
			dropping(h, 10_000, 20_000, 2000, "source", 2000)
			expect(h.toasts).toEqual(["WaveKit was updated"])
		},
	},
	{
		rule: "rate policy: raised and restored are receipts, not repeated within 60 s",
		run: () => {
			const h = loaded()
			h.policy.event(raised())
			expect(h.svc.receipt.get()?.text).toBe(
				"Sample rate raised to 2.4 MS/s for ADS-B (1090 MHz)",
			)
			h.svc.dismissReceipt()
			h.wait(30_000)
			h.policy.event(raised())
			expect(h.svc.receipt.get()).toBeNull()
			h.wait(61_000)
			h.policy.event(raised())
			expect(h.svc.receipt.get()).not.toBeNull()
			h.policy.event(raised({ action: "restored", toHz: 2_048_000 }))
			expect(h.svc.receipt.get()?.text).toBe("Sample rate back to 2.048 MS/s")
			expect(h.svc.shown.get()).toBeNull()
		},
	},
	{
		rule: "rate policy: a skipped raise is a condition for 5 min from its last event, cleared by a raise or restore",
		run: () => {
			const h = loaded()
			const key = "rate-policy-skip:rx" as const
			h.policy.event(raised({ action: "skipped", skipped: "external-control" }))
			expect(h.svc.conditions.get().get(key)?.text).toBe(
				"ADS-B needs 2.4 MS/s, but another client has the tuner",
			)
			expect(h.toasts).toHaveLength(1)
			h.wait(RATE_SKIP_TTL_MS - 1000)
			h.policy.event(raised({ action: "skipped", skipped: "external-control" }))
			expect(h.toasts).toHaveLength(1)
			h.wait(2 * RATE_SKIP_TTL_MS - 2000)
			expect(h.svc.conditions.get().has(key)).toBe(true)
			h.wait(2 * RATE_SKIP_TTL_MS)
			expect(h.svc.conditions.get().has(key)).toBe(false)
			h.policy.event(raised({ action: "skipped", skipped: "write-failed" }))
			expect(h.svc.conditions.get().get(key)?.text).toBe(
				"The receiver refused 2.4 MS/s for ADS-B",
			)
			h.policy.event(raised({ action: "restored", toHz: 2_048_000 }))
			expect(h.svc.conditions.get().has(key)).toBe(false)
			h.policy.event(raised({ action: "skipped", skipped: "rate-above" }))
			expect(h.svc.conditions.get().has(key)).toBe(false)
		},
	},
]

describe("notice policy", () => {
	it.each(RULES)("$rule", ({ run }) => run())
})

describe("watchReceiverNotices", () => {
	it("reads the first GET /api/resources and the socket's snapshots, and never toasts resources:alert", async () => {
		const svc = new NoticeService()
		const on = new Map<string, (d: unknown) => void>()
		const hooks: {
			any?: (m: { type: string; data: unknown }) => void
			state?: (s: string) => void
			reconnect?: () => void
		} = {}
		const events = {
			subscribe: () => () => undefined,
			on: (type: string, h: (d: unknown) => void) => {
				on.set(type, h)
				return () => on.delete(type)
			},
			onAny: (h: NonNullable<typeof hooks.any>) => {
				hooks.any = h
				return () => undefined
			},
			onState: (h: NonNullable<typeof hooks.state>) => {
				hooks.state = h
				return () => undefined
			},
			onReconnected: (h: NonNullable<typeof hooks.reconnect>) => {
				hooks.reconnect = h
				return () => undefined
			},
		} as unknown as Parameters<typeof watchReceiverNotices>[0]
		const get = vi.fn(async () => ({
			timestamp: iso(0),
			linkAdvisories: [drop(-20_000, -20_000)],
		}))
		const off = watchReceiverNotices(events, {
			api: { get } as never,
			tunerOf: () => undefined,
			service: svc,
		})
		expect(on.has("resources:alert")).toBe(false)
		hooks.state?.("open")
		await vi.advanceTimersByTimeAsync(0)
		expect(get).toHaveBeenCalledWith("/api/resources")
		// the page load's first snapshot: status place only
		expect(svc.conditions.get().get("link:rx")?.text).toBe(LINK_LOSS_TEXT)
		for (let t = 2000; t <= 20_000; t += 2000) {
			vi.advanceTimersByTime(2000)
			hooks.any?.({
				type: "resources:snapshot",
				data: { timestamp: iso(t), linkAdvisories: [drop(-20_000, -20_000)] },
			})
		}
		expect(svc.shown.get()).toBeNull()
		hooks.state?.("closed")
		expect(svc.conditions.get().get("link:rx")?.stale).toBe(true)
		hooks.reconnect?.()
		await vi.advanceTimersByTimeAsync(0)
		expect(get).toHaveBeenCalledTimes(2)
		off()
	})
})

describe("notice region place", () => {
	it("sits 8 px under the top row and stacks under a top-centre box in its column", () => {
		expect(regionTop(72, [], 720, 560)).toBe(80)
		// the connection chip under the top row
		const chip = { top: 88, bottom: 132, left: 600, right: 840 }
		expect(regionTop(72, [chip], 720, 560)).toBe(140)
		// in the top-row gap (above the region's top) or beside its column: no effect
		expect(
			regionTop(72, [{ top: 16, bottom: 60, left: 600, right: 840 }], 720, 560),
		).toBe(80)
		expect(
			regionTop(72, [{ ...chip, left: 1100, right: 1300 }], 720, 560),
		).toBe(80)
		// two stacked participants
		expect(
			regionTop(
				72,
				[chip, { top: 140, bottom: 170, left: 680, right: 760 }],
				720,
				560,
			),
		).toBe(178)
	})

	it("keeps the tuned card off its top-centre anchor while the region shows something", () => {
		const free = shellLayout(DEFAULT_GEOMETRY, null, null, { at: "tc" })
		expect(free.cardAnchor).toBe("tc")
		const taken = shellLayout(DEFAULT_GEOMETRY, null, null, {
			at: "tc",
			noticeTop: true,
		})
		expect(taken.cardAnchor).not.toBe("tc")
		expect(taken.anchors.some(a => a.id === "tc")).toBe(false)
	})
})
