import type { TunerRelayStatus, TunerState } from "@wavekit/api-types"
import { iqView, isFresh, isOld } from "../data/freshness.js"
import { decoderBand } from "../data/nominal-bands.js"
import { aggregateDropNow, MIN_DROP_SPAN_MS } from "../data/rates.js"
import type { AppState, SourceRow } from "../data/types.js"
import {
	decoderMembership,
	retuneCandidates,
	retuneImpact,
	windowFor,
	type RetuneImpact,
	type TunedWindow,
} from "../data/window.js"
import { fitGroups } from "../ui/fit.js"
import {
	formatAge,
	formatBytes,
	formatClock,
	formatDb,
	formatDeltaHz,
	formatHz,
	formatMSps,
	formatPercent,
	formatRate,
	formatSampleAge,
	formatSps,
	formatSpaced,
	formatWindow,
} from "../ui/format.js"
import { sp, type Group, type Line, type Role } from "../ui/line.js"
import { glyphSpan } from "../ui/strip.js"
import {
	padEnd,
	padStart,
	sanitize,
	truncate,
	truncateLine,
} from "../ui/text.js"
import { glyphs } from "../ui/theme.js"
import {
	FREQ_MAX,
	FREQ_MIN,
	editWindow,
	outOfRange,
	pendingChanges,
	pendingCommands,
	turnsBiasTeeOn,
	type PendingChange,
} from "../ui/tuner-edit.js"
import type {
	ConfirmRequest,
	EditField,
	TunerEditState,
	UiState,
} from "../ui/ui-state.js"

const RESULT_MS = 10_000
const LABEL_W = 10
/** rtl_tcp header tuner types (librtlsdr enum rtlsdr_tuner). */
const TUNER_TYPES: Readonly<Record<number, string>> = {
	1: "E4000",
	2: "FC0012",
	3: "FC0013",
	4: "FC2580",
	5: "R820T",
	6: "R828D",
}
const sep = (): string => ` ${glyphs().sep} `
const lbl = (t: string, bold = false): Line => [
	sp(padEnd(t, LABEL_W), "label", bold),
]
const one = (priority: number, ...variants: Line[]): Group => ({
	priority,
	variants,
})
const txt = (t: string, role: Role = "value"): Line => [sp(t, role)]
const onOff = (b: boolean): string => (b ? "on" : "off")
const own = <T>(
	rec: Readonly<Record<string, T>>,
	key: string,
): T | undefined =>
	Object.prototype.hasOwnProperty.call(rec, key) ? rec[key] : undefined

/**
 * A rendered row. `drop` marks rows that may go when the view is short: the
 * highest number goes first; rows without it stay (relay history is sized to
 * what is left, so it goes before any of these).
 */
interface Row {
	line: Line
	drop?: number
}
const keep = (line: Line): Row => ({ line })
const optional = (line: Line, drop: number): Row => ({ line, drop })

function fitRow(label: Line, groups: Group[], width: number): Line {
	return [
		...label,
		...fitGroups(groups, Math.max(1, width - LABEL_W), { sep: "   " }),
	]
}

/** Groups joined by " · ", lowest-priority groups dropped first when narrow (spec §4.2). */
function fitDot(label: Line, groups: Group[], width: number): Line {
	return [
		...label,
		...fitGroups(groups, Math.max(1, width - LABEL_W), { sep: sep() }),
	]
}

function clipped(
	label: Line,
	text: string,
	width: number,
	role: Role = "value",
): Line {
	return [...label, sp(truncate(text, Math.max(1, width - LABEL_W)), role)]
}

/** "tcp://192.0.2.23:5555" or core's bare "192.0.2.23:5555". */
function hostOf(url: string | undefined): string | null {
	if (!url) return null
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
		try {
			return new URL(url).host || null
		} catch {
			return null
		}
	}
	return sanitize(url)
}

function noData(state: AppState, path: string): string {
	return state.conn.rest.firstFailAt !== null
		? `no data${sep()}API unreachable`
		: `fetching ${path}`
}

export function receiverControl(
	state: AppState,
): "internal" | "external" | null {
	const t = state.tuner.value?.[0]
	return t ? t.controlMode : null
}

