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

const RESULT_MS = 10_000
const LABEL_W = 10
const MAX_ALERTS = 3
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

/** A row; `drop` rows may go when the view is short, highest number first. */
interface Row {
	line: Line
	drop?: number
}
const keep = (line: Line): Row => ({ line })
const optional = (line: Line, drop: number): Row => ({ line, drop })

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

function noData(state: AppState, path: string): string {
	return state.conn.rest.firstFailAt !== null
		? `no data${sep()}API unreachable`
		: `fetching ${path}`
}

function containerBlock(state: AppState, width: number): Row[] {
	const r = state.resources.value
	if (!r)
		return [
			keep(
				kv("CONTAINER", noData(state, "/api/resources"), width, "label", true),
			),
		]
	const now = state.now
	const role: Role = isOld(state.resources, now) ? "old" : "value"
	const c = r.container
	const g = glyphs()
	const age =
		state.resources.receivedAt === null
			? "?"
			: formatAge(now - state.resources.receivedAt)
	const rows: Row[] = [
		keep([
			...lbl("CONTAINER", true),
			sp(
				`${c.available ? `cgroup ${c.cgroupVersion}` : "no cgroup data"}${sep()}as of ${age} ago`,
				"label",
			),
		]),
	]
	const pct = (v: number | null): string =>
		v === null ? g.na : `${Math.round(v)}%`
	const cpu =
		c.cpuUsagePercent === null ? "?" : `${Math.round(c.cpuUsagePercent)}%`
	rows.push(
		keep(
			kv(
				"cpu",
				`${cpu}   throttled ${pct(c.cpuThrottledPercent)}   oom kills ${c.oomKillCount ?? "?"}`,
				width,
				role,
			),
		),
	)
	const used = formatBytes(c.memoryUsageBytes, 2)
	const mem =
		c.memoryLimitBytes === null
			? `${used}${sep()}no limit`
			: `${used} of ${formatBytes(c.memoryLimitBytes, 2)} (${pct(c.memoryUsagePercent)})`
	rows.push(optional(kv("mem", mem, width, role), 1))
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
		rows.push(i === 0 ? keep(line) : optional(line, 4))
	})
	if (alerts.length > MAX_ALERTS)
		rows.push(
			optional(
				kv("", `+${alerts.length - MAX_ALERTS} more`, width, "label"),
				4,
			),
		)
	return rows
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
			one(2, txt(`pid ${p.pid ?? glyphs().na}`, role)),
			...extra,
			one(1, txt(`${p.restartCount} restarts`, role)),
		],
		width,
	)
}

