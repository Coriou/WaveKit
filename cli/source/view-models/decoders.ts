import { sparkBuckets } from "../data/rates.js"
import { rangeLabel, type BandOrigin } from "../data/nominal-bands.js"
import { isRateReason, RATE_REASON_WORDS } from "../data/reason-codes.js"
import type { AppState, DecoderOp, DecoderRow } from "../data/types.js"
import { rowSourceId, windowFor } from "../data/window.js"
import {
	counted,
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
import { sp, type Line, type Role } from "../ui/line.js"
import { lineText, padEnd, sanitize, truncate } from "../ui/text.js"
import { glyphs } from "../ui/theme.js"
import type { ConfirmRequest, UiState } from "../ui/ui-state.js"
import {
	decoderFacts,
	decoderTable,
	decodersPlaceholder,
	titled,
	processWords,
	type DecoderFacts,
} from "./decoder-rows.js"
import { LABEL_WIDTH, sparkSpans, wrapKV } from "./detail.js"

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
	iq: "iq",
	audio_pcm: "audio",
	external: "own SDR",
} as const
const OUTPUT = {
	jsonl: "jsonl",
	text: "text",
	nmea: "nmea",
	beast: "beast",
} as const
/** The exit detail core appends to an exit message: "(code 1)", "(signal SIGKILL)", "(code 1, signal …)". */
const EXIT_DETAIL =
	/\s*\(((?:code -?\d+|signal [A-Z0-9]+)(?:, (?:code -?\d+|signal [A-Z0-9]+))?)\)$/
const PAST: Readonly<Record<DecoderOp, string>> = {
	start: "started",
	stop: "stopped",
	restart: "restarted",
	unpin: "returned to auto",
}
/** The op as result lines say it (`return to auto sent 18:07:52`, R100). */
const OP_WORD: Readonly<Record<DecoderOp, string>> = {
	start: "start",
	stop: "stop",
	restart: "restart",
	unpin: "return to auto",
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

/** R70 / R84: core's suspension reason codes in plain words; an unknown code is shown quoted. */
const SUSPENSION_REASON: Readonly<Record<string, string>> = {
	...RATE_REASON_WORDS,
	"frequency-out-of-band": "out of band",
}

/** R84: why core cannot place a decoder in or out of the window. */
const BAND_REASON: Readonly<Record<string, string>> = {
	"no-target-frequency": "no target frequency",
	"source-center-unknown": "source centre unknown",
	"external-input": "external input",
}

const words = (map: Readonly<Record<string, string>>, code: string): string =>
	Object.hasOwn(map, code) ? (map[code] ?? quoted(code)) : quoted(code)

const suspensionReason = (code: string): string =>
	words(SUSPENSION_REASON, code)

/** R84 / R100: the band's basis as the detail names it. */
const BAND_ORIGIN: Readonly<Record<BandOrigin, string>> = {
	configured: "configured",
	protocol: "protocol",
	"decoder-default": "decoder default",
	"region-default": "region default",
	override: "override",
	nominal: "nominal",
	core: "basis ?",
}

/** R100: which layer an override comes from. */
const OVERRIDE_SOURCE: Readonly<Record<string, string>> = {
	config: "config",
	api: "api",
}

/** R100: where the band plan region came from. */
const REGION_SOURCE: Readonly<Record<string, string>> = {
	configured: "configured",
	decoder: "from decoder",
	"guessed:tz": "guessed from TZ",
	"guessed:intl-timezone": "guessed from time zone",
	"guessed:locale-env": "guessed from locale",
	"guessed:intl-locale": "guessed from locale",
	default: "default",
}

function bandOriginWords(f: DecoderFacts): string {
	const core = f.row.bandAssessment
	const basis = core?.basis
	if (f.bandOrigin === "core" && basis !== undefined)
		return `basis ${quoted(basis)}`
	if (f.bandOrigin === "override") {
		const src = core?.overrideSource
		return `override${sepText()}${src === undefined ? glyphs().unknown : words(OVERRIDE_SOURCE, src)}`
	}
	return BAND_ORIGIN[f.bandOrigin ?? "nominal"]
}

const sepText = (): string => ` ${glyphs().sep} `

/**
 * R100: ` · pinned`, or ` · running out of band · pinned` when core's verdict is
 * out of band; a start mode this CLI does not know is quoted. Empty otherwise.
 */
function startModeText(f: DecoderFacts): string {
	const sep = sepText()
	const mode = f.row.startMode
	if (f.pinned)
		return f.row.bandAssessment?.verdict === "out-of-band"
			? `${sep}running out of band${sep}pinned`
			: `${sep}pinned`
	if (mode !== undefined && mode !== "auto" && mode !== "operator")
		return `${sep}start mode ${quoted(mode)}`
	return ""
}

/** R100: `region EU · guessed from TZ`, or null when core names no region. */
export function regionText(f: DecoderFacts): string | null {
	const region = f.row.bandAssessment?.region
	if (!region) return null
	const code = /^[A-Z]{2}$/.test(region.code)
		? region.code
		: quoted(region.code)
	return `region ${code}${sepText()}${words(REGION_SOURCE, region.source)}`
}

/**
 * The band's frequencies in full: core's targets (`1090.000 MHz`), its ranges
 * (`433.050–434.790, 868.000–870.000 MHz`, R100), or both; null when neither.
 */
function bandValues(f: DecoderFacts): string | null {
	const core = f.row.bandAssessment
	const ranges = core?.rangesHz
	const rangesText =
		ranges && ranges.length > 0
			? `${ranges.map(r => rangeLabel(r, glyphs().range)).join(", ")} MHz`
			: null
	const targetsText =
		f.nominal !== "tuned" && f.nominal !== "?" && core?.targetsHz !== undefined
			? `${f.nominal} MHz`
			: null
	if (targetsText && rangesText)
		return `${targetsText}${sepText()}range ${rangesText}`
	return targetsText ?? rangesText
}

/** R84: a band suspension resumes on a retune to core's band, when core names it. Not "waiting for": spec §9 bans it. */
function suspensionText(f: DecoderFacts, code: string): string {
	const values = bandValues(f)
	return code === "frequency-out-of-band" && values !== null
		? `resumes on retune to ${values}`
		: suspensionReason(code)
}

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
	const word = OP_WORD[op]
	const sent = `${word} sent ${formatClock(rec.sentAt)}`
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
			return `${word} failed${sep}${status}${sep}${text}`
		}
		case "ok": {
			if (rec.confirmedAt !== null)
				return `${PAST[op]} ${formatClock(rec.confirmedAt)}`
			// R65 M6: accepted by core (2xx) but no reconciling event yet; distinct from in flight.
			const status = rec.outcomes.find(o => o.result !== null)?.result?.status
			const accepted = `${word} accepted ${formatClock(rec.resultAt ?? rec.sentAt)}`
			return status !== undefined && status !== null
				? `${accepted}${sep}${status}`
				: accepted
		}
	}
}

