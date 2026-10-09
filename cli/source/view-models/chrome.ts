import { isFailing, processState } from "../data/decoder-state.js"
import { apiView, iqSummary, isFresh, isOld } from "../data/freshness.js"
import { aggregateDropNow, restartIncrements } from "../data/rates.js"
import {
	ENDPOINT_PATHS,
	POLL_ENDPOINTS,
	type AppState,
	type Endpoint,
	type LaneError,
} from "../data/types.js"
import { decoderMembership, type Membership } from "../data/window.js"
import { decoderBand } from "../data/nominal-bands.js"
import { VIEW_ORDER, VIEW_TITLES, type ViewId } from "../ui/actions.js"
import type { BannerCondition } from "../ui/banner.js"
import { fitGroups } from "../ui/fit.js"
import { footerGroups, type KeyContext } from "../ui/keymap.js"
import { sp, type Line } from "../ui/line.js"
import type { StripInput } from "../ui/strip.js"
import { cellWidth, lineWidth, truncate, truncateLine } from "../ui/text.js"
import { glyphs } from "../ui/theme.js"
import type { ConfirmRequest, UiState } from "../ui/ui-state.js"
import { receiverTuner } from "./receiver.js"

export interface WindowItem {
	membership: Membership
	/** Tuned types follow the centre, so they say nothing about whether the window is known. */
	tuned: boolean
}

/**
 * "N in window" (strip) and "N of M decoders in window" (Overview) share one rule (I4,
 * I-C): only when every non-tuned decoder's membership is known; decoders with no
 * window (—) are not counted. Null otherwise.
 */
export function windowCount(
	items: readonly WindowItem[],
): { inWindow: number; counted: number } | null {
	const counted = items.filter(i => i.membership !== "—")
	const others = counted.filter(i => !i.tuned)
	if (
		others.length === 0 ||
		!others.every(i => i.membership === "in" || i.membership === "out")
	)
		return null
	return {
		inWindow: counted.filter(i => i.membership === "in").length,
		counted: counted.length,
	}
}

export type RxLane = "tuner" | "sources" | "relay"
export interface RxValue {
	v: number
	lane: RxLane
	/** The lane it came from is older than the TTL. */
	old: boolean
}

/**
 * Centre and sample rate for one source, each the first positive value (windowFor's
 * rule, R44) and kept apart, so a known centre still shows when the rate is unknown
 * (R53). Centre: tuner → source caps → relay; rate: tuner → source caps.
 */
export function rxValues(
	state: AppState,
	sourceId: string | undefined,
): { centre: RxValue | null; rate: RxValue | null } {
	if (sourceId === undefined) return { centre: null, rate: null }
	const now = state.now
	const tuner = state.tuner.value?.find(t => t.sourceId === sourceId)
	const src = state.sources.value?.find(x => x.id === sourceId)
	const relay = state.relay.value
	const relayFreq =
		relay && (relay.sourceId === undefined || relay.sourceId === sourceId)
			? relay.lastFrequency
			: undefined
	const old: Readonly<Record<RxLane, boolean>> = {
		tuner: isOld(state.tuner, now),
		sources: isOld(state.sources, now),
		relay: isOld(state.relay, now),
	}
	const pick = (
		cands: ReadonlyArray<readonly [number | undefined, RxLane]>,
	): RxValue | null => {
		for (const [v, lane] of cands)
			if (v !== undefined && Number.isFinite(v) && v > 0)
				return { v, lane, old: old[lane] }
		return null
	}
	// A field the tuner lists in unknownFields is a placeholder (R86): fall through.
	const unknown = new Set<string>(tuner?.unknownFields ?? [])
	return {
		centre: pick([
			[unknown.has("frequency") ? undefined : tuner?.frequency, "tuner"],
			[src?.caps.centerFreq, "sources"],
			[relayFreq, "relay"],
		]),
		rate: pick([
			[unknown.has("sampleRate") ? undefined : tuner?.sampleRate, "tuner"],
			[src?.caps.sampleRate, "sources"],
		]),
	}
}

export function stripInput(state: AppState): StripInput {
	const now = state.now
	const rows = state.decoders.value
	let decoders: StripInput["decoders"] = null
	if (rows !== undefined) {
		let up = 0
		let failing = 0
		let restarting = 0
		const memberships: WindowItem[] = []
		for (const d of rows) {
			const p = processState(
				d,
				restartIncrements(state.session[d.id]?.restarts ?? [], now),
				state.actions.stoppedByCli.includes(d.id),
				now,
				state.session[d.id]?.suspendingSince,
			)
			if (p === "up" || p === "starting") up++
			// R77: failing counts faults and anything still failing to settle.
			if (isFailing(p) || p === "faulted-retrying" || p === "suspend-pending")
				failing++
			if (p === "restarting") restarting++
			memberships.push({
				membership: decoderMembership(
					d,
					state.sources.value,
					state.tuner.value,
					state.relay.value,
				),
				tuned: decoderBand(d)?.band.kind === "tuned",
			})
		}
		const win = windowCount(memberships)
		decoders = {
			up,
			total: rows.length,
			failing,
			restarting,
			inWindow: win?.inWindow ?? null,
		}
	}
	const agg = isFresh(state.fanout, now)
		? aggregateDropNow(state.fanoutHistory)
		: null
	// The same tuner the Receiver shows: the one for the rendered source (R72 item 5).
	const tuner = receiverTuner(state)
	const sourceId = tuner?.sourceId ?? state.sources.value?.[0]?.id
	const { centre, rate } = rxValues(state, sourceId)
	// Item 8: rx dims when the lane of its centre or of its rate is old.
	const rxOld = centre !== null && (centre.old || rate?.old === true)
	return {
		api: apiView(state.conn, now),
		iq: iqSummary(state.sources, state.metrics, now),
		decoders,
		drops: {
			ratio: agg?.ratio ?? null,
			backpressure: (agg?.backpressure ?? 0) > 0,
		},
		rx:
			centre === null
				? null
				: {
						centreHz: centre.v,
						halfSpanHz: rate === null ? null : rate.v / 2,
						control: tuner
							? tuner.controlMode === "external"
								? "external"
								: "internal"
							: null,
					},
		clockMs: now,
		old: {
			iq: false,
			decoders: isOld(state.decoders, now),
			rx: rxOld,
		},
	}
}

