import { sparkBuckets } from "../data/rates.js"
import type { AppState, DecoderOp } from "../data/types.js"
import { rowSourceId, windowFor } from "../data/window.js"
import {
	formatAge,
	formatBytes,
	formatClock,
	formatClockShort,
	formatCount,
	formatDuration,
	formatEventRate,
	formatPercent,
	formatWindow,
} from "../ui/format.js"
import { listBudget, type DetailPlacement } from "../ui/frame.js"
import { sp, type Line } from "../ui/line.js"
import { lineText, sanitize, truncate } from "../ui/text.js"
import { glyphs } from "../ui/theme.js"
import type { ConfirmRequest, UiState } from "../ui/ui-state.js"
import {
	DECODERS_COLUMNS,
	decoderCells,
	decoderFacts,
	decoderTable,
	decodersPlaceholder,
	type DecoderFacts,
} from "./decoder-rows.js"
import { sparkline, wrapKV } from "./detail.js"

export const RESULT_MS = 10_000
/** Server error text in a result or error row is cut here; the detail row wraps the rest of the line. */
const SERVER_TEXT_MAX = 120

const PROTOCOL: Readonly<Record<string, string>> = {
	readsb: "ADS-B",
	"ais-catcher": "AIS",
	acarsdec: "ACARS",
	dumpvdl2: "VDL2",
	direwolf: "APRS",
	rtl433: "ISM 433",
	"lora-meshtastic": "Meshtastic",
	"dsd-fme": "DMR/P25",
	"multimon-ng": "POCSAG/FLEX",
}
const PATTERN = {
	pure_consumer: "pure consumer",
	network_producer: "network producer",
	external_sdr: "external SDR",
} as const
const INPUT = {
	iq: "IQ in",
	audio_pcm: "audio in",
	external: "own SDR",
} as const
const OUTPUT = {
	jsonl: "JSON lines out",
	text: "text out",
	nmea: "NMEA out",
	beast: "Beast out",
} as const
const PAST: Readonly<Record<DecoderOp, string>> = {
	start: "started",
	stop: "stopped",
	restart: "restarted",
}

/** Sub-10 s server-relative durations in tenths, floored like the ages ("0.2s", assumption 18). */
const secs = (ms: number): string =>
	ms < 10_000
		? `${(Math.floor(Math.max(0, ms) / 100) / 10).toFixed(1)}s`
		: formatAge(ms)

const quoted = (text: string): string =>
	`"${truncate(sanitize(text), SERVER_TEXT_MAX)}"`

/** The minimal process words (`up 51s`, `restarting`); counts are listed beside them. */
const processText = (f: DecoderFacts, now: number): string =>
	lineText(decoderCells(f, now)["process"]?.variants[0] ?? [])

/**
 * Result line for the last decoder write (spec §6.2), CLI-owned copy only (R29):
 * `restart sent 18:07:52`, `· no reply in 10s` when the reply timed out (R23),
 * `restarted 18:07:53` once core confirms, `restart failed · 502 · "<server text>"`.
 * A finished result clears after 10 s.
 */
export function decoderActionText(
	state: AppState,
	id: string,
	now: number,
): string | null {
	const rec = state.actions.byKey[`decoder:${id}`]
	if (!rec || rec.intent.kind !== "decoder") return null
	const sep = ` ${glyphs().sep} `
	const op = rec.intent.op
	const sent = `${op} sent ${formatClock(rec.sentAt)}`
	if (rec.state === "sent") {
		const noReply = rec.outcomes.some(o => o.result?.outcome === "unknown")
		return noReply ? `${sent}${sep}no reply in 10s` : sent
	}
	if (now - Math.max(rec.doneAt ?? 0, rec.confirmedAt ?? 0) > RESULT_MS)
		return null
	if (rec.state === "failed") {
		const r =
			rec.outcomes.find(o => o.result?.outcome === "failed")?.result ??
			rec.outcomes[0]?.result
		const status = r?.status ?? r?.code ?? "network"
		return `${op} failed${sep}${status}${sep}${quoted(r?.message ?? "?")}`
	}
	return rec.confirmedAt !== null
		? `${PAST[op]} ${formatClock(rec.confirmedAt)}`
		: sent
}

