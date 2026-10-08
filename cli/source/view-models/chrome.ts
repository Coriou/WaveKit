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
import { decoderMembership } from "../data/window.js"
import { VIEW_ORDER, VIEW_TITLES, type ViewId } from "../ui/actions.js"
import type { BannerCondition } from "../ui/banner.js"
import { fitGroups } from "../ui/fit.js"
import { footerGroups, type KeyContext } from "../ui/keymap.js"
import { sp, type Line } from "../ui/line.js"
import type { StripInput } from "../ui/strip.js"
import { cellWidth, lineWidth, truncate, truncateLine } from "../ui/text.js"
import { glyphs } from "../ui/theme.js"
import type { ConfirmRequest, UiState } from "../ui/ui-state.js"

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
	return {
		centre: pick([
			[tuner?.frequency, "tuner"],
			[src?.caps.centerFreq, "sources"],
			[relayFreq, "relay"],
		]),
		rate: pick([
			[tuner?.sampleRate, "tuner"],
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
		let inWindow = 0
		let known = 0
		for (const d of rows) {
			const p = processState(
				d,
				restartIncrements(state.session[d.id]?.restarts ?? [], now),
				state.actions.stoppedByCli.includes(d.id),
			)
			if (p === "up" || p === "starting") up++
			if (isFailing(p)) failing++
			if (p === "restarting") restarting++
			const m = decoderMembership(
				d,
				state.sources.value,
				state.tuner.value,
				state.relay.value,
			)
			if (m === "in") inWindow++
			if (m === "in" || m === "out") known++
		}
		decoders = {
			up,
			total: rows.length,
			failing,
			restarting,
			inWindow: known > 0 ? inWindow : null,
		}
	}
	const agg = isFresh(state.fanout, now)
		? aggregateDropNow(state.fanoutHistory)
		: null
	const tuner = state.tuner.value?.[0]
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

export function footerWithNotice(
	ctx: KeyContext,
	notice: UiState["notice"],
	now: number,
	width: number,
): Line {
	const groups = footerGroups(ctx)
	if (notice && now - notice.at < NOTICE_MS)
		groups.unshift({ priority: 0, variants: [[sp(notice.text, "attention")]] })
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
	const prompt = c.extra ? `${c.prompt} ${glyphs().sep} ${c.extra}` : c.prompt
	const room = width - lineWidth(hints) - cellWidth(head) - 3
	return truncateLine(
		[
			sp(head, "edit"),
			sp(truncate(prompt, Math.max(1, room)), "value", true),
			sp("   ", "label"),
			...hints,
		],
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
