// The tuned card's "On this band" table: one row per decoder whose band holds the card's frequency, read from GET
// /api/decoders/summary?hz= (the core says which decoders cover it: `coversHz`). Columns: decoder (name and
// program), state (one word), last decode (links to Activity), detail (the verdict's reason) and at most one
// action. Pure: the card renders the rows and carries the action out.
import type { DecoderInfo, ScanRange } from "@wavekit/api-types"

import type { CategoryChipId } from "../activity/search.ts"
import {
	actionFor,
	onBand,
	parseVerdict,
	type ActionContext,
	type BandAction,
	type BandVerdict,
} from "./band-decoders.ts"
import { agoText } from "./now.ts"
import { decoderLabel } from "./signal.ts"

/** One summary item as the table reads it; fields an older core lacks are null. */
export interface SummaryItem {
	id: string
	/** The core's plain name, else the app's label for the program. */
	name: string
	/** The program (adapter type): "readsb", "multimon-ng". */
	protocol: string
	verdict: BandVerdict
	/** Last output, ms since the epoch; null when it never decoded (or the time is unreadable). */
	lastOutputAt: number | null
	eventsOut: number
	/** The core's answer for the asked frequency; null from a core without `coversHz`. */
	coversHz: boolean | null
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v)

/** Upper bound on a name the table shows, in UTF-16 code units: a decoder name is a word or two. */
export const NAME_MAX_LENGTH = 40

function text(v: unknown, max: number): string | null {
	if (typeof v !== "string") return null
	const t = v.trim()
	return t === "" ? null : t.slice(0, max)
}

/**
 * GET /api/decoders/summary body → items, read leniently: an item without an id, a program or a
 * usable verdict is left out; a malformed time reads "never", a malformed count 0, a missing or
 * malformed `coversHz` null. Null when the body is not a list.
 */
export function parseSummary(body: unknown): SummaryItem[] | null {
	if (!Array.isArray(body)) return null
	const out: SummaryItem[] = []
	for (const raw of body as unknown[]) {
		if (!isRecord(raw)) continue
		const id = text(raw["id"], 200)
		const protocol = text(raw["protocol"], 200)
		const verdict = parseVerdict(raw["verdict"])
		if (id === null || protocol === null || verdict === null) continue
		const last =
			typeof raw["lastOutputAt"] === "string"
				? Date.parse(raw["lastOutputAt"])
				: NaN
		const events = raw["eventsOut"]
		const covers = raw["coversHz"]
		out.push({
			id,
			name:
				text(raw["name"], NAME_MAX_LENGTH) ??
				decoderLabel(protocol).slice(0, NAME_MAX_LENGTH),
			protocol,
			verdict,
			lastOutputAt: Number.isFinite(last) ? last : null,
			eventsOut:
				typeof events === "number" && Number.isFinite(events) && events > 0
					? Math.floor(events)
					: 0,
			coversHz: typeof covers === "boolean" ? covers : null,
		})
	}
	return out
}

/** A decoder's row state, one word each (DecoderVerdictCode folded). */
export type RowState =
	| "decoding"
	| "listening"
	| "starting"
	| "waiting"
	| "paused"
	| "failed"
	| "off"
	| "unknown"

export const STATE_WORD: Readonly<Record<RowState, string>> = {
	decoding: "Decoding",
	listening: "Listening",
	starting: "Starting",
	waiting: "Waiting",
	paused: "Paused",
	failed: "Failed",
	off: "Off",
	unknown: "Unknown",
}

/** Table order: what decodes first, then what is on its way, then what needs a hand, then what is off. */
const STATE_ORDER: readonly RowState[] = [
	"decoding",
	"listening",
	"starting",
	"failed",
	"paused",
	"waiting",
	"off",
	"unknown",
]