function hostBlock(state: AppState, h: SdrHostView, width: number): Row[] {
	const now = state.now
	const g = glyphs()
	const unreachable = h.fetchError !== null
	// Spec §6.5: when core cannot reach the Pi, the block's rows go dim.
	const role: Role =
		unreachable || isOld(state.resources, now) ? "old" : "value"
	const polled = h.lastFetchedAt
		? `${formatAge(now - Date.parse(h.lastFetchedAt))} ago`
		: "?"
	const rows: Row[] = [
		keep(
			fitDot(
				lbl("SDR HOST", true),
				[
					one(0, txt(sanitize(h.sourceId))),
					one(2, txt(sanitize(h.apiUrl))),
					one(1, txt(`polled by core ${polled}`)),
					one(3, txt(`uptime ${formatDuration(h.uptime)}`)),
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
	rows.push(keep(procRow("rtl_tcp", h.rtlTcp, [], role, width)))
	const mux = h.rtlmux
	rows.push(
		keep(
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
							one(1, txt(formatRate(mux.bytesPerSec), role)),
							one(4, txt(`${formatBytes(mux.totalBytesSent)} sent`, role)),
						]
					: [],
				role,
				width,
			),
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
		const rate =
			smp.upstream.bytesPerSec === null
				? "?"
				: formatRate(smp.upstream.bytesPerSec)
		rows.push(
			keep(
				fitDot(
					lbl("sampling"),
					[
						one(0, [glyphSpan(glyph), sp(` ${smp.state}`, role)]),
						one(1, txt(`sample age ${formatSampleAge(smp.sampleAgeMs)}`, role)),
						one(2, txt(`${rate} upstream (${smp.upstream.rateStatus})`, role)),
						one(3, txt(`${smp.epoch.resets} resets`, role)),
					],
					width,
				),
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
	rows.push(optional(kv("dongle", dongle, width, role), 3))
	for (const w of h.warnings)
		rows.push(keep(kv("warning", quote(w), width, "attention")))
	for (const e of h.errors)
		rows.push(keep(kv("error", quote(e), width, "fault")))
	return rows
}

function resultParts(rec: ActionRecord): {
	failed: string | null
	unknown: boolean
} {
	const r = rec.outcomes[0]?.result
	if (rec.state === "failed")
		return {
			failed: `${r?.status ?? "network"}${sep()}${quote(r?.message ?? "?")}`,
			unknown: false,
		}
	return { failed: null, unknown: r?.outcome === "unknown" }
}

/**
 * Result line for 10 s after the last outcome, in CLI words (R29): "audio started · 0
 * clients", "audio stop sent · no reply in 10s" (R23), `audio start failed · 503 · "…"`.
 */
export function audioResultText(state: AppState, now: number): string | null {
	let best: { at: number; text: string } | null = null
	for (const key of ["audio", "preset"] as const) {
		const rec = own(state.actions.byKey, key)
		if (!rec || rec.outcomes.length === 0) continue
		const ats = rec.outcomes
			.map(o => o.at)
			.filter((x): x is number => x !== null)
		const doneAt = rec.doneAt ?? (ats.length > 0 ? Math.max(...ats) : null)
		if (doneAt === null || now - doneAt > RESULT_MS) continue
		const { failed, unknown } = resultParts(rec)
		const noReply = `sent${sep()}no reply in ${Math.round(RESULT_MS / 1000)}s`
		const intent = rec.intent
		let text: string | null = null
		if (intent.kind === "audio") {
			text = failed
				? `audio ${intent.op} failed${sep()}${failed}`
				: unknown
					? `audio ${intent.op} ${noReply}`
					: `audio ${intent.op === "start" ? "started" : "stopped"}${sep()}${state.audio.value?.clientCount ?? "?"} clients`
		} else if (intent.kind === "preset") {
			const name = sanitize(intent.name)
			text = failed
				? `preset ${name} failed${sep()}${failed}`
				: unknown
					? `preset ${name} ${noReply}`
					: `preset ${name} applied`
		}
		if (text !== null && (best === null || doneAt > best.at))
			best = { at: doneAt, text }
	}
	return best?.text ?? null
}

function audioBlock(state: AppState, width: number): Row[] {
	const a = state.audio.value
	if (!a)
		return [
			keep(
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
	const word =
		a.pipelineHealth === "error"
			? "error"
			: a.running
				? "running"
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
	const centre = state.tuner.value?.find(
		t => t.sourceId === a.sourceId,
	)?.frequency
	const rows: Row[] = [
		keep(
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
			2,
		),
	]
	const result = audioResultText(state, state.now)
	if (result) rows.push(keep(kv("result", result, width)))
	if (a.lastError)
		rows.push(keep(kv("error", quote(a.lastError), width, "fault")))
	return rows
}

function coreBlock(state: AppState, width: number): Row[] {
	const s = state.status.value
	if (!s)
		return [
			keep(kv("CORE", noData(state, "/api/status"), width, "label", true)),
		]
	const role: Role = isOld(state.status, state.now) ? "old" : "value"
	const rows: Row[] = [
		keep(
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
						`${sanitize(c.name)} ${sanitize(c.status)} ${quote(c.message)}`,
						width,
						"label",
					),
					5,
				),
			)
	return rows
}

/** Spec §6.5 order: CONTAINER (+alerts), SDR HOST per host, AUDIO, CORE. */
export function systemLines(
	state: AppState,
	width: number,
	height: number,
	roomy: boolean,
): Line[] {
	const gap = (): Row[] => (roomy ? [optional([], 6)] : [])
	const hosts = state.resources.value?.sdrHosts ?? []
	const hostRows: Row[] =
		hosts.length > 0
			? hosts.flatMap((h, i) => [
					...(i > 0 ? gap() : []),
					...hostBlock(state, h, width),
				])
			: [
					keep(
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
	let rows: Row[] = [
		...containerBlock(state, width),
		...gap(),
		...hostRows,
		...gap(),
		...audioBlock(state, width),
		...gap(),
		...coreBlock(state, width),
	]
	while (rows.length > height) {
		const worst = rows.reduce((m, r) => Math.max(m, r.drop ?? -1), -1)
		if (worst < 0) break
		const at = rows.map(r => r.drop ?? -1).lastIndexOf(worst)
		rows = rows.filter((_, i) => i !== at)
	}
	return rows.map(r => r.line).slice(0, height)
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
		prompt: `apply audio preset "${name}" (${name} ${kHz(p.bandwidth)})?`,
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