function quoted(text: string, max = 40): string {
	return `"${truncate(sanitize(text), max)}"`
}

function sourceBlock(state: AppState, src: SourceRow, width: number): Row[] {
	const now = state.now
	const role: Role = isOld(state.sources, now) ? "old" : "value"
	const iq = iqView(
		src,
		isFresh(state.sources, now),
		own(state.metrics, src.id),
		now,
	)
	const host = hostOf(src.url)
	const a = src.activity
	const g = glyphs()
	const where = `${src.id}${sep()}${src.type ?? "source"}${host ? ` ${host}` : ""}`
	const row1: Group[] = [
		one(0, txt(src.id, role), txt(where, role)),
		one(0, [
			glyphSpan(src.connected ? "live" : "fault"),
			sp(src.connected ? " connected" : " disconnected", role),
		]),
		one(
			1,
			[glyphSpan(iq.glyph), sp(` ${iq.word}`, role)],
			...(a
				? [
						[
							glyphSpan(iq.glyph),
							sp(
								` ${iq.word}${sep()}sample age ${formatSampleAge(a.sampleAgeMs)}${sep()}timeout ${Math.round(a.timeoutMs / 1000)} s`,
								role,
							),
						],
					]
				: []),
		),
		...(src.available
			? []
			: [one(2, txt("no assignment capacity", "attention"))]),
	]
	const rate = formatRate(iq.rateBytesPerSec)
	const row2: Group[] = [
		one(
			0,
			txt(rate, role),
			txt(
				`${rate} (${formatMSps(src.caps.sampleRate)} ${src.caps.format.replace("_", " ")})`,
				role,
			),
		),
		one(1, txt(`received ${formatBytes(src.bytesReceived)}`, role)),
		one(2, txt(`reconnects ${src.reconnectAttempts}`, role)),
		one(
			1,
			txt(`last error ${src.lastError ? quoted(src.lastError) : g.na}`, role),
		),
		one(3, txt(`assigned ${src.assignments.length} decoders`, role)),
	]
	return [
		keep(fitRow(lbl("SOURCE", true), row1, width)),
		optional(fitRow(lbl("rate"), row2, width), 2),
	]
}

const FIELD_LABEL: Readonly<Record<EditField, string>> = {
	frequency: "frequency",
	sampleRate: "sample rate",
	gain: "gain",
	ppm: "ppm",
	gainMode: "gain mode",
	agc: "rtl agc",
	biasTee: "bias-t",
	directSampling: "direct sampling",
	offsetTuning: "offset tuning",
}

function plainValue(field: EditField, v: number | string | boolean): string {
	if (typeof v === "boolean") return onOff(v)
	if (typeof v === "string") return v
	switch (field) {
		case "frequency":
			return formatSpaced(v)
		case "sampleRate":
			return formatSps(v)
		case "gain":
			return (v / 10).toFixed(1)
		default:
			return String(v)
	}
}

function rangeNote(): string {
	return `outside ${FREQ_MIN / 1e6}${glyphs().range}${formatSpaced(FREQ_MAX / 1e6)} MHz`
}

/** Pending row item: "frequency 445 970 700 → 446 000 000", "gain 0.0 → 20.7 dB". */
export function changeText(c: PendingChange): string {
	const to =
		c.field === "gain" && typeof c.to === "number"
			? formatDb(c.to)
			: plainValue(c.field, c.to)
	return `${FIELD_LABEL[c.field]} ${plainValue(c.field, c.from)} → ${to}`
}

/** Confirm item: "frequency 446 000 000 Hz (+29.3 kHz)", "gain 20.7 dB". */
export function confirmItem(c: PendingChange): string {
	if (
		c.field === "frequency" &&
		typeof c.to === "number" &&
		typeof c.from === "number"
	)
		return `frequency ${formatHz(c.to)} (${formatDeltaHz(c.to - c.from)})`
	if (c.field === "gain" && typeof c.to === "number")
		return `gain ${formatDb(c.to)}`
	return `${FIELD_LABEL[c.field]} ${plainValue(c.field, c.to)}`
}

