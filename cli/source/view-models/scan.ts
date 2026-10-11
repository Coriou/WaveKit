import type { AppState } from "../data/types.js"
import type { ScanLane } from "../data/scan-state.js"
import type { ScanJob, ScanDiscovery } from "../data/scanner-guards.js"
import { sp, type Line } from "../ui/line.js"
import { sanitize, truncate } from "../ui/text.js"
import { glyphs } from "../ui/theme.js"
import type { UiState } from "../ui/ui-state.js"

export function scanSources(state: AppState): string[] {
	return (state.sources.value ?? [])
		.filter(
			s =>
				s.caps.kind !== "audio_pcm" &&
				["U8_IQ", "S16_IQ", "FLOAT32LE"].includes(s.caps.format),
		)
		.slice(0, 128)
		.map(s => s.id)
}
export function scanLaneText(
	lane: ScanLane<unknown>,
	empty: string,
	now: number,
): string | null {
	if (lane.error) return lane.error
	if (lane.at === null) return "API response pending"
	if (now - lane.at > 15000) return "cached data is stale"
	if (
		lane.value === null ||
		(Array.isArray(lane.value) && lane.value.length === 0)
	)
		return empty
	return null
}
export function scanRowIds(state: AppState, ui: UiState): string[] {
	if (ui.scan.tab === "jobs")
		return (state.scan.lanes.jobs.value ?? [])
			.filter(j => j.spec.sourceId === ui.scan.sourceId)
			.map(j => j.id)
	if (ui.scan.tab === "discoveries")
		return (state.scan.lanes.discoveries.value?.items ?? []).map(d => d.id)
	return []
}
const number = (n: number | null, unit: string) =>
	n === null ? `? ${unit}` : `${n.toFixed(1)} ${unit}`
