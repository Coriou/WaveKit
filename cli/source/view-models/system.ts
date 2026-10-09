import type { LiveAudioConfig } from "@wavekit/api-types"
import { isOld } from "../data/freshness.js"
import type { ActionRecord, AppState, SdrHostView } from "../data/types.js"
import { fitGroups } from "../ui/fit.js"
import {
	formatAge,
	formatBytes,
	formatClockShort,
	formatDuration,
	formatMHzBare,
	formatRate,
	formatSampleAge,
} from "../ui/format.js"
import { sp, type Group, type Line, type Role } from "../ui/line.js"
import { glyphSpan } from "../ui/strip.js"
import { padEnd, sanitize, truncate } from "../ui/text.js"
import { glyphs } from "../ui/theme.js"
import type { ConfirmRequest } from "../ui/ui-state.js"
import { LABEL_WIDTH } from "./detail.js"
import { noDataText } from "./feed-state.js"
import {
	essential,
	gapRow,
	grouped,
	keep,
	optional,
	shed,
	type Row,
} from "./shed.js"

const RESULT_MS = 10_000
const LABEL_W = LABEL_WIDTH
const MAX_ALERTS = 3
/** Host warnings or errors shown per host before "+N more". */
const MAX_NOTES = 2
/**
 * Shedding order on short views (highest first). Rows without a DROP entry (the
 * unreachable line, audio results and errors) go next, last first, and the heads
 * (CONTAINER, SDR HOST, AUDIO, CORE) last of all, CORE staying (shed.ts).
 */
const DROP = {
	gap: 9,
	component: 8,
	cli: 8,
	alert: 7,
	dongle: 6,
	demod: 6,
	sampling: 5,
	mem: 5,
	proc: 4,
	cpu: 4,
	// Preflight warnings and errors outrank routine rows (they explain a fault).
	warning: 3,
	error: 2,
	firstAlert: 1,
} as const
const MODULATIONS: readonly LiveAudioConfig["modulation"][] = [
	"nfm",
	"wfm",
	"am",
	"usb",
	"lsb",
	"dsb",
	"cw",
	"raw",
]
const sep = (): string => ` ${glyphs().sep} `
const lbl = (t: string, bold = false): Line => [
	sp(padEnd(t, LABEL_W), "label", bold),
]
const one = (priority: number, ...variants: Line[]): Group => ({
	priority,
	variants,
})
const txt = (t: string, role: Role = "value"): Line => [sp(t, role)]
const kHz = (hz: number): string =>
	`${(hz / 1000).toFixed(1).replace(/\.0$/, "")} kHz`
const quote = (s: string, max = 60): string => `"${truncate(sanitize(s), max)}"`
const own = <T>(
	rec: Readonly<Record<string, T>>,
	key: string,
): T | undefined =>
	Object.prototype.hasOwnProperty.call(rec, key) ? rec[key] : undefined

interface Block {
	rows: Row[]
	/** Group items never rendered (beyond their cap), for the groups' "+N more". */
	capped: Record<string, number>
}

function kv(
	label: string,
	text: string,
	width: number,
	role: Role = "value",
	bold = false,
): Line {
	return [
		...lbl(label, bold),
		sp(truncate(text, Math.max(1, width - LABEL_W)), role),
	]
}

/** Groups joined by " · ", lowest-priority groups dropped first when narrow (spec §4.2). */
function fitDot(label: Line, groups: Group[], width: number): Line {
	return [
		...label,
		...fitGroups(groups, Math.max(1, width - LABEL_W), { sep: sep() }),
	]
}

/** R82: one no-data copy for every section. */
function noData(state: AppState, path: string): string {
	return noDataText(state, path)
}