/** The review confirm; null when nothing changed or a field is out of core's range. */
export function tunerConfirm(edit: TunerEditState): ConfirmRequest | null {
	const commands = pendingCommands(edit)
	if (commands.length === 0 || outOfRange(edit).length > 0) return null
	const n = commands.length
	return {
		kind: "tuner",
		prompt: `send ${n} command${n === 1 ? "" : "s"} to ${edit.sourceId}: ${pendingChanges(edit).map(confirmItem).join(", ")}`,
		...(turnsBiasTeeOn(edit)
			? { extra: "bias-t supplies DC on the antenna port" }
			: {}),
		yes: "send",
		no: "back",
		intent: { kind: "tuner", sourceId: edit.sourceId, commands },
	}
}

/** Notice for Enter when the review is held (R42): names the field and the range. */
export function reviewHeldNotice(edit: TunerEditState): string {
	const bad = outOfRange(edit)
	if (bad.length > 0)
		return `${bad.map(f => FIELD_LABEL[f]).join(", ")} ${rangeNote()}`
	return "nothing changed"
}

export function controlConfirm(state: AppState): ConfirmRequest | null {
	const t = state.tuner.value?.[0]
	if (!t) return null
	const relay = state.relay.value
	const toInternal = t.controlMode === "external"
	const who = relay?.controlClientId
		? `relay ${relay.controlClientId}${relay.controlClientRemote ? ` ${relay.controlClientRemote.split(":")[0] ?? ""}` : ""}`
		: "external clients"
	return {
		kind: "control",
		prompt: toInternal
			? `take tuner control from ${who}? its next tuning command is refused`
			: "release tuner control to external clients?",
		yes: toInternal ? "take" : "release",
		no: "cancel",
		intent: {
			kind: "tuner",
			sourceId: t.sourceId,
			commands: [
				{
					setting: "control-mode",
					body: { mode: toInternal ? "internal" : "external" },
					label: "control",
				},
			],
		},
	}
}

/**
 * Result line for 10 s after the last outcome, in CLI words (R29): "sent · frequency ok
 * 18:07:52", "frequency sent · no reply in 10s" (R23), `frequency failed · 409 · "…"`.
 */
export function tunerResultText(
	state: AppState,
	sourceId: string,
	now: number,
): string | null {
	const rec = own(state.actions.byKey, `tuner:${sourceId}`)
	if (!rec) return null
	if (rec.state === "sent" && rec.outcomes.length === 0)
		return `sending ${formatClock(rec.sentAt)}`
	const ats = rec.outcomes.map(o => o.at).filter((x): x is number => x !== null)
	const doneAt = rec.doneAt ?? (ats.length > 0 ? Math.max(...ats) : null)
	if (doneAt === null || now - doneAt > RESULT_MS) return null
	const parts = rec.outcomes.map((o, i) => {
		const r = o.result
		if (r === null) return `${o.label} not sent`
		if (r.outcome === "ok")
			return `${o.label} ok${i === 0 && o.at !== null ? ` ${formatClock(o.at)}` : ""}`
		if (r.outcome === "unknown")
			return `${o.label} sent${sep()}no reply in ${Math.round(RESULT_MS / 1000)}s`
		return `${o.label} failed${sep()}${r.status ?? "network"}${sep()}${quoted(r.message, 60)}`
	})
	return `${rec.state === "ok" ? `sent${sep()}` : ""}${parts.join(sep())}`
}

function withCursor(freq: number, digit: number): Line {
	const s = formatSpaced(freq)
	let count = -1
	let idx = s.length
	for (let i = s.length - 1; i >= 0; i--) {
		if (/\d/.test(s[i] ?? "")) count++
		if (count === digit) {
			idx = i
			break
		}
	}
	// A cursor left of the leading digit sits before the number.
	if (count < digit) idx = 0
	return [
		sp(s.slice(0, idx), "accent"),
		sp(glyphs().cursor, "edit"),
		sp(`${s.slice(idx)} Hz`, "accent"),
	]
}