/** The row state of a verdict code; a code this app does not know reads "unknown". */
export function stateOf(code: BandVerdict["code"]): RowState {
	switch (code) {
		case "decoding":
		case "listening":
		case "starting":
		case "failed":
			return code
		case "off":
		case "stopped":
		case "decoder-unavailable":
			return "off"
		case "out-of-band":
		case "no-channel":
		case "capture-too-narrow":
		case "source-unavailable":
		case "efficiency-waiting":
			return "waiting"
		case "unsupported-rate":
		case "scanner-busy":
		case "efficiency-budget":
		case "efficiency-cpu":
		case "efficiency-drops":
		case "efficiency-late-drops":
		case "channelizer-unavailable":
			return "paused"
		default:
			return "unknown"
	}
}

/** "1 message", "1,204 messages". */
function messages(n: number): string {
	return `${n.toLocaleString("en-GB")} message${n === 1 ? "" : "s"}`
}

const STATE_LEAD =
	/^(?:decoding|listening|starting|waiting|paused|failed|unavailable)\s*[:;]\s*/i

/** Details that say no more than the state column, beyond the state word itself (lower case). */
const RESTATES: Readonly<Record<RowState, readonly string[]>> = {
	decoding: ["running"],
	listening: ["running"],
	starting: [],
	waiting: [],
	paused: [],
	failed: ["failed to run"],
	off: [],
	unknown: ["status unknown"],
}

/**
 * The verdict's reason without what the other columns say: the decoder's name ("ADS-B paused: CPU budget
 * full" → "CPU budget full") and a leading state word followed by a colon. A state word that runs on into the
 * reason stays ("ADS-B waiting for the source" → "Waiting for the source"). A verdict that only restates its
 * state ("ADS-B decoding", "ADS-B failed to run") says how much it decoded instead, else nothing.
 */
export function detailOf(
	verdictText: string,
	name: string,
	state: RowState,
	eventsOut: number,
): string {
	let t = verdictText.trim()
	for (const lead of [name, "Decoder"])
		if (t.startsWith(`${lead} `)) {
			t = t.slice(lead.length + 1)
			break
		}
	t = t.replace(STATE_LEAD, "").trim()
	const said = t.toLowerCase()
	if (
		t === "" ||
		said === STATE_WORD[state].toLowerCase() ||
		RESTATES[state].includes(said)
	)
		return eventsOut > 0 && (state === "decoding" || state === "listening")
			? `${messages(eventsOut)} so far`
			: ""
	return t.charAt(0).toUpperCase() + t.slice(1)
}

/**
 * The row's one action, or null. A Settings link never sits in a row (the section's foot has one); a start
 * is offered only to a stopped decoder and a restart only to a failed one whose verdict still asks for it
 * (the core drops it while it restarts on its own), so a starting or waiting decoder is never restarted.
 */
export function rowAction(
	verdict: BandVerdict,
	decoder: DecoderInfo | null,
	ctx: ActionContext,
): BandAction | null {
	if (verdict.code === "unknown" || decoder === null) return null
	// off in Settings: the foot's link turns it on, whatever an older verdict still says
	if (decoder.mode === "off") return null
	for (const a of verdict.actions) {
		if (a === "start" && verdict.code !== "stopped") continue
		if (a === "restart" && verdict.code !== "failed") continue
		const view = actionFor(a, decoder, ctx)
		if (view === null || view.kind === "settings") continue
		return view
	}
	return null
}

/**
 * The Activity chip a program's messages fall under (Activity's category chips); null when none fits. "Last
 * decode" opens Activity on this chip: Activity's search has no decoder token yet (the core's query takes
 * `decoderIds`, the drawer's tokens do not), so the chip is the closest filter it offers.
 */
const CHIP: Readonly<Record<string, CategoryChipId>> = {
	readsb: "aircraft",
	dump1090: "aircraft",
	acarsdec: "aircraft",
	dumpvdl2: "aircraft",
	"ais-catcher": "marine",
	"multimon-ng": "paging",
	"dsd-fme": "voice",
	direwolf: "aprs",
	rtl433: "sensors",
	"lora-meshtastic": "mesh",
}

export function activityChipFor(protocol: string): CategoryChipId | null {
	return Object.hasOwn(CHIP, protocol) ? CHIP[protocol]! : null
}

