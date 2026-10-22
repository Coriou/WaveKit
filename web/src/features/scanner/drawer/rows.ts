// The Scanner drawer's words and row anatomy (Scanner board): discovery rows, groups by sort, the open
// row's "why", identity chips, the live hit log, the header count and the footer. Pure.
import type {
	Discovery,
	ScanJob,
	ScanJobHit,
	ScannerClass,
	ScannerProgressEventData,
	ScannerProtocol,
} from "@wavekit/api-types"
import type { CategoryName } from "@wavekit/brand/react"

import type { DiscoverySort } from "../../../data/index.ts"
import {
	confidenceCapText,
	confidenceRank,
	confidenceText,
	identityText,
	isJobActive,
	protocolName,
	undecodedReasonText,
} from "../../../data/index.ts"
import { clockText as clock, dateText } from "../../display.ts"
import { formatMHz, formatWidth } from "../../format.ts"

// ---- small words

const PROTOCOL_ICON: Partial<Record<ScannerProtocol, CategoryName>> = {
	"analog-fm": "voice",
	"analog-am": "voice",
	dmr: "voice",
	p25p1: "voice",
	p25p2: "voice",
	nxdn48: "voice",
	nxdn96: "voice",
	ysf: "voice",
	dstar: "voice",
	dpmr: "voice",
	pocsag: "paging",
	flex: "paging",
	aprs: "aprs",
	ism: "sensors",
	lora: "mesh",
	ais: "marine",
	acars: "aviation-data",
	vdl2: "aviation-data",
}

/** The protocol tile's category glyph; null draws a dot (carrier, unknown). */
export function protocolIcon(
	d: Pick<Discovery, "protocol" | "confidence">,
): CategoryName | null {
	if (d.confidence === "activity") return null
	return PROTOCOL_ICON[d.protocol] ?? null
}

/** Frequency as the board writes it: "161.150" bold with a quiet "000" tail (6 decimals in all). */
export function frequencyParts(hz: number): { main: string; tail: string } {
	const f6 = (Math.round(hz) / 1e6).toFixed(6)
	return { main: f6.slice(0, -3), tail: f6.slice(-3) }
}

/** "Now" is said by the live dot; otherwise "6 min", "3 h", "2 d", "12 Sep". */
export function heardText(iso: string, now: number): string {
	const t = Date.parse(iso)
	if (!Number.isFinite(t)) return ""
	const s = Math.max(0, (now - t) / 1000)
	if (s < 60) return "Just now"
	const min = Math.floor(s / 60)
	if (min < 60) return `${min} min`
	const h = Math.floor(min / 60)
	if (h < 48) return `${h} h`
	const d = Math.floor(h / 24)
	if (d < 30) return `${d} d`
	return dateText(t)
}

/** "14:05" on the chosen clock (Settings › Display › Time). */
export function clockText(iso: string | number): string {
	return clock(iso)
}

/** "12 min", "1 h 5 min", "40 s". */
export function durationText(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000))
	if (s < 60) return `${s} s`
	const min = Math.round(s / 60)
	if (min < 60) return `${min} min`
	const h = Math.floor(min / 60)
	const rest = min % 60
	return rest > 0 ? `${h} h ${rest} min` : `${h} h`
}

function plural(n: number, one: string, many = `${one}s`): string {
	return `${n} ${n === 1 ? one : many}`
}

// ---- the row

export type RowTone = "accent" | "plain" | "quiet"

export interface DiscoveryRowView {
	id: string
	icon: CategoryName | null
	tone: RowTone
	freqMain: string
	freqTail: string
	/** "DMR", "Maybe DMR", "Heard". */
	confidence: string
	decoded: boolean
	/** Label, else identity and what it carries ("CC 1 · TG 2081, TG 9 · slot 1"), else width. */
	title: string
	labelled: boolean
	/** Caps and failure reasons, or null. */
	reason: string | null
	encrypted: boolean
	kept: boolean
	ignored: boolean
	/** Last heard in words (when not live). */
	heard: string
	/** For screen readers: "161.150 MHz, DMR, CC 1". */
	aria: string
}

function listText(xs: readonly string[], max: number): string {
	const shown = xs.slice(0, max)
	const rest = xs.length - shown.length
	return rest > 0 ? `${shown.join(", ")} +${rest}` : shown.join(", ")
}