function membershipLists(
	state: AppState,
	sourceId: string,
): { inside: string; outside: string; unknown: string } {
	const tuned: string[] = []
	const inside: string[] = []
	const outside: string[] = []
	const unknown: string[] = []
	const decoders = retuneCandidates(
		state.decoders.value ?? [],
		state.sources.value,
		sourceId,
	)
	for (const d of decoders) {
		// R40: tuned types follow the centre whatever their configured targets.
		if (decoderBand(d)?.band.kind === "tuned") {
			tuned.push(d.id)
			continue
		}
		const m = decoderMembership(
			d,
			state.sources.value,
			state.tuner.value,
			state.relay.value,
		)
		if (m === "in") inside.push(d.id)
		else if (m === "out") outside.push(d.id)
		else if (m === "?") unknown.push(d.id)
	}
	const na = glyphs().na
	const ins = [
		...inside,
		...(tuned.length > 0 ? [`${tuned.join(", ")} (tuned)`] : []),
	]
	return {
		inside: ins.join(", ") || na,
		outside: outside.join(", ") || na,
		unknown: unknown.join(", "),
	}
}

/** "dsd-fme, multimon-ng (tuned) · lora-meshtastic enters"; never claims more than is known. */
function affectsText(impact: RetuneImpact, fromKnown: boolean): string {
	const parts: string[] = []
	if (impact.tuned.length > 0) parts.push(`${impact.tuned.join(", ")} (tuned)`)
	if (!fromKnown) {
		parts.push(`window now ?`)
		return parts.join(sep())
	}
	const moves = [
		...impact.enters.map(x => `${x} enters`),
		...impact.leaves.map(x => `${x} leaves`),
	]
	if (moves.length > 0) parts.push(moves.join(", "))
	else if (impact.unknown.length === 0)
		parts.push("no decoder enters or leaves the window")
	if (impact.unknown.length > 0) parts.push(`${impact.unknown.join(", ")} ?`)
	return parts.join(sep())
}

function pendingLine(edit: TunerEditState, width: number): Line {
	const changes = pendingChanges(edit)
	if (changes.length === 0)
		return clipped(lbl("pending"), "nothing changed", width)
	const bad = new Set(outOfRange(edit))
	const spans: Line = []
	changes.forEach((c, i) => {
		if (i > 0) spans.push(sp(sep(), "label"))
		if (bad.has(c.field))
			spans.push(sp(`${changeText(c)} (${rangeNote()})`, "attention", true))
		else spans.push(sp(changeText(c), "value"))
	})
	return [
		...lbl("pending"),
		...truncateLine(spans, Math.max(1, width - LABEL_W)),
	]
}