export interface BandTableRow {
	id: string
	name: string
	protocol: string
	state: RowState
	stateWord: string
	/** "38 s ago", "3 min ago", "at 13:52"; "Never" when it has not decoded. */
	lastDecode: string
	/** ISO time of the last decode, for a <time> element; null when never. */
	lastDecodeIso: string | null
	/** The Activity chip "Last decode" opens; null when it decoded nothing or no chip fits. */
	activityChip: CategoryChipId | null
	detail: string
	action: BandAction | null
}

/** The band plan ranges the status fallback reads (planRangesOf); null while not loaded. */
export type PlanRanges = readonly Pick<
	ScanRange,
	"startHz" | "endHz" | "protocols"
>[]

/**
 * Whether an item belongs on the card at `hz`: the core's `coversHz` when it sent one; from an older
 * core or the statuses standing in for a failed read, the core's rule over the decoder's own band
 * (onBand, with the band plan for decoders without a band). Unknown decoders are left out.
 */
export function relevant(
	item: Pick<SummaryItem, "id" | "coversHz">,
	decoder: DecoderInfo | null,
	hz: number,
	planRanges: PlanRanges | null = null,
): boolean {
	if (item.coversHz !== null) return item.coversHz
	return decoder !== null && onBand(decoder, hz, planRanges)
}

/**
 * The verdict the row shows: the summary's, unless the decoder's current status says it is off in Settings or
 * stopped while the verdict (read up to a poll earlier) still says otherwise. A failure the core reports stays (its
 * precedence puts a failure first); the core's next read agrees with the override.
 */
export function currentVerdict(
	verdict: BandVerdict,
	decoder: DecoderInfo | null,
	name: string,
): BandVerdict {
	if (decoder === null || verdict.code === "failed") return verdict
	if (decoder.mode === "off")
		return verdict.code === "off"
			? verdict
			: { code: "off", text: `${name} off in Settings`, actions: ["turn-on"] }
	if (
		decoder.desiredRunning === false &&
		!decoder.running &&
		verdict.code !== "stopped"
	)
		return { code: "stopped", text: `${name} stopped`, actions: ["start"] }
	return verdict
}

/** A status-only verdict for a core without the summary route: no action, a plain sentence. */
function statusVerdict(d: DecoderInfo): BandVerdict {
	const name = decoderLabel(d.type)
	if (d.mode === "off")
		return { code: "off", text: `${name} off in Settings`, actions: [] }
	if (d.health === "faulted" || d.health === "restarting")
		return { code: "failed", text: `${name} failed to run`, actions: [] }
	if (d.running && !d.suspended)
		return { code: "listening", text: `${name} running`, actions: [] }
	if (d.suspended)
		return { code: "unknown", text: `${name} paused`, actions: [] }
	return { code: "unknown", text: `${name} not running`, actions: [] }
}

/** Summary-shaped items from GET /api/decoders alone (a core without the summary route). */
export function itemsFromStatus(
	decoders: readonly DecoderInfo[],
): SummaryItem[] {
	return decoders.map(d => {
		const last = d.lastOutputAt ? Date.parse(d.lastOutputAt) : NaN
		return {
			id: d.id,
			name: decoderLabel(d.type),
			protocol: d.type,
			verdict: statusVerdict(d),
			lastOutputAt: Number.isFinite(last) ? last : null,
			eventsOut: d.stats.eventsOut,
			coversHz: null,
		}
	})
}

/**
 * The table's rows: the decoders whose band holds `hz`, ordered by state (STATE_ORDER), then by name.
 * `items` null (a core without the summary route, or a failed read) reads the statuses instead, with
 * `planRanges` for decoders without a band of their own. A current status off or stopped wins over a
 * retained verdict (currentVerdict). Scanner probes never show.
 */
