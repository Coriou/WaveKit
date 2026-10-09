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
import { fitGroups } from "../ui/fit.js"
import { sp, type Line } from "../ui/line.js"
import { lineText, padEnd, sanitize, truncate } from "../ui/text.js"
import { glyphs } from "../ui/theme.js"
import type { ConfirmRequest, UiState } from "../ui/ui-state.js"
import {
	decoderCells,
	decoderFacts,
	decoderTable,
	decodersPlaceholder,
	type DecoderFacts,
} from "./decoder-rows.js"
import { LABEL_WIDTH, sparkline, wrapKV } from "./detail.js"

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

/** Own-key lookup for server-chosen keys (R65 M2): "constructor" must not hit the prototype. */
function own<T>(
	table: Readonly<Record<string, T>>,
	key: string,
): T | undefined {
	return Object.hasOwn(table, key) ? table[key] : undefined
}

/** Sub-10 s server-relative durations in tenths, floored like the ages ("0.2s", assumption 18). */
const secs = (ms: number): string =>
	ms < 10_000
		? `${(Math.floor(Math.max(0, ms) / 100) / 10).toFixed(1)}s`
		: formatAge(ms)

const quoted = (text: string): string =>
	`"${truncate(sanitize(text), SERVER_TEXT_MAX)}"`

/** R70: core's rate reason codes in plain words; an unknown code is shown quoted. */
const SUSPENSION_REASON: Readonly<Record<string, string>> = {
	"insufficient-sample-rate": "sample rate too low",
	"unsupported-sample-rate": "sample rate not supported",
	"unsupported-input-kind": "input kind not supported",
	"unsupported-input-format": "input format not supported",
	"unsupported-frontend-rate": "front-end rate not supported",
	"unsupported-decoder-input-rate": "decoder input rate not supported",
	"unknown-requirements": "rate requirements not declared",
	"source-rate-unknown": "source rate not known",
	"adaptation-unknown": "rate adaptation not known",
	"external-input": "external input",
}

function suspensionReason(code: string): string {
	return Object.hasOwn(SUSPENSION_REASON, code)
		? (SUSPENSION_REASON[code] ?? quoted(code))
		: quoted(code)
}

/** The minimal process words (`up 51s`, `restarting`); counts are listed beside them. */
const processText = (f: DecoderFacts, now: number): string =>
	lineText(decoderCells(f, now)["process"]?.variants[0] ?? [])

/**
 * Result line for the last decoder write (spec §6.2), CLI-owned copy only (R29):
 * - sent, no reply yet: `restart sent 18:07:52`
 * - reply timed out, waiting for an event (R23): `restart sent 18:07:52 · no reply in 10s`
 * - nothing reconciled it (R47 M5): `restart sent 18:07:52 · no reply · not confirmed`
 * - confirmed by core: `restarted 18:07:53`
 * - failed: `restart failed · 502 · "<server text>"`
 * A finished result clears after 10 s.
 */