function errorText(
	state: AppState,
	f: DecoderFacts,
	now: number,
): string | null {
	const sep = ` ${glyphs().sep} `
	const core = f.row.lastError
	if (core) {
		const at = Date.parse(core.at)
		const age = Number.isFinite(at) ? `${formatAge(now - at)} ago` : "?"
		return `${core.kind}${sep}${quoted(core.message)}${sep}${age}`
	}
	const ws = state.session[f.row.id]?.lastError
	return ws ? `${quoted(ws.message)}${sep}${formatAge(now - ws.at)} ago` : null
}

export function decoderDetail(
	state: AppState,
	f: DecoderFacts,
	width: number,
	now: number,
): Line[] {
	const g = glyphs()
	const sep = ` ${g.sep} `
	const r = f.row
	const sess = state.session[r.id]
	const caps = r.caps
	const identity = [
		PROTOCOL[r.type] ?? sanitize(r.type),
		...(caps
			? [
					PATTERN[caps.integrationPattern],
					`${INPUT[caps.input]}, ${OUTPUT[caps.output]}`,
				]
			: []),
		`pid ${r.pid ?? g.na}`,
		`version ${r.version !== undefined ? sanitize(r.version) : g.na}`,
	].join(sep)
	const lines: Line[] = [...wrapKV(sanitize(r.id), identity, width, true)]
	const result = decoderActionText(state, r.id, now)
	if (result) lines.push(...wrapKV("action", result, width))
	const prev = sess?.previousHealth
	lines.push(
		...wrapKV(
			"process",
			`${processText(f, now)}${sep}${formatCount(r.restartCount)} restarts${sep}${formatCount(r.stats.errors)} errors${sep}server health ${r.health}${prev ? ` (was ${prev})` : ""}`,
			width,
		),
	)
	const events = `${formatCount(r.stats.eventsOut)} events`
	const lastOut = f.lastAt === null ? g.na : `${formatAge(now - f.lastAt)} ago`
	const d = f.decodes
	const head =
		d.kind === "none"
			? `none since start (${formatDuration(d.uptimeSec)})`
			: d.kind === "rate"
				? formatEventRate(d.perSec)
				: d.kind === "total"
					? `${formatCount(d.count)} total`
					: d.kind === "last"
						? `last ${lastOut}`
						: g.na
	lines.push(
		...wrapKV(
			"decodes",
			`${head}${sep}${events}${sep}last output ${lastOut}`,
			width,
		),
	)
	const b = f.branch
	const snapT = Date.parse(state.fanout.value?.timestamp ?? "")
	/** Server-time delta to the snapshot, so local clock skew cannot affect it. */
	const since = (iso: string | null | undefined): string => {
		const t = iso ? Date.parse(iso) : Number.NaN
		return Number.isFinite(t) && Number.isFinite(snapT) ? secs(snapT - t) : "?"
	}
	if (b) {
		const bp = f.backpressure
			? `in backpressure ${since(b.backpressureSince)}`
			: "no backpressure now"
		lines.push(
			...wrapKV(
				"IQ",
				`${formatBytes(r.stats.bytesIn)} in${sep}branch ${sanitize(b.id)}${sep}buffer ${formatBytes(b.bufferBytes)}, high-water ${formatBytes(b.highWaterMark)}${sep}${bp}, ${formatCount(b.backpressureEnterCount)}× total`,
				width,
			),
		)
		const drain = b.lastDrainAt ? `${since(b.lastDrainAt)} ago` : g.na
		lines.push(
			...wrapKV(
				"drops",
				`${formatPercent(f.dropNow)} now${sep}${formatPercent(f.lifetime)} lifetime${sep}${formatBytes(b.droppedBytesTotal)} in ${formatCount(b.droppedChunksTotal)} chunks${sep}last drain ${drain}`,
				width,
			),
		)
	} else {
		lines.push(
			...wrapKV(
				"IQ",
				`${formatBytes(r.stats.bytesIn)} in${sep}no fanout branch`,
				width,
			),
		)
	}
	const sid = rowSourceId(r, state.sources.value)
	const win = sid
		? windowFor(sid, state.tuner.value, state.sources.value, state.relay.value)
		: null
	const member = {
		in: "in window",
		out: "out of window",
		"?": "window ?",
		"—": "own SDR, not on the shared window",
	}[f.membership]
	const band =
		f.nominal === "tuned"
			? "tuned (follows the receiver)"
			: f.nominal === "?"
				? "band ?"
				: `${f.nominal} MHz ${f.bandOrigin ?? "nominal"}`
	const parts = [
		band,
		...(f.bandNote ? [f.bandNote] : []),
		`window ${win ? formatWindow(win.loHz, win.hiHz) : "?"}`,
		member,
	]
	lines.push(...wrapKV("band", parts.join(sep), width))
	const buckets = sparkBuckets(sess?.spark ?? {}, now)
	const observed = buckets.filter(x => x !== undefined).length
	const from = sess?.firstObservedAt ?? now
	lines.push([
		sp("activity  ", "label"),
		sp(sparkline(buckets), "value"),
		sp(
			`  decodes/min since ${formatClockShort(from)} (${observed} of 30 min observed)`,
			"label",
		),
	])
	const err = errorText(state, f, now)
	if (err) lines.push(...wrapKV("error", err, width))
	return lines
}