function laneError(state: AppState, e: Endpoint): LaneError | undefined {
	switch (e) {
		case "decoders":
			return state.decoders.error
		case "sources":
			return state.sources.error
		case "tuner":
			return state.tuner.error
		case "relay":
			return state.relay.error
		case "fanout":
			return state.fanout.error
		case "resources":
			return state.resources.error
		case "audio":
			return state.audio.error
		case "status":
			return state.status.error
		case "presets":
			return state.presets.error
		case "aircraft":
			return state.aircraft.stats.error
	}
}

const reason = (err: LaneError | null | undefined): string =>
	!err ? "?" : err.kind === "http" ? String(err.status ?? "http") : err.message

/** Spec §9: one banner row; bannerLine shows the highest-priority condition plus · +N. */
export function bannerConditions(state: AppState): BannerCondition[] {
	const c = state.conn
	const allFailing =
		c.rest.failing.length > 0 &&
		POLL_ENDPOINTS.every(e => c.rest.failing.includes(e))
	if (allFailing && c.ws.state !== "open") {
		return [
			{
				kind: "api-down",
				reason: reason(c.rest.lastError),
				retryAt: c.rest.nextAt,
				asOf: c.rest.lastOkAt,
				target: c.target.base,
				tried: c.discovery.mode === "failed" ? c.discovery.tried : [],
			},
		]
	}
	const out: BannerCondition[] = []
	if (allFailing)
		out.push({
			kind: "rest-down",
			reason: reason(c.rest.lastError),
			retryAt: c.rest.nextAt,
			asOf: c.rest.lastOkAt,
		})
	if (c.ws.state === "closed")
		out.push({ kind: "ws-down", code: c.ws.code, retryAt: c.ws.nextRetryAt })
	if (!allFailing) {
		for (const e of c.rest.failing)
			out.push({
				kind: "endpoint",
				path: ENDPOINT_PATHS[e],
				reason: reason(laneError(state, e)),
			})
	}
	return out
}

export const NOTICE_MS = 5000
/** S5: the external-control notice repeats a footer hint, so it gives the footer back sooner. */
export const CONTROL_NOTICE_MS = 3000

/** Whether a key notice is still on screen at `now`. */
export function noticeShown(notice: UiState["notice"], now: number): boolean {
	return notice !== null && now - notice.at < (notice.ms ?? NOTICE_MS)
}

export function footerWithNotice(
	ctx: KeyContext,
	notice: UiState["notice"],
	now: number,
	width: number,
): Line {
	const shown = noticeShown(notice, now) ? notice : null
	const groups = footerGroups(ctx, shown?.text)
	if (shown)
		groups.unshift({ priority: 0, variants: [[sp(shown.text, "attention")]] })
	return fitGroups(groups, width)
}

/** ▶ prompt, cut so the y/n hints always fit (spec §6.2, §6.4, §6.5). */
export function confirmLine(c: ConfirmRequest, width: number): Line {
	const hints: Line = [
		sp("y", "value", true),
		sp(` ${c.yes}`, "label"),
		sp("  ", "label"),
		sp("n", "value", true),
		sp(` ${c.no}`, "label"),
		...(c.kind === "preset"
			? [sp("  ", "label"), sp("P", "value", true), sp(" next", "label")]
			: []),
	]
	const head = `${glyphs().confirm} `
	const room = Math.max(1, width - lineWidth(hints) - cellWidth(head) - 3)
	// R71: groups fit by priority, so the action, a safety warning and who a change
	// moves stay visible before field details; y/n always fit.
	const body: Line = c.groups
		? fitGroups(c.groups, room, { sep: ` ${glyphs().sep} ` })
		: [
				sp(
					truncate(
						c.extra ? `${c.prompt} ${glyphs().sep} ${c.extra}` : c.prompt,
						room,
					),
					"value",
					true,
				),
			]
	return truncateLine(
		[sp(head, "edit"), ...body, sp("   ", "label"), ...hints],
		width,
	)
}

export function switcherLine(view: ViewId, width: number): Line {
	const out: Line = []
	VIEW_ORDER.forEach((v, i) => {
		if (i > 0) out.push(sp("  ", "label"))
		out.push(
			sp(`${i + 1} `, "label"),
			sp(VIEW_TITLES[v], v === view ? "selected" : "value", v === view),
		)
	})
	return truncateLine(out, width)
}