export function decoderActionText(
	state: AppState,
	id: string,
	now: number,
): string | null {
	const rec = state.actions.byKey[`decoder:${id}`]
	if (!rec || rec.intent.kind !== "decoder") return null
	const g = glyphs()
	const sep = ` ${g.sep} `
	const op = rec.intent.op
	const sent = `${op} sent ${formatClock(rec.sentAt)}`
	switch (rec.state) {
		case "sent":
			return sent
		case "unknown":
			return `${sent}${sep}no reply in 10s`
		default:
			break
	}
	if (now - Math.max(rec.doneAt ?? 0, rec.confirmedAt ?? 0) > RESULT_MS)
		return null
	switch (rec.state) {
		case "no-reply":
			return `${sent}${sep}no reply${sep}not confirmed`
		case "failed": {
			const r =
				rec.outcomes.find(o => o.result?.outcome === "failed")?.result ??
				rec.outcomes[0]?.result
			const status = r?.status ?? r?.code ?? "network"
			// R65 M4: no server text is an unquoted ?, never an empty quote.
			const text = r?.message ? quoted(r.message) : g.unknown
			return `${op} failed${sep}${status}${sep}${text}`
		}
		case "ok": {
			if (rec.confirmedAt !== null)
				return `${PAST[op]} ${formatClock(rec.confirmedAt)}`
			// R65 M6: accepted by core (2xx) but no reconciling event yet; distinct from in flight.
			const status = rec.outcomes.find(o => o.result !== null)?.result?.status
			const accepted = `${op} accepted ${formatClock(rec.resultAt ?? rec.sentAt)}`
			return status !== undefined && status !== null
				? `${accepted}${sep}${status}`
				: accepted
		}
	}
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

/** Every span but the label gutter in the `old` role (stale lane, T6). */
function dimmed(lines: readonly Line[], old: boolean): Line[] {
	if (!old) return [...lines]
	return lines.map(l =>
		l.map((x, k) => (k === 0 ? x : { ...x, role: "old" as const })),
	)
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
		own(PROTOCOL, r.type) ?? sanitize(r.type),
		...(caps
			? [
					own(PATTERN, caps.integrationPattern) ?? g.unknown,
					`${own(INPUT, caps.input) ?? g.unknown}, ${own(OUTPUT, caps.output) ?? g.unknown}`,
				]
			: []),
		`pid ${r.pid ?? g.na}`,
		`version ${r.version !== undefined ? sanitize(r.version) : g.na}`,
	].join(sep)
	// R65 I5: the header shows the whole id, then two spaces.
	const rest: Line[] = [...wrapKV(sanitize(r.id), identity, width, true, true)]
	const result = decoderActionText(state, r.id, now)
	if (result) rest.push(...wrapKV("action", result, width))
	const prev = sess?.previousHealth
	// R70: an unrecognised health value is unknown (?), never echoed as a word.
	const health = (h: string): string => (h === "unknown" ? "?" : h)
	rest.push(
		...wrapKV(
			"process",
			`${processText(f, now)}${sep}${formatCount(r.restartCount)} restarts${sep}${formatCount(r.stats.errors)} errors${sep}server health ${health(r.health)}${prev ? ` (was ${health(prev)})` : ""}`,
			width,
		),
	)
	const susp = r.suspension
	if (r.suspended === true && susp) {
		const since = Date.parse(susp.since)
		rest.push(
			...wrapKV(
				"suspended",
				`since ${Number.isFinite(since) ? formatClock(since) : "?"}${sep}${suspensionReason(susp.reasonCode)}`,
				width,
			),
		)
	}
	const events = `${formatCount(r.stats.eventsOut)} events`
	const lastOut = f.lastAt === null ? g.na : `${formatAge(now - f.lastAt)} ago`
	const d = f.decodes
	// R65 M3: a last-decode-only fact is said once, as "last output".
	const head =
		d.kind === "none"
			? `none since start (${formatDuration(d.uptimeSec)})`
			: d.kind === "rate"
				? formatEventRate(d.perSec)
				: d.kind === "total"
					? `${formatCount(d.count)} total`
					: d.kind === "na"
						? g.na
						: null
	rest.push(
		...wrapKV(
			"decodes",
			[...(head !== null ? [head] : []), events, `last output ${lastOut}`].join(
				sep,
			),
			width,
		),
	)
	const fanout: Line[] = []
	const b = f.branch
	const snapT = Date.parse(state.fanout.value?.timestamp ?? "")
	/** Server-time delta to the snapshot, so local clock skew cannot affect it. */
	const since = (iso: string | null | undefined): string => {
		const t = iso ? Date.parse(iso) : Number.NaN
		return Number.isFinite(t) && Number.isFinite(snapT) ? secs(snapT - t) : "?"
	}
	if (b) {
		// R65 I2: without a fresh fanout sample, backpressure now is unknown, not absent.
		const bp = !f.fanoutFresh
			? `backpressure ${g.unknown}`
			: f.backpressure
				? `in backpressure ${since(b.backpressureSince)}`
				: "no backpressure now"
		fanout.push(
			...wrapKV(
				"IQ",
				`${formatBytes(r.stats.bytesIn)} in${sep}branch ${sanitize(b.id)}${sep}buffer ${formatBytes(b.bufferBytes)}, high-water ${formatBytes(b.highWaterMark)}${sep}${bp}, ${formatCount(b.backpressureEnterCount)}× total`,
				width,
			),
		)
		const drain = b.lastDrainAt ? `${since(b.lastDrainAt)} ago` : g.na
		// R8 / R65 I3: a decoder that is not running has no drop now.
		const now_ = r.running ? formatPercent(f.dropNow) : g.na
		fanout.push(
			...wrapKV(
				"drops",
				`${now_} now${sep}${formatPercent(f.lifetime)} lifetime${sep}${formatBytes(b.droppedBytesTotal)} in ${formatCount(b.droppedChunksTotal)} chunks${sep}last drain ${drain}`,
				width,
			),
		)
	} else {
		fanout.push(
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
	const windowRows = wrapKV("band", parts.join(sep), width)
	const buckets = sparkBuckets(sess?.spark ?? {}, now)
	const observed = buckets.filter(x => x !== undefined).length
	const from = sess?.firstObservedAt ?? now
	// Fitted, not left to Ink's truncation: the sparkline stays, the caption shortens.
	const caption = `decodes/min since ${formatClockShort(from)}`
	const activity = fitGroups(
		[
			{
				priority: 0,
				variants: [
					[
						sp(padEnd("activity", LABEL_WIDTH), "label"),
						sp(sparkline(buckets)),
					],
				],
			},
			{
				priority: 1,
				variants: [
					[sp("decodes/min", "label")],
					[sp(caption, "label")],
					[sp(`${caption} (${observed} of 30 min observed)`, "label")],
				],
			},
		],
		width,
	)
	const err = errorText(state, f, now)
	// R65 I2: each row dims with the lane it comes from.
	return [
		...dimmed(rest, f.oldRest),
		...dimmed(fanout, f.oldFanout),
		...dimmed(windowRows, f.oldWindow),
		activity,
		...dimmed(err ? wrapKV("error", err, width) : [], f.oldRest),
	]
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

/** The most recent decoder write that still has a result line, as `<id> · <text>` (R64). */
export function latestDecoderResult(state: AppState, now: number): Line | null {
	let best: { id: string; at: number; text: string } | null = null
	for (const rec of Object.values(state.actions.byKey)) {
		if (rec.intent.kind !== "decoder") continue
		const text = decoderActionText(state, rec.intent.decoderId, now)
		if (text === null || (best && best.at >= rec.sentAt)) continue
		best = { id: rec.intent.decoderId, at: rec.sentAt, text }
	}
	if (!best) return null
	const failed = best.text.includes(" failed ")
	return [
		sp(sanitize(best.id), "label"),
		sp(` ${glyphs().sep} `, "label"),
		sp(best.text, failed ? "fault" : "value"),
	]
}

/**
 * Detail rows from `scroll`, clamped so the last page stays full. Hidden rows
 * are announced in place of the first/last visible row: `+N rows · PgUp` and
 * `+N rows · PgDn` (R65 I4).
 */
function detailWindow(all: Line[], scroll: number, rows: number): Line[] {
	if (rows <= 0) return []
	if (all.length <= rows) return all
	const top = Math.min(Math.max(0, scroll), all.length - rows)
	const view = all.slice(top, top + rows)
	const sep = ` ${glyphs().sep} `
	const below = all.length - (top + rows)
	if (below > 0 && view.length > 1)
		view[view.length - 1] = [sp(`+${below + 1} rows${sep}PgDn`, "label")]
	if (top > 0 && view.length > 1)
		view[0] = [sp(`+${top + 1} rows${sep}PgUp`, "label")]
	return view
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
	// R64: with the detail closed, the last write's result stays visible under the list.
	const result = open ? null : latestDecoderResult(state, state.now)
	const table = decoderTable(
		facts,
		"decoders",
		listWidth,
		Math.max(1, b.listRows - (result ? 1 : 0)),
		selected?.row.id ?? null,
		state.now,
	)
	const placeholder = decodersPlaceholder(state)
	const list =
		open && b.placement.kind === "overlay"
			? []
			: [
					table.header,
					...(placeholder ? [placeholder] : table.rows),
					...(result ? [result] : []),
				]
	const detail =
		open && selected
			? detailWindow(
					decoderDetail(state, selected, detailWidth, state.now),
					ui.detail.decoders.scroll,
					b.detailRows,
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
