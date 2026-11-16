// One naming rule for every surface (band tags, signal chips, the tuned card, Activity rows, Recordings, the
// palette): what a channel is called, how sure we are, how its frequency reads and what a transmission on it
// is titled. A saved frequency's name renames its channel everywhere: it is matched by raster frequency
// (`savedNameAt`), so a row whose measured carrier sits off the raster still finds it. `showChannel` is the one
// door from a frequency to its history: the raster frequency and half a raster step, never a signal's
// bandwidth, under a chip that states its width.
import type { Discovery, SavedFrequency } from "@wavekit/api-types"

import { Store, useStore } from "../data/store.ts"
import { DEFAULT_STEP_HZ } from "../plot/maths.ts"
import { shellStore } from "../shell/store.ts"
import type { ActivityController } from "./activity/controller.ts"
import type { SearchToken } from "./activity/search.ts"
import { token } from "./activity/search.ts"

// ---- protocol spelling

/**
 * How every surface spells a protocol, by the ids the core uses (scanner protocols, Activity `protocol`,
 * decoder families). "NFM" is a demodulator setting only; "FM voice" is what was heard.
 */
export const PROTOCOL_SPELLING: Readonly<Record<string, string>> = {
	"analog-fm": "FM voice",
	"analog-am": "AM voice",
	dmr: "DMR",
	p25: "P25",
	p25p1: "P25",
	p25p2: "P25",
	nxdn: "NXDN",
	nxdn48: "NXDN",
	nxdn96: "NXDN",
	ysf: "YSF",
	dstar: "D-STAR",
	"d-star": "D-STAR",
	dpmr: "dPMR",
	pocsag: "POCSAG",
	flex: "FLEX",
	aprs: "APRS",
	ism: "ISM",
	lora: "LoRa",
	meshtastic: "Meshtastic",
	ais: "AIS",
	acars: "ACARS",
	vdl2: "VDL2",
	adsb: "ADS-B",
	"ads-b": "ADS-B",
	"digital-unknown": "Digital",
	carrier: "Carrier",
	nfm: "NFM",
	wfm: "WFM",
	am: "AM",
	fm: "FM",
	usb: "USB",
	lsb: "LSB",
}

/** "D-STAR" for "dstar", "DSTAR" or "d_star"; null for an id the table does not know. */
export function protocolSpelling(id: string | null | undefined): string | null {
	if (typeof id !== "string") return null
	const key = id.trim().toLowerCase().replace(/_/g, "-")
	if (Object.hasOwn(PROTOCOL_SPELLING, key))
		return PROTOCOL_SPELLING[key] ?? null
	const bare = key.replace(/-/g, "")
	return Object.hasOwn(PROTOCOL_SPELLING, bare)
		? (PROTOCOL_SPELLING[bare] ?? null)
		: null
}

/** What a proven protocol is to the user, when the protocol alone says it ("POCSAG pager"). */
const ROLE: Readonly<Record<string, string>> = {
	POCSAG: "pager",
	FLEX: "pager",
}

// ---- frequency

/**
 * The channel a frequency sits on: the nearest raster value when it is less than a quarter step from it, else the
 * frequency itself in whole Hz (off channel). Idempotent: a raster value maps to itself.
 */
export function rasterHz(hz: number, stepHz: number = DEFAULT_STEP_HZ): number {
	const step = Number.isFinite(stepHz) && stepHz > 0 ? stepHz : DEFAULT_STEP_HZ
	const whole = Math.round(hz)
	const snapped = Math.round(Math.round(whole / step) * step)
	return Math.abs(snapped - whole) < step / 4 ? snapped : whole
}

/** What a frequency that is not a finite number reads as, never "NaN". */
export const NO_FREQUENCY = "—"

/** A channel's frequency in MHz, 4 decimals, from the raster ("145.6125"); NO_FREQUENCY when not finite. */
export function channelMHz(
	hz: number,
	stepHz: number = DEFAULT_STEP_HZ,
): string {
	if (!Number.isFinite(hz)) return NO_FREQUENCY
	return (rasterHz(hz, stepHz) / 1e6).toFixed(4)
}