function containerBlock(state: AppState, width: number): Block {
	const r = state.resources.value
	if (!r)
		return {
			rows: [
				essential(
					kv(
						"CONTAINER",
						noData(state, "/api/resources"),
						width,
						"label",
						true,
					),
				),
			],
			capped: {},
		}
	const now = state.now
	const role: Role = isOld(state.resources, now) ? "old" : "value"
	const c = r.container
	const g = glyphs()
	const age =
		state.resources.receivedAt === null
			? "?"
			: formatAge(now - state.resources.receivedAt)
	const rows: Row[] = [
		essential([
			...lbl("CONTAINER", true),
			sp(
				`${c.available ? `cgroup ${c.cgroupVersion}` : "no cgroup data"}${sep()}as of ${age} ago`,
				"label",
			),
		]),
	]
	const pct = (v: number | null): string =>
		v === null ? g.na : `${Math.round(v)}%`
	// With a limit, a missing percentage is unknown, not "not applicable" (M7).
	const memPct = (v: number | null): string =>
		v === null ? "?" : `${Math.round(v)}%`
	const cpu =
		c.cpuUsagePercent === null ? "?" : `${Math.round(c.cpuUsagePercent)}%`
	rows.push(
		optional(
			kv(
				"cpu",
				`${cpu}   throttled ${pct(c.cpuThrottledPercent)}   oom kills ${c.oomKillCount ?? "?"}`,
				width,
				role,
			),
			DROP.cpu,
		),
	)
	const used = formatBytes(c.memoryUsageBytes)
	const mem =
		c.memoryLimitBytes === null
			? `${used}${sep()}no limit`
			: `${used} of ${formatBytes(c.memoryLimitBytes)} (${memPct(c.memoryUsagePercent)})`
	rows.push(optional(kv("mem", mem, width, role), DROP.mem))
	const alerts = [...state.alerts].sort((a, b) => b.lastAt - a.lastAt)
	alerts.slice(0, MAX_ALERTS).forEach((a, i) => {
		// Server severity and message verbatim (quoted, assumption 9); count, first seen, last age.
		const line = fitDot(
			lbl(i === 0 ? "alerts" : ""),
			[
				one(0, [
					sp(`${g.attention} `, "attention"),
					sp(
						`${sanitize(a.alert.type)} ${sanitize(a.alert.severity)} ${quote(a.alert.message)}`,
						a.alert.severity === "critical" ? "attention" : "value",
					),
				]),
				one(1, txt(`${a.count}× since ${formatClockShort(a.firstAt)}`)),
				one(2, txt(`last ${formatAge(now - a.lastAt)} ago`)),
			],
			width,
		)
		rows.push(grouped(line, "alerts", i === 0 ? DROP.firstAlert : DROP.alert))
	})
	return { rows, capped: { alerts: Math.max(0, alerts.length - MAX_ALERTS) } }
}

type Proc = {
	running: boolean
	pid: number | null
	restartCount: number
} | null

function procRow(
	label: string,
	p: Proc,
	extra: Group[],
	role: Role,
	width: number,
): Line {
	if (p === null) return kv(label, "?", width, "unknown")
	return fitDot(
		lbl(label),
		[
			one(0, [
				glyphSpan(p.running ? "live" : "fault"),
				sp(` ${p.running ? "running" : "down"}`, role),
			]),
			// A running process without a pid is unknown; a stopped one has none (M7).
			one(2, txt(`pid ${p.pid ?? (p.running ? "?" : glyphs().na)}`, role)),
			...extra,
			one(1, txt(`${p.restartCount} restarts`, role)),
		],
		width,
	)
}