/** What the discovery carries, in one line: identity, then talkgroups, capcodes, callsigns, models. */
export function identityLine(d: Discovery): string {
	const parts: string[] = []
	const id = identityText(d.identity)
	if (id) parts.push(id)
	const m = d.metadata
	if (m.talkgroups.length)
		parts.push(
			listText(
				m.talkgroups.map(t => `TG ${t}`),
				2,
			),
		)
	if (m.slots.length) parts.push(`slot ${m.slots.join(", ")}`)
	const caps = m.capcodes.filter(
		c => d.identity?.kind !== "pocsag-capcode" || c !== d.identity.value,
	)
	if (caps.length)
		parts.push(
			`${caps.length === 1 ? "Capcode" : "Capcodes"} ${listText(caps, 2)}`,
		)
	const calls = m.callsigns.filter(c => c !== d.identity?.value)
	if (calls.length) parts.push(listText(calls, 2))
	if (m.ismModels.length && d.identity?.kind !== "ism-model")
		parts.push(listText(m.ismModels, 2))
	if (m.ctcssHz !== undefined) parts.push(`CTCSS ${m.ctcssHz.toFixed(1)} Hz`)
	return parts.join(" · ")
}

export function reasonText(d: Discovery): string | null {
	const parts = [
		confidenceCapText(d.confidenceCap),
		d.confidence !== "decoded" ? undecodedReasonText(d.undecodedReason) : null,
	].filter((x): x is string => x !== null)
	return parts.length > 0 ? parts.join(" · ") : null
}

export function discoveryRow(d: Discovery, now: number): DiscoveryRowView {
	const { main, tail } = frequencyParts(d.frequencyHz)
	const confidence = confidenceText(d)
	const label = d.operator?.label?.trim() ?? ""
	const ident = identityLine(d)
	// WG12 cores say how it was proven ("DMR decoded (CC1, TG 9)", "Analog FM voice, CTCSS 88.5")
	const title =
		label ||
		d.proof?.summary ||
		ident ||
		(d.bandwidthHz > 0 ? `${formatWidth(d.bandwidthHz)} wide` : "")
	const tone: RowTone =
		d.confidence === "decoded"
			? "accent"
			: d.confidence === "activity" || d.protocol === "unknown"
				? "quiet"
				: "plain"
	const aria = [
		`${formatMHz(d.frequencyHz)} MHz`,
		confidence,
		label || identityText(d.identity),
	]
		.filter(Boolean)
		.join(", ")
	return {
		id: d.id,
		icon: protocolIcon(d),
		tone,
		freqMain: main,
		freqTail: tail,
		confidence,
		decoded: d.confidence === "decoded" && d.protocol !== "carrier",
		title,
		labelled: label !== "",
		reason: reasonText(d),
		encrypted: d.encrypted,
		kept: d.operator?.keep === true,
		ignored: d.operator?.lockout === true,
		heard: heardText(d.lastSeenAt, now),
		aria,
	}
}

// ---- groups

export interface DiscoveryGroup {
	key: string
	label: string
	items: Discovery[]
}

function bandLabel(hz: number): string {
	if (hz < 30e6) return "HF"
	if (hz < 300e6) return "VHF"
	if (hz < 3e9) return "UHF"
	return "SHF"
}

const CONFIDENCE_GROUP = ["Heard", "Maybe", "Likely", "Decoded"] as const

/**
 * The loaded list split into the board's groups for the sort (Active now · Last hour · Earlier;
 * HF · VHF · UHF; Decoded · Likely · Maybe · Heard), keeping the core's order inside a group.
 * Ignored discoveries (lockout) are returned apart.
 */