/** "±6.25 kHz", "±3.125 kHz", "±500 Hz": the width a channel filter matches, stated on its chip. */
export function halfWidthText(spanHz: number): string {
	const hz = Number.isFinite(spanHz) ? Math.max(0, Math.round(spanHz)) : 0
	if (hz < 1000) return `±${hz} Hz`
	const khz = (hz / 1000).toFixed(3).replace(/\.?0+$/, "")
	return `±${khz} kHz`
}

// ---- saved names

type SavedName = Pick<SavedFrequency, "frequencyHz" | "name">

/** The saved frequency names the app knows now (fed by followSavedNames). */
export const savedNames = new Store<readonly SavedName[]>([])

/**
 * Subscribes a component to the saved names, so a memoised row re-renders when a name is saved, renamed or
 * removed (the names are read through `savedNameAt`'s default). Returns the current list.
 */
export function useSavedNames(): readonly SavedName[] {
	return useStore(savedNames)
}

/** Keeps `savedNames` in step with the saved-frequency store; returns the unsubscribe. */
export function followSavedNames(store: {
	get(): { items: readonly SavedName[] }
	subscribe(fn: (s: { items: readonly SavedName[] }) => void): () => void
}): () => void {
	savedNames.set(store.get().items)
	return store.subscribe(s => savedNames.set(s.items))
}

/**
 * The saved name of the channel at `hz` on the band's raster `stepHz`: the nearest saved frequency less than half a
 * step away (a measured carrier off the raster still finds its channel, a neighbouring channel is never it), else
 * null. Blank names count as none.
 */
export function savedNameAt(
	hz: number | null | undefined,
	saved: readonly SavedName[] = savedNames.get(),
	stepHz: number = DEFAULT_STEP_HZ,
): string | null {
	if (typeof hz !== "number" || !Number.isFinite(hz)) return null
	const step = Number.isFinite(stepHz) && stepHz > 0 ? stepHz : DEFAULT_STEP_HZ
	let best: SavedName | null = null
	for (const f of saved) {
		const off = Math.abs(f.frequencyHz - hz)
		if (!(off < step / 2) || !f.name.trim()) continue
		if (!best || off < Math.abs(best.frequencyHz - hz)) best = f
	}
	return best ? best.name.trim() : null
}

// ---- channel name

export interface ChannelNameParts {
	/** The user's saved name for the channel. */
	saved?: string | null
	/** The operator's label on the discovery. */
	label?: string | null
	/** A proven protocol: an id ("dstar") or the proven title already composed ("DMR · CC 1"). */
	proven?: string | null
	/** A likely protocol (id or spelling); reads "Likely DMR". */
	likely?: string | null
	/** The measured shape ("FM ~25 kHz"); reads "Unidentified · FM ~25 kHz". */
	shape?: string | null
}

const filled = (s: string | null | undefined): string | null => {
	const t = typeof s === "string" ? s.trim() : ""
	return t.length > 0 ? t : null
}

/** "POCSAG pager" for "pocsag", "D-STAR" for "dstar"; an already composed title stays as given. */
function provenName(proven: string): string {
	const spelled = protocolSpelling(proven)
	if (spelled === null) return proven
	const role = ROLE[spelled]
	return role ? `${spelled} ${role}` : spelled
}

/**
 * A channel's name, the first that exists: the saved name, the operator label, the proven protocol and role
 * ("POCSAG pager", "FM voice"), the likely one ("Likely DMR"), the shape ("Unidentified · FM ~25 kHz"). Never
 * empty: with nothing known it reads "Unidentified".
 */
export function channelName(p: ChannelNameParts): string {
	const saved = filled(p.saved)
	if (saved) return saved
	const label = filled(p.label)
	if (label) return label
	const proven = filled(p.proven)
	if (proven) return provenName(proven)
	const likely = filled(p.likely)
	if (likely) {
		const spelled = protocolSpelling(likely) ?? likely
		return /^likely\b/i.test(spelled) ? spelled : `Likely ${spelled}`
	}
	const shape = filled(p.shape)
	return shape ? `Unidentified · ${shape}` : "Unidentified"
}

// ---- confidence

export type ConfidenceWord =
	| "Decoded"
	| "Voice heard"
	| "Likely"
	| "Unidentified"

const UNNAMED: ReadonlySet<string> = new Set([
	"unknown",
	"carrier",
	"digital-unknown",
])