function tunerBlock(
	state: AppState,
	ui: UiState,
	t: TunerState,
	relay: TunerRelayStatus | undefined,
	width: number,
): Row[] {
	const now = state.now
	const role: Role = isOld(state.tuner, now) ? "old" : "value"
	const edit = ui.edit && ui.edit.sourceId === t.sourceId ? ui.edit : null
	const current = windowFor(
		t.sourceId,
		state.tuner.value,
		state.sources.value,
		relay,
	)
	const win: TunedWindow | null = edit
		? (() => {
				const w = editWindow(edit)
				return {
					sourceId: t.sourceId,
					centreHz: w.centreHz,
					sampleRate: w.sampleRate,
					loHz: w.centreHz - w.sampleRate / 2,
					hiHz: w.centreHz + w.sampleRate / 2,
				}
			})()
		: current
	const focus = (f: EditField): Role =>
		edit && edit.field === f ? "accent" : role
	const d = edit?.draft
	const freqCell: Line = edit
		? withCursor(edit.draft.frequency, edit.digit)
		: txt(formatHz(t.frequency), role)
	const rows: Row[] = []
	if (edit) {
		rows.push(
			keep([
				...lbl("TUNER", true),
				sp("EDIT", "edit", true),
				sp(
					`${sep()}wavekit control${sep()}nothing sent until confirmed`,
					"label",
				),
			]),
		)
	} else {
		const owner =
			t.controlMode === "external" ? "external control" : "wavekit control"
		const client =
			t.controlMode === "external" && relay?.controlClientId
				? `relay ${relay.controlClientId}${relay.controlClientRemote ? ` ${relay.controlClientRemote}` : ""}`
				: null
		const ws = own(state.tunerLastCommand, t.sourceId)
		const last =
			ws ??
			(relay?.lastCommand && relay.lastCommandAt
				? { command: relay.lastCommand, at: Date.parse(relay.lastCommandAt) }
				: null)
		const lastText =
			last && Number.isFinite(last.at)
				? `last ${sanitize(last.command)} ${formatAge(now - last.at)} ago`
				: null
		rows.push(
			keep(
				fitDot(
					lbl("TUNER", true),
					[
						one(0, txt(owner, role)),
						...(client ? [one(2, txt(client, role))] : []),
						one(3, txt(`${t.commandCount} commands`, role)),
						...(lastText ? [one(1, txt(lastText, role))] : []),
					],
					width,
				),
			),
		)
	}
	rows.push(
		keep(
			fitRow(
				lbl("frequency"),
				[
					one(0, freqCell),
					one(
						0,
						txt(`window ${win ? formatWindow(win.loHz, win.hiHz) : "?"}`, role),
					),
					one(
						1,
						txt(
							`sample rate ${formatSps(d?.sampleRate ?? t.sampleRate)}`,
							focus("sampleRate"),
						),
					),
					one(2, txt(`ppm ${d?.ppm ?? t.ppm}`, focus("ppm"))),
				],
				width,
			),
		),
	)
	const gainMode = d?.gainMode ?? t.gainMode
	const tunerType = relay?.rtlTcpHeader
		? own(TUNER_TYPES, String(relay.rtlTcpHeader.tunerType))
		: undefined
	const gainText =
		gainMode === "agc"
			? "agc"
			: d
				? `manual${sep()}${formatDb(d.gainTenthsDb)}`
				: t.tunerGainIndex !== undefined && t.gain === 0
					? `manual${sep()}index ${t.tunerGainIndex}${tunerType ? ` (${tunerType})` : ""}`
					: `manual${sep()}${formatDb(t.gain)}`
	rows.push(
		optional(
			fitRow(
				lbl("gain"),
				[
					one(
						0,
						txt(
							gainText,
							edit && (edit.field === "gain" || edit.field === "gainMode")
								? "accent"
								: role,
						),
					),
					one(1, txt(`rtl agc ${onOff(d?.agc ?? t.agcMode)}`, focus("agc"))),
					one(
						1,
						txt(`bias-t ${onOff(d?.biasTee ?? t.biasTee)}`, focus("biasTee")),
					),
					one(
						2,
						txt(
							`direct sampling ${d?.directSampling ?? t.directSampling}`,
							focus("directSampling"),
						),
					),
					one(
						2,
						txt(
							`offset tuning ${onOff(d?.offsetTuning ?? t.offsetTuning)}`,
							focus("offsetTuning"),
						),
					),
				],
				width,
			),
			// While editing, the field being edited may be the gain row.
			edit ? 0 : 1,
		),
	)
	if (edit) {
		rows.push(keep(pendingLine(edit, width)))
		const candidates = retuneCandidates(
			state.decoders.value ?? [],
			state.sources.value,
			t.sourceId,
		)
		const impact: RetuneImpact = win
			? retuneImpact(candidates, current, win)
			: { tuned: [], enters: [], leaves: [], unknown: [] }
		rows.push(
			keep(
				clipped(
					lbl("affects"),
					affectsText(impact, current !== null && win !== null),
					width,
				),
			),
		)
		return rows
	}
	if (
		relay?.lastFrequency !== undefined &&
		relay.lastFrequency !== t.frequency
	) {
		const at = relay.lastCommandAt
			? ` ${formatClock(Date.parse(relay.lastCommandAt))}`
			: ""
		rows.push(
			optional(
				clipped(
					lbl("relay set"),
					`${formatHz(relay.lastFrequency)}${at}`,
					width,
					role,
				),
				1,
			),
		)
	}
	const result = tunerResultText(state, t.sourceId, now)
	if (result) rows.push(keep(clipped(lbl("result"), result, width)))
	const lists = membershipLists(state, t.sourceId)
	rows.push(optional(clipped(lbl("in window"), lists.inside, width, role), 3))
	rows.push(optional(clipped(lbl("out"), lists.outside, width, role), 3))
	if (lists.unknown)
		rows.push(optional(clipped(lbl("window ?"), lists.unknown, width, role), 3))
	return rows
}

