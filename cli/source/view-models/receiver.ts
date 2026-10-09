import { remoteHost } from "./net.js"
import { noDataText } from "./feed-state.js"
import type {
	TunerRelayStatus,
	TunerState,
	TunerStateField,
} from "@wavekit/api-types"
import { iqView, isFresh, isOld } from "../data/freshness.js"
import { aggregateDropNow, MIN_DROP_SPAN_MS } from "../data/rates.js"
import type {
	AppState,
	FanoutSample,
	GlyphRole,
	SourceRow,
} from "../data/types.js"
import {
	decoderMembership,
	followsCentre,
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
	COMMAND_NAME,
	FREQ_MAX,
	FREQ_MIN,
	editWindow,
	fieldValue,
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
import { LABEL_WIDTH } from "./detail.js"
import { essential, gapRow, keep, optional, shed, type Row } from "./shed.js"

const RESULT_MS = 10_000
const LABEL_W = LABEL_WIDTH
/** rtl_tcp header tuner types (librtlsdr enum rtlsdr_tuner). */
const TUNER_TYPES: Readonly<Record<number, string>> = {
	1: "E4000",
	2: "FC0012",
	3: "FC0013",
	4: "FC2580",
	5: "R820T",
	6: "R828D",
}
/** Bytes per sample (per channel) by wire format; "auto" has no nominal rate. */
const BYTES_PER_SAMPLE: Readonly<Record<string, number>> = {
	U8_IQ: 2,
	S16_IQ: 4,
	S16LE: 2,
	FLOAT32LE: 4,
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

/** R82: one no-data copy for every section. */
function noData(state: AppState, path: string): string {
	return noDataText(state, path)
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

/** The TunerState field behind each edit field (R84 unknownFields). */
const STATE_FIELD: Readonly<Record<EditField, TunerStateField>> = {
	frequency: "frequency",
	sampleRate: "sampleRate",
	gain: "gain",
	ppm: "ppm",
	gainMode: "gainMode",
	agc: "agcMode",
	biasTee: "biasTee",
	directSampling: "directSampling",
	offsetTuning: "offsetTuning",
}

/**
 * Fields core never commanded or observed (R84): their value is a placeholder and reads
 * "?". In edit mode a field stays unknown until the draft changes it, so an unknown
 * field is only sent when the operator sets it.
 */
function unknownOf(
	t: TunerState | undefined,
	edit: TunerEditState | null,
): (f: EditField) => boolean {
	const listed = new Set<string>(t?.unknownFields ?? [])
	return f =>
		listed.has(STATE_FIELD[f]) &&
		(edit === null ||
			fieldValue(edit.draft, f) === fieldValue(edit.original, f))
}

function tunerOf(state: AppState, sourceId: string): TunerState | undefined {
	return state.tuner.value?.find(x => x.sourceId === sourceId)
}

/** Host of "192.0.2.1:59430", "[2001:db8::1]:59430", "2001:db8::1:59430" or "::ffff:192.0.2.1:59430". */

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

/** The relay client holding tuner control (`relay client-3 192.0.2.1`), else null (S5). */
export function receiverController(state: AppState): string | null {
	return relayClient(state.relay.value, false)
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
	const where = `${src.id}${sep()}${src.type ?? "source"}${host ? ` ${host}` : ""}`
	// One state, one glyph: transport and activity collapse when they agree (M8).
	const link: GlyphRole = src.connected ? "live" : "fault"
	const linkWord = src.connected ? "connected" : "disconnected"
	const both = iq.glyph !== link && !iq.word.startsWith(linkWord)
	const detail =
		a === undefined
			? null
			: iq.word === "disconnected"
				? a.sampleAgeMs === null
					? null
					: `last sample ${formatSampleAge(a.sampleAgeMs)} ago`
				: `sample age ${formatSampleAge(a.sampleAgeMs)}${sep()}timeout ${Math.round(a.timeoutMs / 1000)} s`
	// The error code alone ("ECONNREFUSED") when the row is narrow; the message when it fits.
	const code = src.lastError
		? /\b(E[A-Z]{3,}|UND_ERR_[A-Z_]+)\b/.exec(sanitize(src.lastError))?.[1]
		: undefined
	const row1: Group[] = [
		one(0, txt(src.id, role), txt(where, role)),
		...(both ? [one(0, [glyphSpan(link), sp(` ${linkWord}`, role)])] : []),
		one(
			0,
			[glyphSpan(iq.glyph), sp(` ${iq.word}`, role)],
			...(detail
				? [[glyphSpan(iq.glyph), sp(` ${iq.word}${sep()}${detail}`, role)]]
				: []),
		),
		// Core resets both on connect: a count or an error belongs to the current state.
		...(src.reconnectAttempts > 0
			? [one(1, txt(`reconnect #${src.reconnectAttempts}`, role))]
			: []),
		...(src.lastError
			? [
					one(
						1,
						...(code ? [txt(`"${code}"`, role)] : []),
						txt(quoted(src.lastError, 24), role),
						txt(quoted(src.lastError, 60), role),
					),
				]
			: []),
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
	const fmt = `${formatMSps(src.caps.sampleRate)} ${src.caps.format.replace("_", " ")}`
	const perSample = own(BYTES_PER_SAMPLE, src.caps.format)
	const nominal =
		perSample === undefined
			? null
			: formatRate(src.caps.sampleRate * perSample * (src.caps.channels ?? 1))
	const row2: Group[] = [
		one(
			0,
			txt(rate, role),
			txt(`${rate} (${fmt})`, role),
			...(nominal
				? [txt(`${rate} (nominal ${nominal}${sep()}${fmt})`, role)]
				: []),
		),
		one(1, txt(`received ${formatBytes(src.bytesReceived)}`, role)),
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
		...(src.rateMismatch ? [keep(mismatchLine(src, width, role))] : []),
		optional(fitRow(lbl("rate"), row2, width), 2),
	]
}

/** "−50%", "+2.5%": the sign always, one decimal below 10 %. */
function signedPercent(ratio: number): string {
	const pct = ratio * 100
	const a = Math.abs(pct)
	const text = a < 10 ? a.toFixed(1).replace(/\.0$/, "") : String(Math.round(a))
	return `${pct < 0 ? glyphs().minus : "+"}${text}%`
}

/**
 * R84 rate-truth check, a warning only (core never corrects caps from it):
 * "rate mismatch · measured 1.024 MS/s vs declared 2.048 MS/s (−50%) since 18:07:52".
 */
function mismatchLine(src: SourceRow, width: number, role: Role): Line {
	const m = src.rateMismatch
	if (!m) return []
	const since = Date.parse(m.since)
	const lineRole: Role = role === "old" ? "old" : "attention"
	return [
		...lbl(""),
		glyphSpan("attention"),
		...fitGroups(
			[
				one(0, txt(" rate mismatch", lineRole)),
				one(
					0,
					txt(`measured ${formatMSps(m.measuredSampleRateHz)}`, lineRole),
					txt(
						`measured ${formatMSps(m.measuredSampleRateHz)} vs declared ${formatMSps(m.declaredSampleRateHz)} (${signedPercent(m.deviation)})`,
						lineRole,
					),
				),
				...(Number.isFinite(since)
					? [one(1, txt(`since ${formatClock(since)}`, lineRole))]
					: []),
			],
			Math.max(1, width - LABEL_W - 1),
			{ sep: sep() },
		),
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

/**
 * Pending row item: "frequency 445 970 700 → 446 000 000", "gain 0.0 → 20.7 dB".
 * `from` replaces a placeholder: "?" for a field core does not know, "index 11" for a
 * gain core gave only as an index, never "0.0" (M7, R84).
 */
export function changeText(c: PendingChange, from?: string): string {
	const to =
		c.field === "gain" && typeof c.to === "number"
			? formatDb(c.to)
			: plainValue(c.field, c.to)
	return `${FIELD_LABEL[c.field]} ${from ?? plainValue(c.field, c.from)} ${glyphs().arrow} ${to}`
}

/** "+10 Hz", "+29.3 kHz", "−1.5 MHz": the unit follows the magnitude, so a small step never reads +0.0. */
export function deltaText(hz: number): string {
	const sign = hz < 0 ? glyphs().minus : "+"
	const a = Math.abs(hz)
	const trim = (v: string): string => v.replace(/\.?0+$/, "")
	if (a < 1000) return `${sign}${Math.round(a)} Hz`
	const khz = (a / 1e3).toFixed(1)
	if (Number(khz) < 1000) return `${sign}${trim(khz)} kHz`
	return `${sign}${trim((a / 1e6).toFixed(3))} MHz`
}

/** The value a command sends: "446 000 000 Hz (+29.3 kHz)", "20.7 dB", "on". */
function confirmValue(c: PendingChange, fromKnown: boolean): string {
	if (c.field === "frequency" && typeof c.to === "number") {
		// No delta from a frequency core does not know (R84).
		return fromKnown && typeof c.from === "number"
			? `${formatHz(c.to)} (${deltaText(c.to - c.from)})`
			: formatHz(c.to)
	}
	if (c.field === "gain" && typeof c.to === "number") return formatDb(c.to)
	return plainValue(c.field, c.to)
}

/** Confirm item, named by the command core relays: "set-frequency 446 000 000 Hz (+29.3 kHz)". */
export function confirmItem(c: PendingChange, fromKnown = true): string {
	return `${COMMAND_NAME[c.field]} ${confirmValue(c, fromKnown)}`
}

/**
 * The review confirm; null when nothing changed or a field is out of core's range.
 * With `state` it also names the blast radius (spec §10.9). `groups` fit the bar by
 * priority (R71): the action, then a safety warning, then who enters or leaves, then
 * the tuned list. The y/n keys are reserved by confirmLine and never clipped (M6).
 */
export function tunerConfirm(
	edit: TunerEditState,
	state?: AppState,
): ConfirmRequest | null {
	const commands = pendingCommands(edit)
	if (commands.length === 0 || outOfRange(edit).length > 0) return null
	const changes = pendingChanges(edit)
	const n = commands.length
	const to = `to ${edit.sourceId}`
	const first = changes[0]
	const terse =
		n === 1 && first
			? `send ${COMMAND_NAME[first.field]} ${to}`
			: `send ${n} commands ${to}`
	const listed = new Set<string>(
		(state ? tunerOf(state, edit.sourceId) : undefined)?.unknownFields ?? [],
	)
	const action = `send ${changes.map(c => confirmItem(c, !listed.has(STATE_FIELD[c.field]))).join(", ")} ${to}`
	const bias = turnsBiasTeeOn(edit)
	const affects = state ? editImpact(state, edit) : null
	const extras = [
		...(bias ? ["bias-t supplies DC on the antenna port"] : []),
		...(affects ? [`affects ${affectsJoin(affects)}`] : []),
	]
	const groups: Group[] = [
		one(
			0,
			[sp(`send ${n} ${to}`, "value", true)],
			[sp(terse, "value", true)],
			[sp(action, "value", true)],
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
						[sp(affects.count, "value")],
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
		prompt: action,
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
	const relay = state.relay.value
	const client = relayClient(relay, false)
	const who = client ?? "external clients"
	const id = relay?.controlClientId
		? `relay ${sanitize(relay.controlClientId)}`
		: who
	const shortWho = relay?.controlClientId
		? sanitize(relay.controlClientId)
		: "external clients"
	const its = client ? "its" : "their"
	// Spec §6.4 at its widest; R71: narrower bars shorten the action before the safety
	// clause, down to a bare "take control?", so the clause survives any client id.
	const ask = (q: string, clause: string): Line => [
		sp(`${q} `, "value", true),
		sp(clause, "attention", true),
	]
	const prompt = `take tuner control from ${who}? ${its} next tuning command is refused`
	const groups: Group[] = toInternal
		? [
				one(
					0,
					ask("take control?", "next command refused"),
					ask("take control?", `${its} next command is refused`),
					ask(
						`take control from ${shortWho}?`,
						`${its} next command is refused`,
					),
					ask(
						`take tuner control from ${id}?`,
						`${its} next tuning command is refused`,
					),
					ask(
						`take tuner control from ${who}?`,
						`${its} next tuning command is refused`,
					),
				),
			]
		: [
				one(0, [
					sp("release tuner control to external clients?", "value", true),
				]),
			]
	return {
		kind: "control",
		prompt: toInternal ? prompt : "release tuner control to external clients?",
		groups,
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
 * "set-frequency sent · no reply in 10s"; no-reply (terminal) → "set-frequency sent · no
 * reply"; ok → "set-frequency ok 18:07:52", "control taken 18:07:52"; failed →
 * `set-frequency failed · 409 · "…" · set-gain not sent`.
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
	const control =
		rec.intent.kind === "tuner"
			? rec.intent.commands.find(c => c.setting === "control-mode")
			: undefined
	const parts = rec.outcomes.map((o, i) => {
		const r = o.result
		if (r === null) return `${o.label} not sent`
		// An unknown command that an event confirmed reads ok, at the confirmation time.
		if (r.outcome === "ok" || (r.outcome === "unknown" && rec.state === "ok")) {
			const at = r.outcome === "ok" ? o.at : rec.confirmedAt
			const done =
				control !== undefined
					? `control ${control.body["mode"] === "internal" ? "taken" : "released"}`
					: `${o.label} ok`
			return `${done}${i === 0 && at !== null ? ` ${formatClock(at)}` : ""}`
		}
		if (r.outcome === "unknown")
			return rec.state === "no-reply"
				? `${o.label} sent${sep()}no reply`
				: `${o.label} sent${sep()}no reply in ${Math.round(RESULT_MS / 1000)}s`
		return `${o.label} failed${sep()}${r.status ?? "network"}${sep()}${quoted(r.message, 60)}`
	})
	return parts.join(sep())
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
		// R40 for older cores only; under core's assessment it places every type (R90).
		if (followsCentre(d)) {
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
	// A grid of ids, two spaces apart; the tuned group keeps its own " · " clause.
	const grid = (ids: string[]): string => ids.join("  ")
	const ins = [
		...(inside.length > 0 ? [grid(inside)] : []),
		...(tuned.length > 0 ? [`${grid(tuned)} (tuned)`] : []),
	]
	return {
		inside: ins.join(sep()) || na,
		outside: grid(outside) || na,
		unknown: grid(unknown),
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
	/** Tersest: a count ("3 decoders move"), so a move never vanishes at 80 columns. */
	count: string
}

function affectsParts(impact: RetuneImpact, fromKnown: boolean): Affects {
	const tuned =
		impact.tuned.length > 0 ? `${impact.tuned.join(", ")} (tuned)` : null
	if (!fromKnown)
		return {
			tuned,
			moves: "window now ?",
			short: "window now ?",
			count: "window now ?",
		}
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
	const n = moves.length
	const unknownNote =
		impact.unknown.length > 0 ? `${impact.unknown.length} ?` : ""
	return {
		tuned,
		moves: parts.join(sep()),
		short: moved ? parts.join(sep()) : "no decoder enters or leaves",
		count: moved
			? [
					n > 0 ? `${n} decoder${n === 1 ? " moves" : "s move"}` : "",
					unknownNote,
				]
					.filter(Boolean)
					.join(sep())
			: "no decoder enters or leaves",
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
		return {
			tuned: null,
			moves: "decoders ?",
			short: "decoders ?",
			count: "decoders ?",
		}
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

function pendingLine(
	edit: TunerEditState,
	width: number,
	fromText: (f: EditField) => string | undefined,
): Line {
	const changes = pendingChanges(edit)
	if (changes.length === 0)
		return clipped(lbl("pending"), glyphs().na, width, "label")
	const bad = new Set(outOfRange(edit))
	const spans: Line = []
	changes.forEach((c, i) => {
		if (i > 0) spans.push(sp(sep(), "label"))
		if (bad.has(c.field))
			spans.push(
				sp(
					`${changeText(c, fromText(c.field))} (${rangeNote()})`,
					"attention",
					true,
				),
			)
		else spans.push(sp(changeText(c, fromText(c.field)), "value"))
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
	// "?" for a field core never commanded or observed, until the draft sets it (R84).
	const unknown = unknownOf(t, edit)
	const placeholder = unknownOf(t, null)
	// windowFor skips listed fields itself (R86), falling back to caps or the relay.
	const current = windowFor(
		t.sourceId,
		state.tuner.value,
		state.sources.value,
		relay,
	)
	const draftKnown = !unknown("frequency") && !unknown("sampleRate")
	const win: TunedWindow | null =
		edit && draftKnown ? draftWindow(edit) : current
	const focus = (f: EditField): Role =>
		edit && edit.field === f ? "accent" : role
	const d = edit?.draft
	const q = (f: EditField, text: string): string => (unknown(f) ? "?" : text)
	const freqCell: Line = edit
		? unknown("frequency")
			? [
					...(edit.field === "frequency" ? [sp(glyphs().cursor, "edit")] : []),
					sp("? Hz", edit.field === "frequency" ? "accent" : role),
				]
			: withCursor(edit.draft.frequency, edit.digit, edit.field === "frequency")
		: txt(unknown("frequency") ? "? Hz" : formatHz(t.frequency), role)
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
							`sample rate ${q("sampleRate", formatSps(d?.sampleRate ?? t.sampleRate))}`,
							focus("sampleRate"),
						),
					),
					one(2, txt(`ppm ${q("ppm", String(d?.ppm ?? t.ppm))}`, focus("ppm"))),
				],
				width,
			),
		),
	)
	const gainMode = d?.gainMode ?? t.gainMode
	const tunerType = relay?.rtlTcpHeader
		? own(TUNER_TYPES, String(relay.rtlTcpHeader.tunerType))
		: undefined
	const indexText =
		t.tunerGainIndex !== undefined
			? `index ${t.tunerGainIndex}${tunerType ? ` (${tunerType})` : ""}`
			: undefined
	// A core without unknownFields reports a gain set by index as 0 dB: the dB value is
	// unknown there too. The editor keeps the view's text until the gain changes (M7).
	const gainUnchanged = !d || d.gainTenthsDb === edit?.original.gainTenthsDb
	const dbUnknown =
		unknown("gain") ||
		(t.tunerGainIndex !== undefined && t.gain === 0 && gainUnchanged)
	const dbText = dbUnknown
		? (indexText ?? "?")
		: formatDb(d ? d.gainTenthsDb : t.gain)
	const gainText = unknown("gainMode")
		? `mode ?${sep()}${dbText}`
		: gainMode === "agc"
			? "agc"
			: `manual${sep()}${dbText}`
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
					one(
						1,
						txt(
							`rtl agc ${q("agc", onOff(d?.agc ?? t.agcMode))}`,
							focus("agc"),
						),
					),
					one(
						1,
						txt(
							`bias-t ${q("biasTee", onOff(d?.biasTee ?? t.biasTee))}`,
							focus("biasTee"),
						),
					),
					one(
						2,
						txt(
							`direct sampling ${q("directSampling", d?.directSampling ?? t.directSampling)}`,
							focus("directSampling"),
						),
					),
					one(
						2,
						txt(
							`offset tuning ${q("offsetTuning", onOff(d?.offsetTuning ?? t.offsetTuning))}`,
							focus("offsetTuning"),
						),
					),
				],
				width,
			),
		),
	)
	if (edit) {
		const byIndexFrom =
			t.tunerGainIndex !== undefined && t.gain === 0
				? `index ${t.tunerGainIndex}`
				: undefined
		rows.push(
			keep(
				pendingLine(edit, width, f =>
					f === "gain" && (placeholder("gain") || byIndexFrom)
						? (byIndexFrom ??
							(t.tunerGainIndex !== undefined
								? `index ${t.tunerGainIndex}`
								: "?"))
						: placeholder(f)
							? "?"
							: undefined,
				),
			),
		)
		rows.push(keep(clipped(lbl("affects"), editAffects(state, edit), width)))
		return rows
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
					`${relay.clientsConnected} client${relay.clientsConnected === 1 ? "" : "s"}${sep()}max ${relay.maxClients ?? "?"}`,
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
							`Pi rtlmux ${glyphs().arrow} core: ${formatBytes(up.bytesDroppedUpstream)} dropped lifetime (${up.dropPercent.toFixed(2)}%)`,
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
					[
						one(
							0,
							txt(`Pi rtlmux ${glyphs().arrow} core: ${glyphs().na}`, upRole),
						),
					]
				: [
						one(
							0,
							txt(
								`Pi rtlmux ${glyphs().arrow} core: ? (no SDR host data)`,
								upRole,
							),
						),
					]
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
	const compatRole: Role = isOld(state.relay, state.now) ? "old" : "attention"
	const compat =
		relay?.compatibility !== undefined && relay.compatibility !== "ok"
			? keep(
					clipped(
						[...lbl(""), glyphSpan("attention")],
						` ${quoted(relay.compatibilityMessage ?? relay.compatibility, 200)}`,
						width - 1,
						compatRole,
					),
				)
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

export { remoteHost }