/**
 * The one word beside a channel's name, the same four everywhere, from the discovery's proof and evidence level
 * (the band tags' states): Decoded (a proven decoded proof, or a decoded discovery from a core without proofs),
 * Voice heard (a proven analog voice or tone proof), Unidentified (only activity, or no protocol named), else
 * Likely. A weak, missing or malformed evidence level never reads Decoded or Voice heard.
 */
export function confidenceWord(
	d: Pick<Discovery, "confidence" | "protocol"> &
		Partial<Pick<Discovery, "proof" | "evidenceLevel">>,
): ConfidenceWord {
	const named = !UNNAMED.has(d.protocol)
	const kind = d.proof?.kind
	const proven = d.evidenceLevel === "proven"
	const legacy =
		d.evidenceLevel === undefined &&
		d.proof === undefined &&
		d.confidence === "decoded"
	if (named && ((proven && kind === "decoded") || legacy)) return "Decoded"
	if (named && proven && (kind === "analog-voice" || kind === "analog-tone"))
		return "Voice heard"
	if (d.confidence === "activity" || !named) return "Unidentified"
	return "Likely"
}

// ---- transmission title

export interface TransmissionParts {
	/** Who spoke or sent it (a callsign, a radio id). */
	from?: string | null
	/** To whom, when known (a talkgroup, "CQ"). */
	to?: string | null
	/** What it was when nobody is known ("FM voice", "Page"). */
	what?: string | null
}

/** "F5… → CQ", "TG 2081", "F5…"; else what it was ("FM voice"); never empty ("Transmission"). */
export function transmissionTitle(p: TransmissionParts): string {
	const from = filled(p.from)
	const to = filled(p.to)
	if (from && to) return `${from} → ${to}`
	if (from) return from
	if (to) return to
	return filled(p.what) ?? "Transmission"
}

/** A transmission's subtitle: channel name (when it is not the title) · frequency · duration. */
export function transmissionSubtitle(parts: {
	title: string
	channel: string | null
	frequency: string | null
	duration: string | null
}): string {
	return [
		parts.channel !== null && parts.channel !== parts.title
			? parts.channel
			: null,
		parts.frequency,
		parts.duration,
	]
		.filter((p): p is string => p !== null && p.length > 0)
		.join(" · ")
}

// ---- the channel door

export interface ChannelWindow {
	/** The raster frequency the filter is centred on. */
	channelHz: number
	/** Half the matched width: half a raster step. */
	spanHz: number
}

/** The window a channel filter matches: the raster frequency and half a raster step (never a bandwidth). */
export function channelWindow(
	hz: number,
	stepHz: number = DEFAULT_STEP_HZ,
): ChannelWindow {
	const step = Number.isFinite(stepHz) && stepHz > 0 ? stepHz : DEFAULT_STEP_HZ
	return { channelHz: rasterHz(hz, step), spanHz: Math.round(step / 2) }
}

/** The Activity token of a channel: its chip names the channel and states the width ("Club net · 145.6125 ±6.25 kHz"). */
export function channelToken(
	hz: number,
	stepHz: number = DEFAULT_STEP_HZ,
	name: string | null = savedNameAt(hz, undefined, stepHz),
): SearchToken {
	const w = channelWindow(hz, stepHz)
	const freq = `${channelMHz(w.channelHz, stepHz)} ${halfWidthText(w.spanHz)}`
	return token("frequency", String(w.channelHz), {
		spanHz: w.spanHz,
		label: name ? `${name} · ${freq}` : `${freq}`,
	})
}

/** "History of Club net", "History of 145.6125": the door's words. */
export function historyLabel(
	hz: number,
	stepHz: number = DEFAULT_STEP_HZ,
	name: string | null = savedNameAt(hz, undefined, stepHz),
): string {
	return `History of ${name ?? channelMHz(hz, stepHz)}`
}

/** What showChannel drives (the Activity controller). */
export type ChannelHistory = Pick<ActivityController, "update" | "setSearch">

/**
 * The one door from a frequency to its history (tuned card, band tag, spectrum menu, palette, Recordings):
 * Activity filtered to the channel at `hz` (raster frequency, half a raster step), the drawer opened.
 */
export function showChannel(
	activity: ChannelHistory,
	hz: number,
	stepHz: number = DEFAULT_STEP_HZ,
): void {
	activity.update(s => ({ ...s, editing: null, view: "all" }))
	activity.setSearch([channelToken(hz, stepHz)], null)
	shellStore.openDrawer("activity")
}
