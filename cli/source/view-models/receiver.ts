import type { TunerRelayStatus, TunerState } from "@wavekit/api-types"
import { iqView, isFresh, isOld } from "../data/freshness.js"
import { decoderBand } from "../data/nominal-bands.js"
import { aggregateDropNow, MIN_DROP_SPAN_MS } from "../data/rates.js"
import type { AppState, FanoutSample, SourceRow } from "../data/types.js"
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
import { essential, gapRow, keep, optional, shed, type Row } from "./shed.js"

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

/** The source the Receiver renders (the first), and the tuner for it: used everywhere (M5). */
export function receiverTuner(state: AppState): TunerState | undefined {
	const src = state.sources.value?.[0]
	return (
		state.tuner.value?.find(x => x.sourceId === src?.id) ??
		state.tuner.value?.[0]
	)
}

export function receiverControl(
	state: AppState,
): "internal" | "external" | null {
	return receiverTuner(state)?.controlMode ?? null
}

/** Host of "192.0.2.1:59430", "[2001:db8::1]:59430", "2001:db8::1:59430" or "::ffff:192.0.2.1:59430". */
export function remoteHost(remote: string): string {
	const r = remote.trim()
	const bracket = /^\[([^\]]+)\](?::\d+)?$/.exec(r)
	const host = bracket
		? (bracket[1] ?? r)
		: /:\d+$/.test(r)
			? r.slice(0, r.lastIndexOf(":"))
			: r
	return sanitize(host.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, ""))
}

function relayClient(
	relay: TunerRelayStatus | undefined,
	full: boolean,
): string | null {
	if (!relay?.controlClientId) return null
	const id = sanitize(relay.controlClientId)
	const remote = relay.controlClientRemote
	if (!remote) return `relay ${id}`
	return `relay ${id} ${full ? sanitize(remote) : remoteHost(remote)}`
}

function quoted(text: string, max = 40): string {
	return `"${truncate(sanitize(text), max)}"`
}