function hostBlock(
	state: AppState,
	h: SdrHostView,
	index: number,
	width: number,
): Block {
	const now = state.now
	const g = glyphs()
	const unreachable = h.fetchError !== null
	const old = isOld(state.resources, now)
	// Spec §6.5: when core cannot reach the Pi, the block's rows go dim (header too, M3).
	const role: Role = unreachable || old ? "old" : "value"
	const polled = h.lastFetchedAt
		? `${formatAge(now - Date.parse(h.lastFetchedAt))} ago`
		: "?"
	const rows: Row[] = [
		essential(
			fitDot(
				lbl("SDR HOST", true),
				[
					one(0, txt(sanitize(h.sourceId), role)),
					one(2, txt(sanitize(h.apiUrl), role)),
					one(1, txt(`polled by core ${polled}`, role)),
					one(3, txt(`uptime ${formatDuration(h.uptime)}`, role)),
				],
				width,
			),
		),
	]
	if (unreachable)
		rows.push(
			keep([
				...lbl(""),
				glyphSpan("fault"),
				sp(
					truncate(
						` core cannot reach the Pi API${sep()}${quote(h.fetchError ?? "")}`,
						Math.max(1, width - LABEL_W - 1),
					),
					"fault",
				),
			]),
		)
	rows.push(optional(procRow("rtl_tcp", h.rtlTcp, [], role, width), DROP.proc))
	const mux = h.rtlmux
	rows.push(
		optional(
			procRow(
				"rtlmux",
				mux,
				mux
					? [
							one(
								3,
								txt(
									`${mux.clients} client${mux.clients === 1 ? "" : "s"}`,
									role,
								),
							),
							// A rate from an old lane is unknown, not a dimmed number (T6).
							one(1, txt(formatRate(old ? null : mux.bytesPerSec), role)),
							one(4, txt(`${formatBytes(mux.totalBytesSent)} sent`, role)),
						]
					: [],
				role,
				width,
			),
			DROP.proc,
		),
	)
	const smp = h.sampling
	if (smp) {
		const glyph =
			smp.state === "streaming"
				? "live"
				: smp.state === "waiting"
					? "neutral"
					: smp.state === "unknown"
						? "unknown"
						: "fault"
		// A rate from an old lane is unknown, not a dimmed number (T6).
		const rate =
			smp.upstream.bytesPerSec === null || old
				? "?"
				: formatRate(smp.upstream.bytesPerSec)
		rows.push(
			optional(
				fitDot(
					lbl("sampling"),
					[
						// An unknown state is the ? glyph alone, not "? ?".
						one(
							0,
							smp.state === "unknown"
								? [glyphSpan(glyph)]
								: [glyphSpan(glyph), sp(` ${smp.state}`, role)],
						),
						one(1, txt(`sample age ${formatSampleAge(smp.sampleAgeMs)}`, role)),
						one(2, txt(`${rate} upstream (${smp.upstream.rateStatus})`, role)),
						one(3, txt(`${smp.epoch.resets} resets`, role)),
					],
					width,
				),
				DROP.sampling,
			),
		)
	}
	const d = h.dongle
	const dongle =
		d === null
			? "?"
			: d.found
				? `${sanitize([d.vendor, d.product].filter(Boolean).join(" ")) || "?"}${sep()}serial ${d.serial === null ? g.na : sanitize(d.serial)}`
				: "not found"
	rows.push(optional(kv("dongle", dongle, width, role), DROP.dongle))
	// Preflight warnings and errors verbatim, capped per host with "+N more".
	const warn = `host${index}-warnings`
	const err = `host${index}-errors`
	for (const w of h.warnings.slice(0, MAX_NOTES))
		rows.push(
			grouped(kv("warning", quote(w), width, "attention"), warn, DROP.warning),
		)
	for (const e of h.errors.slice(0, MAX_NOTES))
		rows.push(grouped(kv("error", quote(e), width, "fault"), err, DROP.error))
	return {
		rows,
		capped: {
			[warn]: Math.max(0, h.warnings.length - MAX_NOTES),
			[err]: Math.max(0, h.errors.length - MAX_NOTES),
		},
	}
}

/**
 * Result line in CLI words (R29), by action state: sent → "audio start sending";
 * unknown (R23) → "audio stop sent · no reply in 10s"; no-reply → "audio stop sent ·
 * no reply"; ok → "audio started · 0 clients" / "preset wfm applied"; failed →
 * `audio start failed · 503 · "…"`. Terminal states show for 10 s after doneAt.
 */
export function audioResultText(state: AppState, now: number): string | null {
	let best: { at: number; text: string } | null = null
	for (const key of ["audio", "preset"] as const) {
		const rec = own(state.actions.byKey, key)
		if (!rec) continue
		const pending = rec.state === "sent" || rec.state === "unknown"
		if (!pending && (rec.doneAt === null || now - rec.doneAt > RESULT_MS))
			continue
		const at = rec.doneAt ?? rec.resultAt ?? rec.sentAt
		const text = resultText(state, rec)
		if (text !== null && (best === null || at > best.at)) best = { at, text }
	}
	return best?.text ?? null
}