function relayHeader(relay: TunerRelayStatus, width: number): Line {
	return fitDot(
		lbl("RELAY", true),
		[
			one(
				0,
				txt(relay.listening ? `listening :${relay.port}` : "not listening"),
			),
			one(
				1,
				txt(`${relay.clientsConnected} of ${relay.maxClients ?? "?"} clients`),
			),
			one(3, txt(`${formatBytes(relay.bytesSent)} sent`)),
			one(2, txt(`${relay.controlPolicy} control`)),
			one(
				1,
				txt(
					`last error ${relay.lastError ? quoted(relay.lastError) : glyphs().na}`,
				),
			),
		],
		width,
	)
}

function historyRows(
	relay: TunerRelayStatus,
	max: number,
	width: number,
): Line[] {
	const rows = [...(relay.commandHistory ?? [])]
		.sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
		.slice(0, Math.max(0, max))
	return rows.map(h => {
		const who = sanitize(
			`${h.clientId ?? "?"}${h.clientRemote ? ` ${h.clientRemote}` : ""}`,
		)
		return [
			sp(
				truncate(
					`${formatClock(Date.parse(h.at))}  ${who}  ${padEnd(sanitize(h.name), 22)}${padStart(formatSpaced(h.value), 12)}`,
					width,
				),
				"label",
			),
		]
	})
}

/** Why drop now cannot be computed (truth rule: unknown says why, never 0). */
function dropUnknownReason(state: AppState): string {
	const f = state.fanout.value
	if (!isFresh(state.fanout, state.now)) return "no fanout sample in 15s"
	if (
		f &&
		f.branches.some(
			b => b.decoderId !== undefined && b.totalBytesWritten === undefined,
		)
	)
		return "core reports no offered bytes"
	const h = state.fanoutHistory
	const span = h.length >= 2 ? (h[h.length - 1]?.t ?? 0) - (h[0]?.t ?? 0) : 0
	if (h.length < 2 || span < MIN_DROP_SPAN_MS) return "needs 2 snapshots in 10s"
	return "a counter was reset"
}