export function decoderConfirm(
	state: AppState,
	id: string,
	op: DecoderOp,
): ConfirmRequest | null {
	const f = decoderFacts(state).find(x => x.row.id === id)
	if (!f) return null
	const sep = ` ${glyphs().sep} `
	return {
		kind: "decoder",
		prompt: `${op} ${sanitize(id)}${sep}${processText(f, state.now)}${sep}pid ${f.row.pid ?? glyphs().na}`,
		yes: op,
		no: "cancel",
		intent: { kind: "decoder", op, decoderId: id },
	}
}

export interface DecodersModel {
	list: Line[]
	detail: Line[] | null
	placement: DetailPlacement
	listWidth: number
	detailWidth: number
	rowIds: string[]
	pageSize: number
	selected: DecoderFacts | null
}

export function decodersModel(
	state: AppState,
	ui: UiState,
	width: number,
	height: number,
	roomy: boolean,
): DecodersModel {
	const facts = decoderFacts(state)
	const selected = facts.find(f => f.row.id === ui.selected.decoders) ?? null
	const open = ui.detail.decoders.open && selected !== null
	const b = listBudget(width + 1, height, roomy, 1, open)
	const listWidth =
		open && b.placement.kind === "right" ? width - b.placement.width - 2 : width
	const detailWidth = b.placement.kind === "right" ? b.placement.width : width
	const table = decoderTable(
		facts,
		DECODERS_COLUMNS,
		listWidth,
		b.listRows,
		selected?.row.id ?? null,
		state.now,
	)
	const placeholder = decodersPlaceholder(state)
	const list =
		open && b.placement.kind === "overlay"
			? []
			: placeholder
				? [table.header, placeholder]
				: [table.header, ...table.rows]
	const detail =
		open && selected
			? decoderDetail(state, selected, detailWidth, state.now).slice(
					ui.detail.decoders.scroll,
					ui.detail.decoders.scroll + b.detailRows,
				)
			: null
	return {
		list,
		detail,
		placement: b.placement,
		listWidth,
		detailWidth,
		rowIds: facts.map(f => f.row.id),
		pageSize: Math.max(1, b.listRows),
		selected,
	}
}