function resultText(state: AppState, rec: ActionRecord): string | null {
	const intent = rec.intent
	const what =
		intent.kind === "audio"
			? `audio ${intent.op}`
			: intent.kind === "preset"
				? `preset ${sanitize(intent.name)}`
				: null
	if (what === null) return null
	const r = rec.outcomes[0]?.result
	switch (rec.state) {
		case "sent":
			return `${what} sending`
		case "unknown":
			return `${what} sent${sep()}no reply in ${Math.round(RESULT_MS / 1000)}s`
		case "no-reply":
			return `${what} sent${sep()}no reply`
		case "failed":
			return `${what} failed${sep()}${r?.status ?? "network"}${sep()}${quote(r?.message ?? "?")}`
		case "ok":
			return intent.kind === "audio"
				? `audio ${intent.op === "start" ? "started" : "stopped"}${sep()}${state.audio.value?.clientCount ?? "?"} clients`
				: `${what} applied`
	}
}

function audioBlock(state: AppState, width: number): Row[] {
	const a = state.audio.value
	if (!a)
		return [
			essential(
				kv(
					"AUDIO",
					noData(state, "/api/live-audio/status"),
					width,
					"label",
					true,
				),
			),
		]
	const role: Role = isOld(state.audio, state.now) ? "old" : "value"
	const glyph =
		a.pipelineHealth === "error" ? "fault" : a.running ? "live" : "neutral"
	// Disabled in config is not the same as stopped: `a` cannot start it (R72).
	const word =
		a.pipelineHealth === "error"
			? "error"
			: a.running
				? "running"
				: !a.enabled
					? "disabled"
					: a.pipelineHealth === "starting"
						? "starting"
						: "stopped"
	let url = sanitize(a.httpUrl)
	try {
		const u = new URL(a.httpUrl)
		url = sanitize(`${u.host}${u.pathname}`)
	} catch {
		// Not a URL: shown sanitised as received.
	}
	const c = a.config
	const tuner = state.tuner.value?.find(t => t.sourceId === a.sourceId)
	// A frequency core never commanded or observed is a placeholder (R84).
	const centre = tuner?.unknownFields?.includes("frequency")
		? undefined
		: tuner?.frequency
	const rows: Row[] = [
		essential(
			fitDot(
				lbl("AUDIO", true),
				[
					one(0, [glyphSpan(glyph), sp(` ${word}`, role)]),
					one(
						1,
						txt(
							`${a.clientCount} client${a.clientCount === 1 ? "" : "s"}`,
							role,
						),
					),
					one(2, txt(url, role)),
				],
				width,
			),
		),
		optional(
			fitDot(
				lbl("demod"),
				[
					one(
						0,
						txt(
							`${sanitize(a.sourceId)} at ${centre === undefined ? "?" : `${formatMHzBare(centre, 4)} MHz`}`,
							role,
						),
					),
					one(0, txt(`${c.modulation} ${kHz(c.bandwidth)}`, role)),
					one(2, txt(`squelch ${c.squelch}`, role)),
					one(2, txt(`gain ${c.gain}`, role)),
					one(
						1,
						txt(
							`${Math.round(a.effectiveSampleRate / 1000)} kHz ${c.audioFormat}`,
							role,
						),
					),
				],
				width,
			),
			DROP.demod,
		),
	]
	const result = audioResultText(state, state.now)
	if (result) rows.push(keep(kv("result", result, width)))
	if (a.lastError)
		rows.push(keep(kv("error", quote(a.lastError), width, "fault")))
	return rows
}

/** The CLI's own boundary counters: debug figures, so dim, under CORE (polish copy sweep). */
function cliRow(state: AppState, width: number): Row {
	const c = state.conn
	return optional(
		kv(
			"",
			`cli  frames rejected ${c.invalidFrames}${sep()}items rejected ${c.rejectedItems}`,
			width,
			"label",
		),
		DROP.cli,
	)
}