/** S4: core's last error, short: `exit code 1 · 3m ago`, `spawn · 5s ago`. */
function exitText(core: DecoderRow["lastError"], now: number): string | null {
	if (!core) return null
	const at = Date.parse(core.at)
	const age = Number.isFinite(at) ? `${formatAge(now - at)} ago` : "?"
	const m = core.kind === "exit" ? EXIT_DETAIL.exec(core.message) : null
	const what = m?.[1] !== undefined ? `exit ${m[1]}` : sanitize(core.kind)
	return `${what} ${glyphs().sep} ${age}`
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
		// The exit code is the fact: "exit code 1 · \"Process exited unexpectedly\"".
		const m = core.kind === "exit" ? EXIT_DETAIL.exec(core.message) : null
		if (m?.[1] !== undefined)
			return `exit ${m[1]}${sep}${quoted(core.message.slice(0, m.index))}${sep}${age}`
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
	// S1: pid and version are shown when known; an absent one adds nothing.
	const identity = [
		own(PROTOCOL, r.type) ?? sanitize(r.type),
		...(caps
			? [
					own(PATTERN, caps.integrationPattern) ?? g.unknown,
					`${own(INPUT, caps.input) ?? g.unknown} ${g.arrow} ${own(OUTPUT, caps.output) ?? g.unknown}`,
				]
			: []),
		...(r.pid !== null && r.pid !== undefined ? [`pid ${r.pid}`] : []),
		...(r.version !== undefined ? [`version ${sanitize(r.version)}`] : []),
	].join(sep)
	// R65 I5: the header shows the whole id, then two spaces.
	const idRows = wrapKV(sanitize(r.id), identity, width, true, true)
	// N3: the CLI's own write result is not REST data, so it never dims with that lane.
	const result = decoderActionText(state, r.id, now)
	const role = decoderActionRole(state, r.id)
	const action = result
		? wrapKV("action", result, width).map(l =>
				l.map((x, k) => (k === 0 ? x : { ...x, role })),
			)
		: []
	const rest: Line[] = []
	const prev = sess?.previousHealth
	// R70: an unrecognised health value is unknown (?), never echoed as a word.
	// S2: a known one is core's word, quoted.
	const health = (h: string): string => (h === "unknown" ? "?" : quoted(h))
	rest.push(
		...wrapKV(
			"process",
			`${processWords(f)}${startModeText(f)}${sep}${counted(r.restartCount, "restart")}${sep}${counted(r.stats.errors, "error")}${sep}health ${health(r.health)}${prev ? ` (was ${health(prev)})` : ""}`,
			width,
		),
	)
	const susp = r.suspension
	if (r.suspended === true && susp) {
		const since = Date.parse(susp.since)
		rest.push(
			...wrapKV(
				"suspended",
				`since ${Number.isFinite(since) ? formatClock(since) : "?"}${sep}${suspensionText(f, susp.reasonCode)}`,
				width,
			),
		)
	}
	const d = f.decodes
	// S1 / M12: the rate (core's counter, else the feed's last minute) and the
	// last decode, each once; never decoded reads "none since start".
	const last =
		f.lastAt === null ? [] : [`last ${formatAge(now - f.lastAt)} ago`]
	const rate =
		d.kind === "rate"
			? formatEventRate(d.perSec)
			: f.feed60 > 0
				? `${formatCount(f.feed60)}/min`
				: null
	const decodes =
		d.kind === "none"
			? [`none since start (${formatDuration(d.uptimeSec)})`]
			: d.kind === "total"
				? [`${formatCount(d.count)} total`, ...last]
				: d.kind === "na"
					? last.length > 0
						? last
						: ["none"]
					: [...(rate !== null ? [rate] : []), ...last]
	rest.push(...wrapKV("decodes", decodes.join(sep), width))
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
				? `backpressure ${since(b.backpressureSince)}`
				: "no backpressure"
		fanout.push(
			...wrapKV(
				"iq",
				`${formatBytes(r.stats.bytesIn)} in${sep}branch ${sanitize(b.id)}${sep}buffer ${formatBytes(b.bufferBytes)} / ${formatBytes(b.highWaterMark)} hwm${sep}${bp}${sep}${counted(b.backpressureEnterCount, "episode")}`,
				width,
			),
		)
		const drain = b.lastDrainAt ? `${since(b.lastDrainAt)} ago` : g.na
		// R8 / R65 I3: a decoder that is not running has no drop now.
		const now_ = r.running ? formatPercent(f.dropNow) : g.na
		fanout.push(
			...wrapKV(
				"drops",
				`${now_} now${sep}${formatPercent(f.lifetime)} lifetime${sep}${formatBytes(b.droppedBytesTotal)} in ${counted(b.droppedChunksTotal, "chunk")}${sep}last drain ${drain}`,
				width,
			),
		)
	} else {
		fanout.push(
			...wrapKV(
				"iq",
				`${formatBytes(r.stats.bytesIn)} in${sep}no fanout branch`,
				width,
			),
		)
	}
	const sid = rowSourceId(r, state.sources.value)
	const win = sid
		? windowFor(sid, state.tuner.value, state.sources.value, state.relay.value)
		: null
	// R84: core's usable window (filter margin applied) when it sends one, else centre ± rate/2.
	const core = r.bandAssessment
	const centre = core?.captureCenterHz
	const halfWidth = core?.windowHalfWidthHz
	const windowPart =
		centre !== undefined && halfWidth !== undefined
			? `usable ${formatWindow(centre - halfWidth, centre + halfWidth)}`
			: `window ${win ? formatWindow(win.loHz, win.hiHz) : "?"}`
	const why =
		core?.verdict === "unknown" && core.reasonCode !== undefined
			? ` (${words(BAND_REASON, core.reasonCode)})`
			: ""
	const member = {
		in: "in window",
		out: "out of window",
		"?": `in window ?${why}`,
		"—": "own SDR, not on the shared window",
	}[f.membership]
	// R90: under core's assessment a tuned type is placed by core, not assumed to follow.
	const values = bandValues(f)
	const band =
		f.nominal === "tuned"
			? core
				? "tuned"
				: "tuned (follows the receiver)"
			: f.nominal === "?"
				? "band ?"
				: `${values ?? `${f.nominal} MHz`} (${bandOriginWords(f)})`
	const region = regionText(f)
	const parts = [
		band,
		...(region ? [region] : []),
		...(f.bandNote ? [f.bandNote] : []),
		windowPart,
		member,
	]
	const windowRows = wrapKV("band", parts.join(sep), width)
	const buckets = sparkBuckets(sess?.spark ?? {}, now)
	const from = sess?.firstObservedAt ?? now
	// Fitted, not left to Ink's truncation: the sparkline stays, the caption shortens.
	const caption = `decodes/min${sep}last 30 min`
	const activity = fitGroups(
		[
			{
				priority: 0,
				variants: [
					[
						sp(padEnd("activity", LABEL_WIDTH), "label"),
						...sparkSpans(buckets),
					],
				],
			},
			{
				priority: 1,
				variants: [
					[sp("decodes/min", "label")],
					[sp(caption, "label")],
					[
						sp(
							`${caption}${sep}observed since ${formatClockShort(from)}`,
							"label",
						),
					],
				],
			},
		],
		width,
	)
	const err = errorText(state, f, now)
	// R65 I2: each row dims with the lane it comes from.
	return [
		...dimmed(idRows, f.oldRest),
		...action,
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
	const now = state.now
	const sep = ` ${glyphs().sep} `
	// S4 (R59): the blast radius — whether it decodes the shared window, what it
	// drops or last decoded, or why it is down — rather than its pid.
	const window = {
		in: "in window",
		out: "out of window",
		"?": "window ?",
		"—": "own SDR",
	}[f.membership]
	const exit = f.row.running ? null : exitText(f.row.lastError, now)
	const name = sanitize(id)
	// R100: what the write does to band suspension, said before `y`.
	const runAnyway = op === "start" && bandSuspended(f)
	const head = runAnyway
		? `run ${name} out of band${sep}pinned`
		: op === "unpin"
			? `return ${name} to auto`
			: `${op} ${name}`
	// The run-anyway head already says why it is down.
	const parts: Array<[number, string]> = [
		[0, head],
		...(runAnyway ? [] : ([[2, processWords(f)]] as Array<[number, string]>)),
		[1, window],
	]
	if (op === "start" && !runAnyway && corePins(state))
		parts.splice(1, 0, [1, "pinned against band suspension"])
	if (op === "unpin" && f.row.bandAssessment?.verdict === "out-of-band")
		parts.splice(1, 0, [1, "may suspend out of band"])
	if (exit !== null) parts.push([1, exit])
	if (f.dropNow !== null && f.dropNow > 0)
		parts.push([2, `dropping ${formatPercent(f.dropNow)}`])
	if (f.lastAt !== null)
		parts.push([3, `decoded ${formatAge(now - f.lastAt)} ago`])
	return {
		kind: "decoder",
		prompt: parts.map(([, t]) => t).join(sep),
		groups: parts.map(([priority, t]) => ({
			priority,
			variants: [[sp(t, "value", true)]],
		})),
		yes: runAnyway ? "run" : op === "unpin" ? "return" : op,
		no: "cancel",
		intent: { kind: "decoder", op, decoderId: id },
	}
}