function jobLines(j: ScanJob): string[] {
	const out = [
		`${j.name ?? j.id}`,
		`${j.state}${j.reason ? ` (${j.reason})` : ""} | ${j.spec.mode} ${j.spec.kind} | source ${j.spec.sourceId}`,
		`hop ${j.progress.hopCount ? `${j.progress.hopIndex + 1}/${j.progress.hopCount}` : "none"} | sweep ${j.progress.sweepIndex} | coverage ${(j.progress.coverage * 100).toFixed(0)}% | probes ${j.progress.probes.length}`,
		`unrestorable: ${j.unrestorable.length ? j.unrestorable.join(", ") : "none reported"}`,
		"Terminal job state does not establish settled recording files.",
	]
	if (j.identify) {
		if (j.identify.targets.length === 0)
			out.push("identify targets: none reported")
		for (const t of j.identify.targets) {
			if (out.length >= 4096) {
				out.push("Further identify detail rows omitted")
				break
			}
			out.push(`${t.targetHz} Hz | ${t.state}`)
			for (const trial of t.trials) {
				if (out.length >= 4096) break
				out.push(
					`  ${trial.protocol} | ${trial.decoder ?? "no decoder"} | ${trial.transport ?? "no transport"} | ${trial.outcome}${trial.reason ? ` (${trial.reason})` : ""}`,
				)
			}
			const r = t.result
			if (r) {
				out.push(
					`result: ${r.protocol ?? "unknown"} | ${r.confidence}${r.identity ? ` | ${r.identity.kind}:${r.identity.value}` : ""}${r.artefact ? ` | artefact ${r.artefact}` : ""}${r.ended ? ` | ${r.ended}` : ""}`,
				)
				out.push(
					`RF (${r.measurements.source}): ${r.measurements.centreHz} Hz | OBW ${number(r.measurements.obwHz, "Hz")} | peak ${number(r.measurements.peakDbfs, "dBFS")} | SNR ${number(r.measurements.snrDb, "dB")}`,
				)
				out.push(
					`floor ${number(r.measurements.floorDbfs, "dBFS")} | duty ${r.measurements.dutyCycle === null ? "?" : (r.measurements.dutyCycle * 100).toFixed(1) + "%"} | class ${r.measurements.class}`,
				)
			}
		}
	}
	return out.length > 4096
		? [...out.slice(0, 4095), `${out.length - 4095} detail rows omitted`]
		: out
}
function discoveryLines(d: ScanDiscovery): string[] {
	return [
		`${d.frequencyHz} Hz | ${d.protocol} | ${d.confidence}${d.confidenceCap ? ` (${d.confidenceCap})` : ""}`,
		`identity: ${d.identity ? `${d.identity.kind}:${d.identity.value}` : "unknown"} | encrypted ${d.encrypted ? "yes" : "no"}`,
		`trust ${d.tuningTrust} | ${d.undecodedReason ?? "no undecoded reason reported"}`,
		`BW ${d.bandwidthHz} Hz | SNR ${d.signal.last.snrDb.toFixed(1)} dB | peak ${d.signal.last.peakDbfs.toFixed(1)} dBFS`,
		`observations ${d.observationCount} | airtime ${d.airtimeMs} ms | last seen ${d.lastSeenAt}`,
		`sources ${d.sourceIds.join(", ")} | jobs ${d.jobIds.join(", ")}`,
		`TG ${d.metadata.talkgroups.join(", ") || "?"} | SRC ${d.metadata.sources.join(", ") || "?"} | slots ${d.metadata.slots.join(", ") || "?"}`,
		`evidence flags: recordings ${d.evidence.recordings}, PSD ${d.evidence.psd ? "yes" : "no"}, IQ ${d.evidence.iq ? "yes" : "no"}`,
		"Evidence flags do not establish finalized files or download availability.",
	]
}
export function scanDetail(state: AppState, ui: UiState): string[] {
	if (ui.scan.tab === "jobs") {
		const l = state.scan.lanes.job
		return l.value
			? [
					...(scanLaneText(l, "job unavailable", state.now)
						? [`Cached job: ${scanLaneText(l, "job unavailable", state.now)}`]
						: []),
					...jobLines(l.value),
				]
			: [scanLaneText(l, "job unavailable", state.now) ?? "job unavailable"]
	}
	const l = state.scan.lanes.discovery
	if (!l.value)
		return [
			scanLaneText(l, "discovery unavailable", state.now) ??
				"discovery unavailable",
		]
	const observations = state.scan.lanes.observations
	return [
		...(scanLaneText(l, "discovery unavailable", state.now)
			? [
					`Cached discovery: ${scanLaneText(l, "discovery unavailable", state.now)}`,
				]
			: []),
		...discoveryLines(l.value),
		`observation page: ${observations.error ?? (observations.value ? `${observations.value.items.length} shown${observations.value.nextCursor ? ", more available" : ""}` : "API response pending")}`,
	]
}
export function scanModel(
	state: AppState,
	ui: UiState,
	width: number,
	height: number,
): { lines: Line[]; plotHeight: number; detailRows: number } {
	const scan = state.scan
	const sep = ` ${glyphs().sep} `
	const line = (
		text: string,
		role: "value" | "attention" | "label" | "old" = "value",
	): Line => [sp(truncate(sanitize(text), width), role)]
	const source = ui.scan.sourceId
	const selected = state.sources.value?.find(s => s.id === source)
	const header: Line[] = [
		line(
			`SCAN${sep}${source ?? "no eligible IQ source"}${sep}${ui.scan.tab}${sep}read-only`,
			"label",
		),
	]
	const status = scan.lanes.status
	const statusText = scanLaneText(
		status,
		"scanner status unavailable",
		state.now,
	)
	const engine = status.value?.engines.find(e => e.sourceId === source)
	header.push(
		line(
			source === null
				? "select an IQ source to request scanner status"
				: (statusText ??
						`scanner ${status.value?.enabled ? "enabled" : "disabled"}${sep}engine ${engine?.state ?? "unknown"}${sep}passive ${engine?.passive.enabled ? "enabled (not proof of a job)" : "off"}${sep}${status.value?.jobs.active ?? "?"} active jobs`),
			statusText ? "attention" : "value",
		),
	)
	if (status.value && height >= 18)
		header.push(
			line(
				`channelizer ${status.value.channelizerAvailable ? "available" : "unavailable"}${sep}CPU ${status.value.budgets.cpuCoresInUse}/${status.value.budgets.cpuBudgetCores} cores${sep}guard ${status.value.cpuGuard.percent ?? "?"}%${sep}disk ${status.value.disk}`,
				"label",
			),
		)
	if (ui.detail.scan.open) {
		const rows = scanDetail(state, ui)
		const detail = rows
			.slice(
				ui.detail.scan.scroll,
				ui.detail.scan.scroll + Math.max(0, height - header.length - 1),
			)
			.map(t => line(t))
		return {
			lines: [
				...header,
				line(`DETAIL${sep}PgUp/PgDn scroll${sep}Esc back`, "label"),
				...detail,
			].slice(0, height),
			plotHeight: 0,
			detailRows: rows.length,
		}
	}
	if (ui.scan.tab === "spectrum") {
		const last = scan.rows[scan.rows.length - 1]
		const fresh = !!last && state.now - last.receivedAt <= 5000
		const p = scan.profile
		const served = p?.profile
			? `${p.sourceId ?? "all"} ${p.profile.hz}Hz x ${p.profile.bins} (${p.outcome}${p.adjusted.length ? `: ${p.adjusted.join(",")}` : ""})`
			: "pending"
		header.push(
			line(
				`profile requested 5Hz x 512${sep}served ${served}${sep}effective ${p?.effectiveHz ?? "?"}Hz`,
				"label",
			),
		)
		const why =
			scan.error ??
			scan.lanes.spectrum.error ??
			(scan.phase === "removed"
				? "source removed"
				: selected?.activity?.state !== "streaming" && selected?.activity
					? selected.activity.state
					: !fresh
						? last
							? `stale: last frame ${Math.max(0, Math.floor((state.now - last.receivedAt) / 1000))}s ago`
							: scan.phase
						: "fresh")
		header.push(
			line(
				`spectrum ${why}${sep}${fresh ? last.frame.tuningTrust : "axis unavailable"}${scan.invalidFrames ? `${sep}${scan.invalidFrames} invalid Scan events ignored` : ""}${sep}r reconnect to refresh/retry`,
				fresh && !scan.error ? "value" : "attention",
			),
		)
		if (last && fresh) {
			const f = last.frame
			header.push(
				line(
					`axis ${f.startHz}..${f.startHz + f.binCount * f.binHz} Hz${sep}${f.binCount} bins${sep}width ${f.binHz} Hz (native ${f.nativeBinHz})`,
					f.tuningTrust === "unverified" ? "old" : "value",
				),
			)
			header.push(
				line(
					`floor ${f.floorDbfs.toFixed(1)} dBFS${sep}threshold ${(f.floorDbfs + f.thresholdDb).toFixed(1)} dBFS${sep}tracks ${f.tracks.length}${sep}DC ${f.masks.dcHz} +/-${f.masks.dcGuardHz} Hz${sep}spurs ${f.masks.spurRanges.length}`,
				),
			)
		}
		header.push(
			line(
				"power ramp: -120..-20 dBFS (clipped), max-hold; newest row below",
				"label",
			),
		)
		return {
			lines: header.slice(0, height),
			plotHeight:
				fresh && !scan.error ? Math.max(0, height - header.length) : 0,
			detailRows: 0,
		}
	}
	const ids = scanRowIds(state, ui)
	const lane = ui.scan.tab === "jobs" ? scan.lanes.jobs : scan.lanes.discoveries
	const problem = scanLaneText(
		lane,
		ui.scan.tab === "jobs" ? "no jobs for this source" : "no discoveries",
		state.now,
	)
	header.push(
		line(
			ui.scan.tab === "jobs"
				? `JOBS${sep}${ids.length} shown for source${sep}${scan.omittedJobs} omitted globally (200 job display cap)`
				: `DISCOVERIES${sep}${ids.length} shown${sep}${scan.lanes.discoveries.value?.nextCursor ? "more: n next page" : "last page"}${sep}f first page`,
			"label",
		),
	)
	if (problem) header.push(line(problem, "attention"))
	if (!problem && ids.length === 0)
		header.push(
			line(
				ui.scan.tab === "jobs" ? "no jobs for this source" : "no discoveries",
			),
		)
	const selectedIndex = Math.max(0, ids.indexOf(ui.selected.scan ?? ""))
	const room = Math.max(0, height - header.length)
	const start = Math.max(0, selectedIndex - room + 1)
	for (const id of ids.slice(start, start + room)) {
		const d = scan.lanes.discoveries.value?.items.find(x => x.id === id)
		const j = scan.lanes.jobs.value?.find(x => x.id === id)
		const text =
			ui.scan.tab === "jobs" && j
				? `${j.state}${j.reason ? ` (${j.reason})` : ""}${sep}${j.spec.kind}/${j.spec.mode}${sep}${j.id}`
				: d
					? `${d.frequencyHz} Hz${sep}${d.protocol}${sep}${d.confidence}${d.encrypted ? " ENC" : ""}${sep}SNR ${d.signal.last.snrDb.toFixed(1)}dB${sep}${d.observationCount} obs`
					: id
		header.push([
			sp(
				truncate(sanitize(text), width),
				id === ui.selected.scan ? "selected" : "value",
			),
		])
	}
	return { lines: header.slice(0, height), plotHeight: 0, detailRows: 0 }
}