function fanoutBlock(state: AppState, width: number): Row[] {
	const now = state.now
	const f = state.fanout.value
	if (!f)
		return [
			keep(
				clipped(
					lbl("FANOUT", true),
					noData(state, "/api/telemetry/fanout"),
					width,
					"label",
				),
			),
		]
	const role: Role = isOld(state.fanout, now) ? "old" : "value"
	const agg = isFresh(state.fanout, now)
		? aggregateDropNow(state.fanoutHistory)
		: null
	const dec = f.branches.filter(b => b.decoderId !== undefined)
	const bp = dec.filter(b => b.backpressureActive).length
	const known = agg?.ratio !== null && agg?.ratio !== undefined
	const head: Group[] = known
		? [
				one(
					0,
					txt(`${formatPercent(agg.ratio)} dropped now`, role),
					txt(
						`decoder branches: ${formatPercent(agg.ratio)} of offered IQ dropped now`,
						role,
					),
				),
				one(1, txt(`${bp} of ${dec.length} in backpressure`, role)),
				one(2, txt(`${formatRate(agg.offeredBytesPerSec)} offered each`, role)),
			]
		: [
				one(
					0,
					txt("drop now ?", role),
					txt("decoder branches: drop now ?", role),
				),
				one(1, txt(dropUnknownReason(state), role)),
				one(2, txt(`${bp} of ${dec.length} in backpressure`, role)),
			]
	const offered =
		dec.length > 0 && dec.every(b => b.totalBytesWritten !== undefined)
			? dec.reduce((a, b) => a + (b.totalBytesWritten ?? 0), 0)
			: null
	const dropped = dec.reduce((a, b) => a + b.droppedBytesTotal, 0)
	const relayDropped = f.branches
		.filter(b => b.decoderId === undefined)
		.reduce((a, b) => a + b.droppedBytesTotal, 0)
	const lifePct =
		offered === null || offered === 0 ? "?" : formatPercent(dropped / offered)
	const life: Group[] = [
		one(
			1,
			txt(
				`${offered === null ? "?" : formatBytes(offered / dec.length)} offered per branch`,
				role,
			),
		),
		one(
			0,
			txt(`${formatBytes(dropped)} dropped (${lifePct})`, role),
			txt(`${formatBytes(dropped)} dropped across branches (${lifePct})`, role),
		),
		one(2, txt(`relay branch ${formatBytes(relayDropped)} dropped`, role)),
	]
	const src = state.sources.value?.[0]
	const up = src
		? state.resources.value?.sourceBackpressure.find(b => b.sourceId === src.id)
		: undefined
	const upRole: Role = isOld(state.resources, now) ? "old" : "value"
	const upGroups: Group[] = up
		? [
				one(
					0,
					txt(
						`${formatBytes(up.bytesDroppedUpstream)} dropped (${up.dropPercent.toFixed(2)}%)`,
						upRole,
					),
					txt(
						`Pi rtlmux → core: ${formatBytes(up.bytesDroppedUpstream)} dropped lifetime (${up.dropPercent.toFixed(2)}%)`,
						upRole,
					),
				),
				one(1, txt(`${formatRate(up.dropRate)} now`, upRole)),
				one(
					2,
					txt(
						`checked ${formatAge(now - Date.parse(up.lastCheckedAt))} ago`,
						upRole,
					),
				),
			]
		: [one(0, txt("Pi rtlmux → core: ? (no SDR host data)", upRole))]
	return [
		keep(fitDot(lbl("FANOUT", true), head, width)),
		optional(fitDot(lbl("lifetime"), life, width), 4),
		optional(fitDot(lbl("upstream"), upGroups, width), 4),
	]
}

/** Spec §6.4 order: SOURCE, TUNER, RELAY (+history filling what remains), FANOUT, upstream. */
export function receiverLines(
	state: AppState,
	ui: UiState,
	width: number,
	height: number,
	roomy: boolean,
): Line[] {
	const src = state.sources.value?.[0]
	const relay = state.relay.value
	const t =
		state.tuner.value?.find(x => x.sourceId === src?.id) ??
		state.tuner.value?.[0]
	const gap = (): Row[] => (roomy ? [optional([], 5)] : [])
	const source = src
		? sourceBlock(state, src, width)
		: [
				keep(
					clipped(
						lbl("SOURCE", true),
						noData(state, "/api/sources"),
						width,
						"label",
					),
				),
			]
	const tuner = t
		? tunerBlock(state, ui, t, relay, width)
		: [
				keep(
					clipped(
						lbl("TUNER", true),
						noData(state, "/api/tuner"),
						width,
						"label",
					),
				),
			]
	const relayHead = keep(
		relay
			? relayHeader(relay, width)
			: clipped(
					lbl("RELAY", true),
					noData(state, "/api/tuner-relay"),
					width,
					"label",
				),
	)
	const fanout = fanoutBlock(state, width)
	const fixed: Row[] = [...source, ...gap(), ...tuner, ...gap(), relayHead]
	const tail: Row[] = [...gap(), ...fanout]
	// Short views shed optional rows, highest drop number first.
	let rows = [...fixed, ...tail]
	while (rows.length > height) {
		const worst = rows.reduce((m, r) => Math.max(m, r.drop ?? -1), -1)
		if (worst < 0) break
		const at = rows.map(r => r.drop ?? -1).lastIndexOf(worst)
		rows = rows.filter((_, i) => i !== at)
	}
	const room = height - rows.length
	const history = relay && room > 0 ? historyRows(relay, room, width) : []
	const relayAt = rows.indexOf(relayHead)
	const lines = rows.map(r => r.line)
	if (relayAt >= 0) lines.splice(relayAt + 1, 0, ...history)
	return lines.slice(0, height)
}