/** R100: suspended because the tuned band covers none of its targets; a start runs it anyway. */
export function bandSuspended(f: DecoderFacts): boolean {
	return (
		f.row.suspended === true &&
		f.row.suspension?.reasonCode === "frequency-out-of-band"
	)
}

/** R100: the keymap's view of a suspension: band (run anyway), rate (core ignores a start), other, or none. */
export function suspensionKind(
	f: DecoderFacts | null,
): "band" | "rate" | "other" | null {
	if (!f || f.row.suspended !== true) return null
	const code = f.row.suspension?.reasonCode
	if (code === "frequency-out-of-band") return "band"
	return code !== undefined && isRateReason(code) ? "rate" : "other"
}

/** R100: this core reports start modes, so a bare start pins (any decoder carries startMode). */
export function corePins(state: AppState): boolean {
	return (state.decoders.value ?? []).some(d => d.startMode !== undefined)
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
	/** The last write's result for the footer while the detail is closed (R64, R75), else null. */
	notice: string | null
	/** Last scroll offset that still moves the open detail; null while it is closed (final review). */
	detailMaxScroll: number | null
}

/** N5: the result line's role from the action state: failed is a fault, an unconfirmed no-reply needs attention. */
export function decoderActionRole(state: AppState, id: string): Role {
	const rec = state.actions.byKey[`decoder:${id}`]
	if (!rec) return "value"
	return rec.state === "failed"
		? "fault"
		: rec.state === "no-reply"
			? "attention"
			: "value"
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
	return [
		sp(sanitize(best.id), "label"),
		sp(` ${glyphs().sep} `, "label"),
		sp(best.text, decoderActionRole(state, best.id)),
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
	// R64/R75: with the detail closed, the last write's result goes to the footer.
	const result = open ? null : latestDecoderResult(state, state.now)
	const table = decoderTable(
		facts,
		open && b.placement.kind === "right" ? "decoders-pane" : "decoders",
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
				? [titled(table.header, placeholder)]
				: [table.header, ...table.rows]
	const all =
		open && selected
			? decoderDetail(state, selected, detailWidth, state.now)
			: null
	const detail = all
		? detailWindow(all, ui.detail.decoders.scroll, b.detailRows)
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
		notice: result ? lineText(result) : null,
		// detailWindow clamps the same way, so over-scrolling cannot stall PgUp.
		detailMaxScroll: all ? Math.max(0, all.length - b.detailRows) : null,
	}
}