export function bandTable(
	items: readonly SummaryItem[] | null,
	decoders: readonly DecoderInfo[],
	hz: number,
	ctx: ActionContext,
	now: number,
	planRanges: PlanRanges | null = null,
): BandTableRow[] {
	const byId = new Map(decoders.map(d => [d.id, d]))
	const source = items ?? itemsFromStatus(decoders)
	const rows: BandTableRow[] = []
	for (const item of source) {
		const decoder = byId.get(item.id) ?? null
		if (decoder?.owner === "scanner") continue
		if (!relevant(item, decoder, hz, planRanges)) continue
		const verdict = currentVerdict(item.verdict, decoder, item.name)
		const state = stateOf(verdict.code)
		const iso =
			item.lastOutputAt === null
				? null
				: new Date(item.lastOutputAt).toISOString()
		rows.push({
			id: item.id,
			name: item.name,
			protocol: item.protocol,
			state,
			stateWord: STATE_WORD[state],
			lastDecode: iso === null ? "Never" : agoText(iso, now) || "Never",
			lastDecodeIso: iso,
			activityChip: iso === null ? null : activityChipFor(item.protocol),
			detail: detailOf(verdict.text, item.name, state, item.eventsOut),
			action: rowAction(verdict, decoder, ctx),
		})
	}
	rows.sort(
		(a, b) =>
			STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state) ||
			a.name.localeCompare(b.name, "en"),
	)
	return rows
}

/** Said instead of the demodulator and "Quiet" where the band plan's mode is RAW (decoders only) or the receiver is RAW. */
export const DATA_BAND_LINE = "No audio (data band)"

/** Live states: the row's dot is filled and accented. */
export const LIVE_STATES: ReadonlySet<RowState> = new Set([
	"decoding",
	"listening",
])

/**
 * The header's line for the decoders on this band: "ADS-B · Decoding", "ADS-B · Paused", or with more
 * than one, the first (table order) and how many others ("Pager · Listening · +1"). Null without rows.
 */
export function bandStateLine(rows: readonly BandTableRow[]): string | null {
	const first = rows[0]
	if (!first) return null
	const more = rows.length > 1 ? ` · +${rows.length - 1}` : ""
	return `${first.name} · ${first.stateWord}${more}`
}

/** Where the foot's "Decoder settings" link lands: the first row's decoder page, else the decoders group. */
export function settingsTarget(rows: readonly BandTableRow[]): string {
	const needs = rows.find(r => r.state === "off") ?? rows[0]
	return needs ? `dec.${needs.id}` : "dec.cpuBudgetCores"
}

/** The summary's request path for a frequency (`?hz=` asks the core which decoders cover it). */
export function summaryPath(hz: number | null): string {
	return hz !== null && Number.isFinite(hz) && hz > 0
		? `/api/decoders/summary?hz=${Math.round(hz)}`
		: "/api/decoders/summary"
}

export interface IdentityInput {
	/** The protocol of what was last heard on the channel (now.ts), else null. */
	heard: string | null
	/** What Identify named here, this session's answer or a proven discovery's, else null. */
	named: { proto: string; sub: string } | null
	/** The table's rows: the decoders whose band holds the frequency, in table order. */
	rows: readonly Pick<BandTableRow, "name" | "state">[]
	/** The band plan's band and channel at the frequency, else null. */
	band: string | null
	channel: string | null
	/** The receiver's demodulator ("NFM"), else null. */
	modeLabel: string | null
}

/**
 * What the card's header says the signal is, most specific first: the protocol heard, what Identify named (or a
 * proven discovery), the decoder whose band holds the frequency, the band plan's band, the demodulator. A decoder
 * whose band does not hold the frequency never names it (it is not in `rows`). A decoder that is off names it only
 * without a band plan band, and says so ("Pager (off)"): the band names what is there better than a decoder that
 * is not listening. `sub` adds the band (unless it is already the name), the channel and the named detail.
 */
export function cardIdentity(input: IdentityInput): {
	proto: string
	sub: string
} {
	const lead = input.rows[0]
	const decoder =
		lead === undefined
			? null
			: lead.state !== "off"
				? lead.name
				: input.band === null
					? `${lead.name} (off)`
					: null
	const fromBand =
		input.heard === null &&
		input.named === null &&
		decoder === null &&
		input.band !== null
	const proto =
		input.heard ??
		input.named?.proto ??
		decoder ??
		(fromBand ? input.band : null) ??
		input.modeLabel ??
		"Unknown"
	const sub = [
		fromBand ? null : input.band,
		input.channel,
		input.named?.sub || null,
	]
		.filter((s): s is string => s !== null && s !== "")
		.join(" · ")
	return { proto, sub }
}