function sourceBlock(state: AppState, src: SourceRow, width: number): Row[] {
	const now = state.now
	const held = (state.decoders.value ?? [])
		.filter(
			d =>
				d.suspended === true &&
				(d.sourceId === src.id ||
					src.assignments.some(a => a.decoderId === d.id)),
		)
		.map(d => sanitize(d.id))
	const extraSources = (state.sources.value?.length ?? 1) - 1
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
		...(extraSources > 0
			? [
					one(
						1,
						txt(
							`+${extraSources} source${extraSources === 1 ? "" : "s"}`,
							role,
						),
					),
				]
			: []),
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
		// R70: a suspended decoder keeps its reservation and sourceId; say who holds it.
		...(held.length > 0
			? [
					one(
						1,
						txt(
							`held by suspended ${held.slice(0, 2).join(", ")}${held.length > 2 ? ` +${held.length - 2}` : ""}`,
							role,
						),
					),
				]
			: []),
	]
	return [
		essential(fitRow(lbl("SOURCE", true), row1, width)),
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

/**
 * The review confirm; null when nothing changed or a field is out of core's range.
 * With `state` it also names the blast radius (spec §10.9). `groups` fit the bar by
 * priority (R71): the action, then a safety warning, then who enters or leaves, then
 * the field details, then the tuned list.
 */
export function tunerConfirm(
	edit: TunerEditState,
	state?: AppState,
): ConfirmRequest | null {
	const commands = pendingCommands(edit)
	if (commands.length === 0 || outOfRange(edit).length > 0) return null
	const n = commands.length
	const action = `send ${n} command${n === 1 ? "" : "s"} to ${edit.sourceId}`
	const details = pendingChanges(edit).map(confirmItem).join(", ")
	const bias = turnsBiasTeeOn(edit)
	const affects = state ? editImpact(state, edit) : null
	const extras = [
		...(bias ? ["bias-t supplies DC on the antenna port"] : []),
		...(affects ? [`affects ${affectsJoin(affects)}`] : []),
	]
	const groups: Group[] = [
		one(
			0,
			[sp(`send ${n} to ${edit.sourceId}`, "value", true)],
			[sp(action, "value", true)],
			[sp(`${action}: ${details}`, "value", true)],
		),
		...(bias
			? [
					one(
						1,
						[sp("bias-t DC on antenna", "attention", true)],
						[sp("bias-t supplies DC on the antenna port", "attention", true)],
					),
				]
			: []),
		...(affects
			? [
					one(
						2,
						[sp(affects.short, "value")],
						[sp(affects.moves, "value")],
						...(affects.tuned === null
							? []
							: [[sp(`affects ${affectsJoin(affects)}`, "value")]]),
					),
				]
			: []),
	]
	return {
		kind: "tuner",
		prompt: `${action}: ${details}`,
		...(extras.length > 0 ? { extra: extras.join(sep()) } : {}),
		yes: "send",
		no: "back",
		intent: { kind: "tuner", sourceId: edit.sourceId, commands },
		groups,
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
	const t = receiverTuner(state)
	if (!t) return null
	const toInternal = t.controlMode === "external"
	const who = relayClient(state.relay.value, false) ?? "external clients"
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
 * Result line in CLI words (R29), by action state:
 * sent → "sending 18:07:52"; unknown (R23, awaiting a reconciling event) →
 * "frequency sent · no reply in 10s"; no-reply (terminal) → "frequency sent · no reply";
 * ok → "sent · frequency ok 18:07:52"; failed → `frequency failed · 409 · "…" · gain not sent`.
 * Terminal states show for 10 s after doneAt; unknown shows until it resolves.
 */
export function tunerResultText(
	state: AppState,
	sourceId: string,
	now: number,
): string | null {
	const rec = own(state.actions.byKey, `tuner:${sourceId}`)
	if (!rec) return null
	if (rec.state === "sent") return `sending ${formatClock(rec.sentAt)}`
	if (
		rec.state !== "unknown" &&
		(rec.doneAt === null || now - rec.doneAt > RESULT_MS)
	)
		return null
	const parts = rec.outcomes.map((o, i) => {
		const r = o.result
		if (r === null) return `${o.label} not sent`
		// An unknown command that an event confirmed reads ok, at the confirmation time.
		if (r.outcome === "ok" || (r.outcome === "unknown" && rec.state === "ok")) {
			const at = r.outcome === "ok" ? o.at : rec.confirmedAt
			return `${o.label} ok${i === 0 && at !== null ? ` ${formatClock(at)}` : ""}`
		}
		if (r.outcome === "unknown")
			return rec.state === "no-reply"
				? `${o.label} sent${sep()}no reply`
				: `${o.label} sent${sep()}no reply in ${Math.round(RESULT_MS / 1000)}s`
		return `${o.label} failed${sep()}${r.status ?? "network"}${sep()}${quoted(r.message, 60)}`
	})
	return `${rec.state === "ok" ? `sent${sep()}` : ""}${parts.join(sep())}`
}

function withCursor(freq: number, digit: number, focused: boolean): Line {
	const role: Role = focused ? "accent" : "value"
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
		sp(s.slice(0, idx), role),
		...(focused ? [sp(glyphs().cursor, "edit")] : []),
		sp(`${s.slice(idx)} Hz`, role),
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
	// The decoders lane has never answered: membership is unknown, not empty (M4).
	if (state.decoders.value === undefined)
		return { inside: "?", outside: "?", unknown: "" }
	const decoders = retuneCandidates(
		state.decoders.value,
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
interface Affects {
	/** "dsd-fme, multimon-ng (tuned)", or null when no tuned decoder is on the source. */
	tuned: string | null
	/** Who enters or leaves, or what is unknown: "lora-meshtastic enters", "window now ?". */
	moves: string
	/** The same, terse for a narrow confirm bar ("no decoder enters or leaves"). */
	short: string
}

function affectsParts(impact: RetuneImpact, fromKnown: boolean): Affects {
	const tuned =
		impact.tuned.length > 0 ? `${impact.tuned.join(", ")} (tuned)` : null
	if (!fromKnown) return { tuned, moves: "window now ?", short: "window now ?" }
	const parts: string[] = []
	const moves = [
		...impact.enters.map(x => `${x} enters`),
		...impact.leaves.map(x => `${x} leaves`),
	]
	if (moves.length > 0) parts.push(moves.join(", "))
	else if (impact.unknown.length === 0)
		parts.push("no decoder enters or leaves the window")
	if (impact.unknown.length > 0) parts.push(`${impact.unknown.join(", ")} ?`)
	const moved = moves.length > 0 || impact.unknown.length > 0
	return {
		tuned,
		moves: parts.join(sep()),
		short: moved ? parts.join(sep()) : "no decoder enters or leaves",
	}
}

const affectsJoin = (a: Affects): string =>
	a.tuned === null ? a.moves : `${a.tuned}${sep()}${a.moves}`

/** The window the draft would tune to. */
function draftWindow(edit: TunerEditState): TunedWindow {
	const w = editWindow(edit)
	return {
		sourceId: edit.sourceId,
		centreHz: w.centreHz,
		sampleRate: w.sampleRate,
		loHz: w.centreHz - w.sampleRate / 2,
		hiHz: w.centreHz + w.sampleRate / 2,
	}
}

/** Who a retune to the draft moves, from what is known: "decoders ?" when the lane is unknown. */
export function editAffects(state: AppState, edit: TunerEditState): string {
	return affectsJoin(editImpact(state, edit))
}

function editImpact(state: AppState, edit: TunerEditState): Affects {
	if (state.decoders.value === undefined)
		return { tuned: null, moves: "decoders ?", short: "decoders ?" }
	const current = windowFor(
		edit.sourceId,
		state.tuner.value,
		state.sources.value,
		state.relay.value,
	)
	const candidates = retuneCandidates(
		state.decoders.value,
		state.sources.value,
		edit.sourceId,
	)
	const impact: RetuneImpact = retuneImpact(
		candidates,
		current,
		draftWindow(edit),
	)
	return affectsParts(impact, current !== null)
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
	const win: TunedWindow | null = edit ? draftWindow(edit) : current
	const focus = (f: EditField): Role =>
		edit && edit.field === f ? "accent" : role
	const d = edit?.draft
	const freqCell: Line = edit
		? withCursor(edit.draft.frequency, edit.digit, edit.field === "frequency")
		: txt(formatHz(t.frequency), role)
	const rows: Row[] = []
	if (edit) {
		rows.push(
			essential([
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
			t.controlMode === "external" ? relayClient(relay, true) : null
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
			essential(
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
	const gainRow = (line: Line): Row =>
		// While editing, the gain row shows draft values and is kept (M8).
		edit ? keep(line) : optional(line, 1)
	rows.push(
		gainRow(
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
		),
	)
	if (edit) {
		rows.push(keep(pendingLine(edit, width)))
		rows.push(keep(clipped(lbl("affects"), editAffects(state, edit), width)))
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

function relayHeader(relay: TunerRelayStatus, width: number, role: Role): Line {
	return fitDot(
		lbl("RELAY", true),
		[
			one(
				0,
				txt(
					!relay.enabled
						? "disabled"
						: relay.listening
							? `listening :${relay.port}`
							: "not listening",
					role,
				),
			),
			one(
				1,
				txt(
					`${relay.clientsConnected} of ${relay.maxClients ?? "?"} clients`,
					role,
				),
			),
			one(3, txt(`${formatBytes(relay.bytesSent)} sent`, role)),
			one(2, txt(`${sanitize(relay.controlPolicy)} control`, role)),
			one(
				1,
				txt(
					`last error ${relay.lastError ? quoted(relay.lastError) : glyphs().na}`,
					role,
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

/** Decoder-branch counters went down between two samples (a core or branch restart). */
function counterReset(history: readonly FanoutSample[]): boolean {
	const prev = new Map<string, { offered?: number; dropped: number }>()
	for (const h of history) {
		for (const [id, b] of Object.entries(h.branches)) {
			if (b.decoderId === undefined) continue
			const p = prev.get(id)
			if (
				p &&
				(b.dropped < p.dropped ||
					(p.offered !== undefined &&
						b.offered !== undefined &&
						b.offered < p.offered))
			)
				return true
			prev.set(id, b)
		}
	}
	return false
}

/** Why drop now cannot be computed (truth rule: unknown says why, never 0). */
function dropUnknownReason(state: AppState): string {
	const f = state.fanout.value
	if (!isFresh(state.fanout, state.now)) return "no fanout sample in 15s"
	const dec = f?.branches.filter(b => b.decoderId !== undefined) ?? []
	if (dec.length === 0) return "no decoder branches"
	if (dec.some(b => b.totalBytesWritten === undefined))
		return "core reports no offered bytes"
	const h = state.fanoutHistory
	const oldest = h[0]
	const newest = h[h.length - 1]
	const span = oldest && newest ? newest.t - oldest.t : 0
	if (h.length < 2 || span < MIN_DROP_SPAN_MS) return "needs 2 snapshots in 10s"
	if (counterReset(h)) return "a counter was reset"
	// Branches in both the oldest and the newest sample (the aggregate's rule, R4).
	const both = Object.entries(newest?.branches ?? {}).filter(
		([id, b]) =>
			b.decoderId !== undefined && oldest?.branches[id] !== undefined,
	)
	if (both.length === 0) return "no branch in both samples"
	const offered = both.reduce(
		(sum, [id, b]) =>
			sum + (b.offered ?? 0) - (oldest?.branches[id]?.offered ?? 0),
		0,
	)
	return offered <= 0 ? "no IQ offered in 10s" : "too few samples per branch"
}

function fanoutBlock(state: AppState, width: number): Row[] {
	const now = state.now
	const f = state.fanout.value
	if (!f)
		return [
			essential(
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
	const resources = state.resources.value
	const up = src
		? resources?.sourceBackpressure.find(b => b.sourceId === src.id)
		: undefined
	const upOld = isOld(state.resources, now)
	const upRole: Role = upOld ? "old" : "value"
	// Core sends one entry per source; available: false means no rtlmux stats. With
	// no SDR host for the source that is not applicable (—); with one it is unknown (?).
	const hasHost =
		src !== undefined &&
		(resources?.sdrHosts.some(h => h.sourceId === src.id) ?? false)
	const upGroups: Group[] =
		up?.available === true
			? [
					one(
						0,
						txt(
							`${formatBytes(up.bytesDroppedUpstream)} dropped lifetime (${up.dropPercent.toFixed(2)}%)`,
							upRole,
						),
						txt(
							`Pi rtlmux → core: ${formatBytes(up.bytesDroppedUpstream)} dropped lifetime (${up.dropPercent.toFixed(2)}%)`,
							upRole,
						),
					),
					// A rate "now" from an old lane is unknown, not a dimmed number (T6).
					one(1, txt(`${upOld ? "?" : formatRate(up.dropRate)} now`, upRole)),
					one(
						2,
						txt(
							`checked ${formatAge(now - Date.parse(up.lastCheckedAt))} ago`,
							upRole,
						),
					),
				]
			: resources && !hasHost
				? // No SDR host for this source: not applicable.
					[one(0, txt(`Pi rtlmux → core: ${glyphs().na}`, upRole))]
				: [one(0, txt("Pi rtlmux → core: ? (no SDR host data)", upRole))]
	return [
		essential(fitDot(lbl("FANOUT", true), head, width)),
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
	const t = receiverTuner(state)
	const gap = (): Row[] => (roomy ? [gapRow(9)] : [])
	const source = src
		? sourceBlock(state, src, width)
		: [
				essential(
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
				essential(
					clipped(
						lbl("TUNER", true),
						noData(state, "/api/tuner"),
						width,
						"label",
					),
				),
			]
	const relayHead = essential(
		relay
			? relayHeader(
					relay,
					width,
					isOld(state.relay, state.now) ? "old" : "value",
				)
			: clipped(
					lbl("RELAY", true),
					noData(state, "/api/tuner-relay"),
					width,
					"label",
				),
	)
	// Core says why the relay cannot serve this source, whether or not it listens (R72).
	const compat =
		relay?.compatibility !== undefined && relay.compatibility !== "ok"
			? keep([
					...lbl(""),
					glyphSpan("attention"),
					sp(
						` ${quoted(relay.compatibilityMessage ?? relay.compatibility, 80)}`,
						"attention",
					),
				])
			: null
	const fanout = fanoutBlock(state, width)
	// Short views shed optional rows (with a "+N rows hidden" marker); relay history
	// fills whatever height is left.
	const lines = shed(
		[
			...source,
			...gap(),
			...tuner,
			...gap(),
			relayHead,
			...(compat ? [compat] : []),
			...gap(),
			...fanout,
		],
		height,
	)
	const room = height - lines.length
	const history = relay && room > 0 ? historyRows(relay, room, width) : []
	const anchor =
		compat && lines.includes(compat.line) ? compat.line : relayHead.line
	const relayAt = lines.indexOf(anchor)
	if (relayAt >= 0) lines.splice(relayAt + 1, 0, ...history)
	return lines.slice(0, height)
}
