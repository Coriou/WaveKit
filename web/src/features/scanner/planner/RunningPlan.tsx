// Running mode of "Scan a band" (DESIGN.md, Scanner second pass): one lane on the true frequency scale with numbered
// range bars, the capture window as a bracket at its real width moved by transform at the progress rate, the pass
// fill, hatched skips and discovery ticks (solid decoded, hollow maybe, pulsing active; click tunes); amber while
// paused. Range on/off, protocols and skips change mid-run behind "N changes waiting · Discard · Apply"; edges and
// spacing are locked. No Pause or Stop here: the Tuner's hold row owns them. Only RunWindow and RunFooter read
// the 2 Hz progress store.
import {
	memo,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react"
import type {
	Discovery,
	ScanExclusion,
	ScanJob,
	ScannerProgressEventData,
	ScannerProtocol,
} from "@wavekit/api-types"

import { useReadOnly, useServices } from "../../../app/context.ts"
import { errorMessage } from "../../../data/api-client.ts"
import {
	confidenceText,
	discoveryTitle,
	jobStateLine,
	scanPhaseText,
	sweepProgress,
} from "../../../data/scanner-format.ts"
import { planIssues } from "../../../data/scanner-store.ts"
import { useStore } from "../../../data/store.ts"
import { Button } from "../../../ui/Button.tsx"
import { Switch } from "../../../ui/Switch.tsx"
import { formatMHz } from "../../format.ts"
import { useNow, useTunerState } from "../../hooks.ts"
import {
	Glyph,
	Popover,
	ProtocolChips,
	ProtocolPicker,
	SkipsEditor,
	type AutoSkip,
	type PlannerSize,
	type PopAnchor,
} from "./parts.tsx"
import {
	changedRanges,
	draftFits,
	draftOf,
	patchSpec,
	pendingText,
	runChanges,
	type RunDraft,
} from "./pending.ts"
import {
	passPhrase,
	protocolLabels,
	sentence,
	skipsIn,
	spacingText,
} from "./plan.ts"
import {
	mergeStretches,
	labelled,
	scaleTicks,
	scaleWidth,
	scaleX,
	segmentedScale,
	type Scale,
} from "./ruler.ts"
import { autoSkipsOf, useDecoderName } from "./SetupPlan.tsx"
import { useWidth } from "./SetupRuler.tsx"

export interface RunningPlanProps {
	job: ScanJob
	mode: "pane" | "screen"
	size: PlannerSize
	root: HTMLElement | null
	onHide: () => void
}

type Pop = { kind: "protos" | "skips"; index: number; anchor: PopAnchor }

const LANE_TOP = 34
const LANE_H = 30
const AXIS_TOP = 72
const RULER_H = 96
const MAX_TICKS = 300

const spacingsOf = (r: ScanJob["spec"]["ranges"][number]) =>
	[...new Set((r.rasters ?? []).map(x => Math.round(x.spacingHz)))].sort(
		(a, b) => b - a,
	)

const NO_HITS: ReadonlyMap<string, unknown> = new Map()

export function RunningPlan({
	job,
	mode,
	size,
	root,
	onHide,
}: RunningPlanProps) {
	const { data } = useServices()
	const readOnly = useReadOnly()
	const decoderName = useDecoderName()
	const [draft, setDraft] = useState<RunDraft | null>(null)
	const [pop, setPop] = useState<Pop | null>(null)
	const [applying, setApplying] = useState(false)
	const [applyError, setApplyError] = useState<string | null>(null)
	const [toast, setToast] = useState<string | null>(null)

	// a draft made for other ranges (the job was re-planned under it) is dropped
	useEffect(() => {
		if (draft && !draftFits(job, draft)) setDraft(null)
	}, [job, draft])
	useEffect(() => {
		if (!toast) return
		const t = setTimeout(() => setToast(null), 4000)
		return () => clearTimeout(t)
	}, [toast])

	const current = draft ?? draftOf(job)
	const changes = draft ? runChanges(job, draft) : []
	const changed = draft ? changedRanges(job, draft) : new Set<number>()
	const edit = (fn: (d: RunDraft) => RunDraft) => {
		setApplyError(null)
		setDraft(fn(current))
	}
	const apply = () => {
		if (!draft) return
		setApplying(true)
		data.scanner.patchJob(job.id, patchSpec(job, draft)).then(
			() => {
				setApplying(false)
				setDraft(null)
				setToast("Applied · at the next hop")
			},
			(error: unknown) => {
				setApplying(false)
				setApplyError(
					sentence(planIssues(error)[0]?.message ?? errorMessage(error)),
				)
			},
		)
	}

	// display order: by frequency; the number is the row's place, the index the job's
	const rows = useMemo(
		() =>
			job.spec.ranges
				.map((r, index) => ({ r, index }))
				.sort((a, b) => a.r.startHz - b.r.startHz || a.index - b.index),
		[job.spec.ranges],
	)
	const autoSkips = useMemo(
		() => autoSkipsOf(job, decoderName),
		[job, decoderName],
	)

	const paused = job.state === "paused"
	const name =
		job.name ??
		job.spec.ranges
			.map(r => r.name)
			.filter(Boolean)
			.join(" + ") ??
		"Scan"
	const popRow = pop ? (rows.find(x => x.index === pop.index) ?? null) : null
	const exclKeyed = current.exclusions.map((x, i) => ({ ...x, key: `e${i}` }))

	return (
		<>
			<header className="wk-pl-head">
				<div className="wk-pl-title">
					{mode === "screen" && (
						<>
							<Button
								variant="ghost"
								size="lg"
								className="wk-pl-back"
								onClick={onHide}
								aria-label="Back to Scanner"
								title="Back to Scanner · Esc"
							>
								<Glyph name="back" size={18} />
								Scanner
							</Button>
							<span className="wk-pl-vsep" aria-hidden="true" />
						</>
					)}
					<Glyph name="scan" size={18} className="wk-pl-runglyph" />
					<h2 className="wk-h2 wk-pl-ellipsis" title={name}>
						{name || "Scan"}
					</h2>
				</div>
				{mode === "pane" && (
					<Button
						variant="ghost"
						size="lg"
						className="wk-pl-hide"
						onClick={onHide}
						aria-label="Hide the plan"
						title="Hide the plan · the scan carries on · Esc"
					>
						Hide
						<Glyph name="hide" size={16} />
					</Button>
				)}
			</header>

			<section aria-label="Ruler" className="wk-pl-rulersec">
				<RunRuler
					job={job}
					rows={rows}
					draft={current}
					autoSkips={autoSkips}
					paused={paused}
				/>
			</section>

			<div
				className="wk-pl-table wk-scroll"
				role="table"
				aria-label="Ranges"
				data-running=""
			>
				{size === "wide" && (
					<div role="row" className="wk-pl-row wk-pl-headrow">
						<span
							role="columnheader"
							className="wk-label wk-pl-th"
							data-strong=""
							style={{ gridArea: "n" }}
						>
							#
						</span>
						<span
							role="columnheader"
							className="wk-label wk-pl-th"
							data-strong=""
							style={{ gridArea: "name" }}
						>
							Name
						</span>
						<span
							role="columnheader"
							className="wk-label wk-pl-th"
							data-strong=""
							style={{ gridArea: "edges" }}
						>
							Edges <span className="wk-pl-unit">MHz</span>
						</span>
						<span
							role="columnheader"
							className="wk-label wk-pl-th"
							data-strong=""
							style={{ gridArea: "sp" }}
						>
							Channel spacing
						</span>
						<span
							role="columnheader"
							className="wk-label wk-pl-th"
							data-strong=""
							style={{ gridArea: "protos" }}
						>
							Protocols
						</span>
						<span
							role="columnheader"
							className="wk-label wk-pl-th"
							data-strong=""
							style={{ gridArea: "skips" }}
						>
							Skips
						</span>
						<span
							role="columnheader"
							className="wk-label wk-pl-th"
							data-strong=""
							style={{ gridArea: "act", textAlign: "right" }}
						>
							Scan
						</span>
					</div>
				)}
				{rows.map(({ r, index }, i) => {
					const on = current.enabled[index] ?? true
					const protocols = current.protocols[index] ?? []
					const mine = skipsIn(current.exclusions, r)
					const auto = skipsIn(autoSkips, r)
					const n = mine.length + auto.length
					const why = [
						...new Set([
							...auto.map(x => x.why),
							...mine.map(x => x.reason ?? "yours"),
						]),
					]
					const skipText = n === 0 ? "None" : `${n} · ${why.join(", ")}`
					const label = r.name ?? `Range ${i + 1}`
					return (
						<div
							key={index}
							role="row"
							className="wk-pl-row"
							data-off={!on || undefined}
							aria-label={`Range ${i + 1}, ${label}`}
						>
							<span role="cell" className="wk-pl-c-n">
								<span className="wk-pl-num">{i + 1}</span>
							</span>
							<span role="cell" className="wk-pl-c-name">
								<span className="wk-pl-name" title={label}>
									{label}
								</span>
								{changed.has(index) && (
									<span
										className="wk-pl-pend"
										role="img"
										aria-label="Change waiting"
										title="Change waiting for Apply"
									/>
								)}
							</span>
							<span role="cell" className="wk-pl-c-edges">
								<span className="wk-pl-locked" title="Stop to change edges">
									<Glyph name="lock" size={12} />
									{formatMHz(r.startHz)}–{formatMHz(r.endHz)}
								</span>
							</span>
							<span role="cell" className="wk-pl-c-sp">
								<span
									className="wk-pl-cell wk-pl-spchip"
									aria-disabled="true"
									title="Stop to change spacing"
								>
									<span className="wk-pl-ellipsis">
										{spacingText(spacingsOf(r))}
									</span>
								</span>
							</span>
							<span role="cell" className="wk-pl-c-protos">
								<button
									type="button"
									className="wk-pl-cell wk-pl-protos"
									aria-haspopup="dialog"
									disabled={readOnly}
									aria-label={`Protocols for ${label}: ${protocolLabels(protocols).join(", ") || "any signal"}`}
									onClick={e =>
										setPop({
											kind: "protos",
											index,
											anchor: { el: e.currentTarget },
										})
									}
								>
									<ProtocolChips
										protocols={protocols}
										off={job.spec.signalsOnly === true}
									/>
									<Glyph name="pencil" size={13} className="wk-pl-edit" />
								</button>
							</span>
							<span role="cell" className="wk-pl-c-skips">
								<button
									type="button"
									className="wk-pl-cell wk-pl-skips"
									aria-haspopup="dialog"
									disabled={readOnly}
									aria-label={`Skips in ${label}: ${skipText}`}
									title={skipText}
									onClick={e =>
										setPop({
											kind: "skips",
											index,
											anchor: { el: e.currentTarget },
										})
									}
								>
									{n > 0 && <span className="wk-pl-hatch" aria-hidden="true" />}
									<span className="wk-pl-ellipsis">{skipText}</span>
								</button>
							</span>
							<span role="cell" className="wk-pl-c-act">
								<Switch
									checked={on}
									disabled={readOnly}
									aria-label={`Scan ${label}`}
									title={
										on
											? "Scanned · switch off to leave it out"
											: "Left out · switch on to scan it"
									}
									onChange={v =>
										edit(d => ({
											...d,
											enabled: d.enabled.map((x, k) => (k === index ? v : x)),
										}))
									}
								/>
							</span>
						</div>
					)
				})}
			</div>

			{toast && (
				<div role="status" className="wk-toast wk-pl-toast">
					<span className="wk-pl-toasttext">{toast}</span>
				</div>
			)}

			{changes.length > 0 ? (
				<div
					role="region"
					aria-label="Changes waiting to be applied"
					className="wk-pl-pending"
				>
					<span className="wk-pl-penddot" aria-hidden="true" />
					<span
						className="wk-pl-pendtext"
						title={applyError ?? "Apply re-plans the scan at its next hop"}
					>
						{applyError ?? pendingText(changes.length)}
					</span>
					<Button
						size="lg"
						className="wk-pl-discard"
						onClick={() => {
							setDraft(null)
							setApplyError(null)
						}}
					>
						Discard
					</Button>
					<Button
						variant="amber"
						size="lg"
						disabled={applying}
						title="Re-plans at the next hop"
						onClick={apply}
					>
						{applying ? "Applying…" : "Apply"}
					</Button>
				</div>
			) : (
				<footer className="wk-pl-foot">
					<RunFooter job={job} />
				</footer>
			)}

			{pop && popRow && (
				<Popover
					anchor={pop.anchor}
					root={root}
					width={pop.kind === "skips" ? 380 : 320}
					label={`${pop.kind === "skips" ? "Skips in" : "Protocols for"} ${popRow.r.name ?? `range ${pop.index + 1}`}`}
					onClose={() => setPop(null)}
				>
					{pop.kind === "protos" ? (
						<ProtocolPicker
							protocols={current.protocols[pop.index] ?? []}
							signalsOnly={job.spec.signalsOnly === true}
							onChange={(ps: ScannerProtocol[]) =>
								edit(d => ({
									...d,
									protocols: d.protocols.map((x, k) =>
										k === pop.index ? ps : x,
									),
								}))
							}
						/>
					) : (
						<SkipsEditor
							name={popRow.r.name ?? `range ${pop.index + 1}`}
							range={popRow.r}
							skips={skipsIn(exclKeyed, popRow.r)}
							auto={skipsIn(autoSkips, popRow.r)}
							onAdd={(lo, hi) =>
								edit(d => ({
									...d,
									exclusions: [
										...d.exclusions,
										{ startHz: lo, endHz: hi, reason: "Skipped by you" },
									].sort((a, b) => a.startHz - b.startHz),
								}))
							}
							onRemove={key =>
								edit(d => ({
									...d,
									exclusions: d.exclusions.filter((_, k) => `e${k}` !== key),
								}))
							}
							onChange={(key, lo, hi) =>
								edit(d => ({
									...d,
									exclusions: d.exclusions.map(
										(x, k): ScanExclusion =>
											`e${k}` === key ? { ...x, startHz: lo, endHz: hi } : x,
									),
								}))
							}
						/>
					)}
				</Popover>
			)}
		</>
	)
}

// ---- the one-lane ruler

interface RowRef {
	readonly r: ScanJob["spec"]["ranges"][number]
	readonly index: number
}

const RunRuler = memo(function RunRuler({
	job,
	rows,
	draft,
	autoSkips,
	paused,
}: {
	job: ScanJob
	rows: readonly RowRef[]
	draft: RunDraft
	autoSkips: readonly AutoSkip[]
	paused: boolean
}) {
	const { data, tuning } = useServices()
	const [trackRef, w] = useWidth<HTMLDivElement>()
	const scale = useMemo(
		() => segmentedScale(job.spec.ranges, w),
		[job.spec.ranges, w],
	)
	const axis = useMemo(
		() => (w > 0 ? labelled(scaleTicks(scale, 90), w) : []),
		[scale, w],
	)
	const X = (hz: number) => scaleX(scale, hz) ?? 0

	// discoveries this sweep heard: its hits, plus any loaded discovery credited to it
	const hits = useStore(data.scanner, s => s.jobHits.get(job.id) ?? NO_HITS)
	const byId = useStore(data.scanner, s => s.discoveries.byId)
	const activeNow = useStore(data.scanner, s => s.activeNow)
	const ticks = useMemo(() => {
		const seen = new Map<string, Discovery>()
		for (const id of hits.keys()) {
			const d = byId.get(id)
			if (d) seen.set(id, d)
		}
		for (const d of byId.values())
			if (d.jobIds.includes(job.id)) seen.set(d.id, d)
		const inside = [...seen.values()].filter(d =>
			job.spec.ranges.some(
				r => d.frequencyHz >= r.startHz && d.frequencyHz <= r.endHz,
			),
		)
		return inside.slice(0, MAX_TICKS)
	}, [hits, byId, job.id, job.spec.ranges])

	const skips = [
		...draft.exclusions.map(x => ({ ...x, why: x.reason ?? "Skipped by you" })),
		...autoSkips,
	]
	const tags = rows.map(({ r, index }, i) => ({
		num: i + 1,
		index,
		x0: X(r.startHz),
		x1: X(r.endHz),
	}))

	return (
		<div
			className="wk-pl-ruler"
			data-running=""
			data-paused={paused || undefined}
			style={{ height: RULER_H }}
		>
			<div ref={trackRef} className="wk-pl-track" data-running="">
				{w > 0 &&
					rows.map(({ r, index }) => {
						const x0 = X(r.startHz)
						const x1 = X(r.endHz)
						return (
							<span
								key={index}
								className="wk-pl-runbar"
								data-off={!(draft.enabled[index] ?? true) || undefined}
								title={`${r.name ?? "Range"} · ${formatMHz(r.startHz)}–${formatMHz(r.endHz)} MHz`}
								style={{
									top: LANE_TOP,
									height: LANE_H,
									left: x0,
									width: Math.max(2, x1 - x0),
								}}
							/>
						)
					})}
				{w > 0 && <RunWindow job={job} scale={scale} />}
				{w > 0 &&
					skips.map(x => {
						const x0 = X(x.startHz)
						const x1 = X(x.endHz)
						return (
							<span
								key={`${x.startHz}:${x.endHz}:${x.why}`}
								className="wk-pl-skip"
								title={`${formatMHz(x.startHz)}–${formatMHz(x.endHz)} · ${x.why}`}
								style={{
									top: LANE_TOP + 4,
									height: LANE_H - 8,
									left: x0,
									width: Math.max(2, x1 - x0),
								}}
							/>
						)
					})}
				{scale.breaks.map(b => (
					<span
						key={b.x0}
						className="wk-pl-break"
						title="Break in the scale"
						style={{
							left: b.x0,
							width: b.x1 - b.x0,
							top: LANE_TOP,
							height: LANE_H,
						}}
					>
						≈
					</span>
				))}
				{w > 0 &&
					tags.map(t => (
						<span
							key={t.num}
							className="wk-pl-tag"
							aria-hidden="true"
							style={{
								top: LANE_TOP + 6,
								left: Math.max(2, Math.min(w - 20, t.x0 + 3)),
							}}
						>
							{t.num}
						</span>
					))}
				{w > 0 &&
					ticks.map(d => {
						const solid = d.confidence === "decoded"
						const heard = d.confidence === "activity"
						return (
							<button
								key={d.id}
								type="button"
								className="wk-pl-hit"
								data-solid={solid || undefined}
								data-heard={heard || undefined}
								data-active={activeNow.has(d.id) || undefined}
								aria-label={`${discoveryTitle(d)}, ${formatMHz(d.frequencyHz)} MHz. Tune`}
								title={`${formatMHz(d.frequencyHz)} MHz · ${discoveryTitle(d)}${solid ? "" : ` (${confidenceText(d)})`} · click to tune`}
								style={{ left: X(d.frequencyHz), top: 4 }}
								onClick={() => void tuning.tune(d.frequencyHz)}
							>
								<span className="wk-pl-hitdot" />
							</button>
						)
					})}
				<div
					className="wk-pl-axis"
					style={{ top: AXIS_TOP }}
					aria-hidden="true"
				>
					{axis.map(t => (
						<span
							key={`${t.hz}:${t.x}`}
							className="wk-pl-tick"
							style={{ left: t.x }}
						>
							<span className="wk-pl-ticktext">{t.text}</span>
						</span>
					))}
				</div>
			</div>
		</div>
	)
})

/**
 * The capture window and this pass's fill: the only part of the ruler that follows the 2 Hz progress. The bracket
 * moves by transform (a new pass jumps back without a transition).
 */
function RunWindow({ job, scale }: { job: ScanJob; scale: Scale }) {
	const { data } = useServices()
	const p = useStore(data.scanner.progress)
	const tuner = useTunerState()
	const box = useRef<HTMLSpanElement>(null)
	const lastX = useRef<number | null>(null)
	const progress: Pick<
		ScannerProgressEventData,
		"hopIndex" | "centerHz"
	> | null = p && p.jobId === job.id ? p : null
	const hops = job.plan.hops
	const hopIndex = progress?.hopIndex ?? job.progress.hopIndex
	const centreHz = progress?.centerHz || hops[hopIndex]?.centreHz || 0
	const captureHz =
		job.spec.tuner.sampleRateHz ??
		(tuner?.sampleRate && tuner.sampleRate > 0
			? tuner.sampleRate
			: 2 * job.plan.usableHalfSpanHz)
	const wPx = Math.max(6, scaleWidth(scale, centreHz, captureHz))
	const x = (scaleX(scale, centreHz) ?? 0) - wPx / 2

	useLayoutEffect(() => {
		const el = box.current
		if (!el) return
		const back = lastX.current !== null && x < lastX.current - 1
		el.style.transition = back || lastX.current === null ? "none" : ""
		el.style.transform = `translateX(${x}px)`
		lastX.current = x
	}, [x])

	const fill = useMemo(
		() =>
			mergeStretches(hops.slice(0, hopIndex + 1).map(h => h.covered)).map(
				s => ({
					x0: scaleX(scale, s.startHz) ?? 0,
					x1: scaleX(scale, s.endHz) ?? 0,
				}),
			),
		[hops, hopIndex, scale],
	)

	return (
		<>
			{fill.map(f => (
				<span
					key={f.x0}
					className="wk-pl-fill"
					aria-hidden="true"
					style={{
						top: LANE_TOP,
						height: LANE_H,
						left: f.x0,
						width: Math.max(0, f.x1 - f.x0),
					}}
				/>
			))}
			<span
				ref={box}
				className="wk-pl-window"
				role="img"
				aria-label={`Capture window at ${formatMHz(centreHz)} MHz`}
				title={`Listening at ${formatMHz(centreHz)} MHz · ${formatMHz(captureHz)} MHz wide`}
				style={{ top: LANE_TOP - 6, height: LANE_H + 12, width: wPx }}
			/>
		</>
	)
}

/** "Pass 3 · 62 % · full pass ≈ 10 s", one hop "Watching · the receiver stays at 446.100", amber word while paused. */
function RunFooter({ job }: { job: ScanJob }) {
	const { data } = useServices()
	const p = useStore(data.scanner.progress)
	const paused = job.state === "paused"
	const now = useNow(paused, 1000)
	const progress = p && p.jobId === job.id ? p : job.progress
	const sp = sweepProgress(progress)
	const hops = job.plan.hops.length
	const period = job.progress.sweepPeriodMs
	let text: string
	// WG12: a window that fits parks the receiver, like one hop
	if (hops === 1 || progress.parked === true)
		text = `Watching · the receiver stays at ${formatMHz(job.plan.hops[0]?.centreHz ?? 0)}`
	else
		text = `Pass ${sp.pass} · ${sp.percent} %${period !== null ? ` · full pass ${passPhrase(period)}` : ""}`
	// while it runs, say what the scan is doing (WG12 phase); "Watching" is already the parked line
	const phase = job.state === "running" ? scanPhaseText(progress) : null
	const word =
		job.state === "running"
			? phase === "Watching"
				? null
				: phase
			: jobStateLine(job, { now })
	return (
		<span
			role="status"
			className="wk-pl-runstatus"
			title={hops > 1 ? `${hops} hops` : undefined}
		>
			{word && (
				<>
					<span className="wk-pl-runword" data-paused={paused || undefined}>
						{word}
					</span>
					<span aria-hidden="true">·</span>
				</>
			)}
			<span className="wk-pl-ellipsis">{text}</span>
		</span>
	)
}