function coreBlock(state: AppState, width: number): Row[] {
	const s = state.status.value
	if (!s)
		return [
			essential(kv("CORE", noData(state, "/api/status"), width, "label", true)),
			cliRow(state, width),
		]
	const role: Role = isOld(state.status, state.now) ? "old" : "value"
	const rows: Row[] = [
		essential(
			fitDot(
				lbl("CORE", true),
				[
					one(1, txt(`v${sanitize(s.version)}`, role)),
					one(2, txt(`uptime ${formatDuration(s.uptime)}`, role)),
					// The server's own verdict word, quoted so the CLI does not assert it (assumption 9).
					one(0, txt(`reports ${quote(s.status, 24)}`, role)),
				],
				width,
			),
		),
	]
	// Decoder components are left out (view 2 covers them); the guard already skips them.
	for (const c of s.components)
		if (c.message)
			rows.push(
				optional(
					kv(
						"",
						// Status and message are server text: both quoted (assumption 9, M7),
						// a separator between them (polish S2).
						`${sanitize(c.name)} ${quote(c.status, 16)}${sep()}${quote(c.message)}`,
						width,
						"label",
					),
					DROP.component,
				),
			)
	rows.push(cliRow(state, width))
	return rows
}

/**
 * Spec §6.5 order: CONTAINER (+alerts), SDR HOST per host, AUDIO, CORE. Short views
 * shed by DROP with "+N more" / "+N rows hidden" markers; the heads always stay.
 */
export function systemLines(
	state: AppState,
	width: number,
	height: number,
	roomy: boolean,
): Line[] {
	const gap = (): Row[] => (roomy ? [gapRow(DROP.gap)] : [])
	const container = containerBlock(state, width)
	const hosts = (state.resources.value?.sdrHosts ?? []).map((h, i) =>
		hostBlock(state, h, i, width),
	)
	const hostRows: Row[] =
		hosts.length > 0
			? hosts.flatMap((b, i) => [...(i > 0 ? gap() : []), ...b.rows])
			: [
					essential(
						kv(
							"SDR HOST",
							state.resources.value
								? "none configured"
								: noData(state, "/api/resources"),
							width,
							"label",
							true,
						),
					),
				]
	const capped = Object.assign(
		{},
		container.capped,
		...hosts.map(b => b.capped),
	) as Record<string, number>
	return shed(
		[
			...container.rows,
			...gap(),
			...hostRows,
			...gap(),
			...audioBlock(state, width),
			...gap(),
			...coreBlock(state, width),
		],
		height,
		capped,
	)
}

export function presetNames(state: AppState): string[] {
	return Object.keys(state.presets.value ?? {}).filter(
		(n): n is LiveAudioConfig["modulation"] =>
			(MODULATIONS as readonly string[]).includes(n),
	)
}

/** Presets carry only bandwidth and de-emphasis, so the PATCH also sends the modulation (assumption 4). */
export function presetConfirm(
	state: AppState,
	index: number,
): ConfirmRequest | null {
	const names = presetNames(state)
	if (names.length === 0) return null
	const i = ((index % names.length) + names.length) % names.length
	const name = names[i] as LiveAudioConfig["modulation"]
	const presets = state.presets.value
	const p = presets ? own(presets, name) : undefined
	if (!p) return null
	return {
		kind: "preset",
		// Core restarts a running demod pipeline on any config change (reconfigure()).
		prompt: `audio preset ${name}${sep()}${kHz(p.bandwidth)}${state.audio.value?.running === true ? `${sep()}demod restarts` : ""}`,
		yes: "apply",
		no: "cancel",
		presetIndex: i,
		intent: {
			kind: "preset",
			name,
			patch: {
				modulation: name,
				bandwidth: p.bandwidth,
				...(p.deEmphasis !== undefined ? { deEmphasis: p.deEmphasis } : {}),
				...(p.deEmphasisTau !== undefined
					? { deEmphasisTau: p.deEmphasisTau }
					: {}),
			},
		},
	}
}