export function groupDiscoveries(
	items: readonly Discovery[],
	sort: DiscoverySort,
	activeNow: ReadonlySet<string>,
	now: number,
): { groups: DiscoveryGroup[]; ignored: Discovery[] } {
	const ignored: Discovery[] = []
	const groups: DiscoveryGroup[] = []
	const byKey = new Map<string, DiscoveryGroup>()
	const add = (key: string, label: string, d: Discovery) => {
		let g = byKey.get(key)
		if (!g) {
			g = { key, label, items: [] }
			byKey.set(key, g)
			groups.push(g)
		}
		g.items.push(d)
	}
	for (const d of items) {
		if (d.operator?.lockout === true) {
			ignored.push(d)
			continue
		}
		if (sort === "frequency") {
			const b = bandLabel(d.frequencyHz)
			add(b, b, d)
		} else if (sort === "confidence") {
			const rank = d.protocol === "unknown" ? 0 : confidenceRank(d.confidence)
			const label = CONFIDENCE_GROUP[rank] ?? "Heard"
			add(label, label, d)
		} else if (activeNow.has(d.id)) add("active", "Active now", d)
		else if (now - Date.parse(d.lastSeenAt) < 3_600_000)
			add("hour", "Last hour", d)
		else add("earlier", "Earlier", d)
	}
	if (sort === "lastSeen") {
		const order = ["active", "hour", "earlier"]
		groups.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key))
	} else if (sort === "confidence") {
		groups.sort(
			(a, b) =>
				CONFIDENCE_GROUP.indexOf(b.key as (typeof CONFIDENCE_GROUP)[number]) -
				CONFIDENCE_GROUP.indexOf(a.key as (typeof CONFIDENCE_GROUP)[number]),
		)
	}
	return { groups, ignored }
}

export type ListEntry =
	| { type: "group"; key: string; label: string }
	| { type: "ignored"; key: string; count: number; names: string }
	| { type: "weak"; key: string; shown: boolean }
	| { type: "row"; key: string; discovery: Discovery }

/** The weak-activity toggle at the end of the list: none on cores without proofs (WG12). */
export type WeakToggle = "none" | "hidden" | "shown"

/** Flat entries for the windowed list: group headers, rows, then the ignored toggle (and its rows). */
export function listEntries(
	items: readonly Discovery[],
	sort: DiscoverySort,
	activeNow: ReadonlySet<string>,
	now: number,
	showIgnored: boolean,
	weak: WeakToggle = "none",
): ListEntry[] {
	const { groups, ignored } = groupDiscoveries(items, sort, activeNow, now)
	const out: ListEntry[] = []
	for (const g of groups) {
		out.push({ type: "group", key: `g:${g.key}`, label: g.label })
		for (const d of g.items) out.push({ type: "row", key: d.id, discovery: d })
	}
	if (ignored.length > 0) {
		out.push({
			type: "ignored",
			key: "ignored",
			count: ignored.length,
			names: listText(
				ignored.map(
					d => d.operator?.label?.trim() || `${formatMHz(d.frequencyHz)}`,
				),
				3,
			),
		})
		if (showIgnored)
			for (const d of ignored)
				out.push({ type: "row", key: d.id, discovery: d })
	}
	if (weak !== "none")
		out.push({ type: "weak", key: "weak", shown: weak === "shown" })
	return out
}

/** Row height before measuring (closed row; the open row is measured). */
export function estimateHeight(e: ListEntry, open: boolean): number {
	if (e.type === "group") return 34
	if (e.type === "ignored" || e.type === "weak") return 52
	if (open) return 360
	return e.discovery.undecodedReason || e.discovery.confidenceCap ? 78 : 62
}

// ---- the open row

const CLASS_WORDS: Readonly<Record<ScannerClass, string | null>> = {
	"fsk4-12k5": "4FSK 12.5 kHz",
	"fsk4-6k25": "4FSK 6.25 kHz",
	"tdma-ms": "TDMA",
	"fsk2-wide": "wide 2FSK",
	"gmsk-narrow": "narrow GMSK",
	"afsk-fm": "AFSK on FM",
	"analog-fm": "FM with speech pauses",
	"ook-burst": "OOK bursts",
	carrier: "a steady carrier",
	wideband: "a wideband signal",
	unknown: null,
}

/** Why it has that confidence, in one sentence, from what the core keeps. */
export function whyText(d: Discovery): string {
	if (d.proof) return d.proof.summary
	const shape = CLASS_WORDS[d.class]
	const id = identityText(d.identity)
	if (d.protocol === "carrier" || d.class === "carrier")
		return "A steady carrier · no modulation"
	switch (d.confidence) {
		case "decoded": {
			const what = `${protocolName(d.protocol)} decoded`
			const enc = d.encrypted ? " · the voice is encrypted" : ""
			return id ? `${what} · ${id}${enc}` : `${what}${enc}`
		}
		case "classified":
			return `Likely ${protocolName(d.protocol)}${shape ? ` · looks like ${shape}` : ""}`
		case "candidate": {
			const reason = undecodedReasonText(d.undecodedReason)
			const base = shape
				? `Looks like ${shape}`
				: `Maybe ${protocolName(d.protocol)}`
			return reason ? `${base} · ${reason.toLowerCase()}` : base
		}
		default:
			return d.observationCount > 1
				? `Heard ${plural(d.observationCount, "time")} · too little to tell`
				: "Heard once · too little to tell"
	}
}

