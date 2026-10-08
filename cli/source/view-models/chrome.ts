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

export function stripInput(state: AppState): StripInput {
	const now = state.now
	const rows = state.decoders.value
	let decoders: StripInput["decoders"] = null
	if (rows !== undefined) {
		let up = 0
		let failing = 0
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
			inWindow: known > 0 ? inWindow : null,
		}
	}
	const agg = isFresh(state.fanout, now)
		? aggregateDropNow(state.fanoutHistory)
		: null
	const tuner = state.tuner.value?.[0]
	const src = state.sources.value?.[0]
	const centre =
		tuner?.frequency ?? src?.caps.centerFreq ?? state.relay.value?.lastFrequency
	const rate = tuner?.sampleRate ?? src?.caps.sampleRate
	return {
		api: apiView(state.conn, now),
		iq: iqSummary(state.sources, state.metrics, now),
		decoders,
		drops: {
			ratio: agg?.ratio ?? null,
			backpressure: (agg?.backpressure ?? 0) > 0,
		},
		rx:
			centre === undefined
				? null
				: {
						centreHz: centre,
						halfSpanHz: rate === undefined ? null : rate / 2,
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
			rx: isOld(state.tuner, now) && isOld(state.sources, now),
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