/** "12.5 kHz wide · SNR 24 dB · first heard 12 Sep 14:02 · 3 recordings". */
export function measuredText(d: Discovery): string {
	const parts: string[] = []
	if (d.bandwidthHz > 0) parts.push(`${formatWidth(d.bandwidthHz)} wide`)
	parts.push(`SNR ${Math.round(d.signal.best.snrDb)} dB`)
	const first = Date.parse(d.firstSeenAt)
	if (Number.isFinite(first)) {
		const day = dateText(first)
		parts.push(`first heard ${day} ${clockText(first)}`)
	}
	if (d.airtimeMs > 0) parts.push(`${durationText(d.airtimeMs)} on air`)
	if (d.evidence.recordings > 0)
		parts.push(plural(d.evidence.recordings, "recording"))
	if (d.tuningTrust === "unverified") parts.push("frequency unverified")
	return parts.join(" · ")
}

/** The identity chips: identity, talkgroups, radios, slots, capcodes, callsigns, models, tone. */
export function identityChips(d: Discovery, max = 12): string[] {
	const out: string[] = []
	const id = identityText(d.identity)
	if (id) out.push(id)
	const m = d.metadata
	for (const t of m.talkgroups) out.push(`TG ${t}`)
	for (const s of m.sources) out.push(`Radio ${s}`)
	for (const s of m.slots) out.push(`Slot ${s}`)
	for (const c of m.capcodes) out.push(`Capcode ${c}`)
	for (const c of m.callsigns) out.push(c)
	for (const x of m.ismModels) out.push(x)
	if (m.ctcssHz !== undefined) out.push(`CTCSS ${m.ctcssHz.toFixed(1)} Hz`)
	const unique = [...new Set(out)]
	if (unique.length <= max) return unique
	return [...unique.slice(0, max), `+${unique.length - max}`]
}

// ---- the live hit log

export interface HitEntry {
	hit: ScanJobHit
	discovery: Discovery | undefined
	live: boolean
	fresh: boolean
}

/** This scan's hits: live first, then new ones, then most recent. "New only" keeps first-seen ones. */
export function hitEntries(
	hits: ReadonlyMap<string, ScanJobHit> | undefined,
	byId: ReadonlyMap<string, Discovery>,
	activeNow: ReadonlySet<string>,
	newOnly: boolean,
): HitEntry[] {
	if (!hits) return []
	const out: HitEntry[] = []
	for (const hit of hits.values()) {
		if (newOnly && !hit.firstSeenInJob) continue
		out.push({
			hit,
			discovery: byId.get(hit.discoveryId),
			live: activeNow.has(hit.discoveryId),
			fresh: hit.firstSeenInJob,
		})
	}
	out.sort(
		(a, b) =>
			Number(b.live) - Number(a.live) ||
			Number(b.fresh) - Number(a.fresh) ||
			(a.hit.lastHitAt < b.hit.lastHitAt
				? 1
				: a.hit.lastHitAt > b.hit.lastHitAt
					? -1
					: 0) ||
			(a.hit.discoveryId < b.hit.discoveryId ? -1 : 1),
	)
	return out
}

/** "3 hits · first 14:03 · last 14:05 · 4 s long"; "Ignored · …" for a lockout (line 1 names it). */
export function hitMeta(e: HitEntry): string {
	const parts: string[] = []
	if (e.discovery?.operator?.lockout) parts.push("Ignored")
	parts.push(
		plural(e.hit.hits, "hit"),
		`first ${clockText(e.hit.firstHitAt)}`,
		`last ${clockText(e.hit.lastHitAt)}`,
	)
	if (e.hit.lastDurationMs != null && e.hit.lastDurationMs > 0)
		parts.push(`${durationText(e.hit.lastDurationMs)} long`)
	return parts.join(" · ")
}

// ---- header and footer

/** One hop: the receiver parks and watches the whole range (DESIGN.md "one-hop watch"). */
export function isOneHop(job: Pick<ScanJob, "plan">): boolean {
	return job.plan.hops.length === 1
}

export function jobName(job: Pick<ScanJob, "name">): string {
	return job.name?.trim() || "the scan"
}

/**
 * The drawer's one count: while a sweep runs, "Sweeping · 4 found · 2 new" (or "Watching PMR446 ·
 * 1 found" for one hop); otherwise the number of discoveries listed ("120+" with more pages).
 */
export function headerCount(input: {
	sweep: ScanJob | null
	found: number
	fresh: number
	listed: number
	more: boolean
	loaded: boolean
}): string {
	const { sweep } = input
	if (sweep && isJobActive(sweep.state)) {
		const moving =
			sweep.state === "running" ||
			sweep.state === "holding" ||
			sweep.state === "starting" ||
			sweep.state === "pending"
		const lead = moving
			? isOneHop(sweep)
				? `Watching ${jobName(sweep)} · `
				: "Sweeping · "
			: ""
		return `${lead}${input.found} found${isOneHop(sweep) ? "" : ` · ${input.fresh} new`}`
	}
	if (!input.loaded) return ""
	return `${input.listed}${input.more ? "+" : ""}`
}

export interface FooterInput {
	sweep: ScanJob | null
	/** The last sweep when none runs (ended), else null. */
	lastSweep: ScanJob | null
	progress: ScannerProgressEventData | null
	passive: ScanJob | null
	watching: boolean
	found: number
	readOnly: boolean
	now: number
}

/** Coverage as a percentage, when the core reports it (0..1). */
function coverageText(c: number | undefined): string | null {
	if (c === undefined || !Number.isFinite(c) || c <= 0) return null
	return `${Math.round(Math.min(1, c) * 100)} % covered`
}

/** The footer: honest about how long and how much was looked at. */
export function footerText(f: FooterInput): string {
	const lead = f.readOnly ? "View only · " : ""
	const s = f.sweep
	if (s && isJobActive(s.state)) {
		const started = s.startedAt ? Date.parse(s.startedAt) : NaN
		const el = Number.isFinite(started) ? durationText(f.now - started) : null
		const cov = coverageText(f.progress?.coverage ?? s.progress.coverage)
		const one = isOneHop(s)
		switch (s.state) {
			case "pending":
			case "starting":
				return `${lead}Starting · the receiver moves in a moment`
			case "paused":
				return `${lead}${el ? `Paused after ${el}` : "Paused"}${cov ? ` · ${cov}` : ""}`
			default: {
				const verb = one ? "Watching" : "Scanning"
				const parts = [el ? `${verb} for ${el}` : verb]
				if (Number.isFinite(started))
					parts.push(`started ${clockText(started)}`)
				if (cov && !one) parts.push(cov)
				return lead + parts.join(" · ")
			}
		}
	}
	const last = f.lastSweep
	if (last?.endedAt && last.startedAt) {
		const ended = Date.parse(last.endedAt)
		// a finished scan stays in the footer for an hour
		if (f.now - ended < 3_600_000) {
			const ran = durationText(ended - Date.parse(last.startedAt))
			const cov = coverageText(last.progress.coverage)
			if (last.state === "failed")
				return `${lead}Scan failed at ${clockText(ended)}`
			if (f.found === 0)
				return `${lead}Nothing found in ${ran} of scanning${cov ? ` (${cov})` : ""}`
			return `${lead}${last.state === "completed" ? "Finished" : "Stopped"} at ${clockText(ended)} · ${f.found} found in ${ran}${cov ? ` · ${cov}` : ""}`
		}
	}
	const p = f.passive
	if (f.watching && p && isJobActive(p.state)) {
		const since = p.startedAt ? Date.parse(p.startedAt) : NaN
		return `${lead}${Number.isFinite(since) ? `Watching since ${clockText(since)}` : "Watching"}`
	}
	if (f.watching) return `${lead}Watching where you are tuned`
	return `${lead}Not watching · discoveries so far are kept`
}

/** "160.6–163.0" (MHz, one decimal): the span Watch here looks at. */
export function spanText(centreHz: number, sampleRateHz: number): string {
	const a = (centreHz - sampleRateHz / 2) / 1e6
	const b = (centreHz + sampleRateHz / 2) / 1e6
	return `${a.toFixed(1)}–${b.toFixed(1)}`
}
