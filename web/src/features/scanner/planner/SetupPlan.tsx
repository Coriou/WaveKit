// Setup mode of "Scan a band": presets, the ruler with band-plan lanes, the range table, Options, the plan preview
// (debounced, stale ones aborted), the plan's issues, one amber consent line and "Start · takes the receiver".
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type {
	Impact,
	PlanIssue,
	PlanPreview,
	ResolvedBand,
	ScannerProtocol,
} from "@wavekit/api-types"

import { useReadOnly, useServices } from "../../../app/context.ts"
import { errorMessage } from "../../../data/api-client.ts"
import { planIssues, takeoverImpact } from "../../../data/scanner-store.ts"
import { useStore } from "../../../data/store.ts"
import { Button } from "../../../ui/Button.tsx"
import { Chip } from "../../../ui/Chip.tsx"
import { Seg } from "../../../ui/Seg.tsx"
import { Switch } from "../../../ui/Switch.tsx"
import { decoderLabel } from "../../tuned/signal.ts"
import { closePlan, scannerUi, takePrefill } from "../ui-store.ts"
import { setupStore, setView, updateDraft } from "./draft-store.ts"
import {
	EdgeInput,
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
	addRange,
	addSkip,
	buildSpec,
	consentText,
	customRange,
	DEFAULT_OPTIONS,
	draftValid,
	impactDisturbs,
	kHz,
	optionsChanged,
	parseMHz,
	presetOn,
	presetsOf,
	previewSummary,
	rangeError,
	removeRange,
	removeSkip,
	sameSpacing,
	sentence,
	skipsIn,
	spacingText,
	togglePreset,
	updateRange,
	type BandHint,
	type PlanDraft,
	type Preset,
	type PlanOptions,
	type PlanRange,
	type Sensitivity,
	type StopAfter,
} from "./plan.ts"
import {
	bandsView,
	fitView,
	lanesOf,
	zoomView,
	type LaneBand,
	type View,
} from "./ruler.ts"
import { SetupRuler, type DrawKind, type RulerSkip } from "./SetupRuler.tsx"
import { Overview } from "./Overview.tsx"

export interface SetupPlanProps {
	mode: "pane" | "screen"
	size: PlannerSize
	root: HTMLElement | null
	onHide: () => void
}

interface RowPop {
	kind: "spacing" | "protos" | "skips" | "more"
	key: string
	anchor: PopAnchor
}

type Pop = RowPop | { kind: "options"; anchor: PopAnchor }

interface Toast {
	text: string
	undo?: () => void
}

interface PreviewState {
	preview: PlanPreview | null
	loading: boolean
	error: string | null
	issues: readonly PlanIssue[]
}

const NO_BANDS: readonly ResolvedBand[] = []
const SPACING_CHOICES = [6250, 8333, 12_500, 25_000]

/** Decoder id → display name ("AIS" for ais-catcher), from the decoders feed. */
export function useDecoderName(): (id: string) => string {
	const { decoders } = useServices()
	const list = useStore(decoders, s => s.decoders)
	return useCallback(
		(id: string) => {
			const d = list.find(x => x.id === id)
			return d ? decoderLabel(d.type) : id
		},
		[list],
	)
}

/** The core's own skips of a plan or job (decoded elsewhere, band-plan skips, Ignore), applied ones only. */
export function autoSkipsOf(
	src: Pick<
		PlanPreview,
		"decodedElsewhere" | "bandPlanSkips" | "lockoutExclusions"
	>,
	decoderName: (id: string) => string,
): AutoSkip[] {
	const out: AutoSkip[] = []
	for (const x of src.decodedElsewhere ?? [])
		if (x.applied)
			out.push({
				startHz: x.startHz,
				endHz: x.endHz,
				why: `Decoded by ${[...new Set(x.decoderIds.map(decoderName))].join(", ") || "a decoder"}`,
			})
	for (const x of src.bandPlanSkips ?? [])
		if (x.applied)
			out.push({
				startHz: x.startHz,
				endHz: x.endHz,
				why: "Skipped by the band plan",
			})
	for (const x of src.lockoutExclusions ?? [])
		if (x.applied)
			out.push({ startHz: x.startHz, endHz: x.endHz, why: "Ignored signal" })
	return out.sort((a, b) => a.startHz - b.startHz)
}

/** The narrowest band of the resolved plan holding a stretch: its step and group for a drawn range. */
function bandHint(
	lo: number,
	hi: number,
	bands: readonly ResolvedBand[],
): BandHint {
	const b = bands
		.filter(x => x.band.startHz <= lo && x.band.endHz >= hi && !x.band.skip)
		.sort(
			(x, y) => x.band.endHz - x.band.startHz - (y.band.endHz - y.band.startHz),
		)[0]
	return b ? { stepHz: b.band.stepHz, group: b.band.group } : {}
}

export function SetupPlan({ mode, size, root, onHide }: SetupPlanProps) {
	const { data } = useServices()
	const readOnly = useReadOnly()
	const { draft, view } = useStore(setupStore)
	const bandplans = useStore(data.scanner, s => s.bandplans)
	const statusCode = useStore(data.scanner, s => s.statusErrorCode)
	const bands = useStore(data.bandplan, s => s.view?.bands ?? NO_BANDS)
	const decoderName = useDecoderName()

	const lanes = useMemo(() => lanesOf(bands), [bands])
	const presets = useMemo(() => presetsOf(bandplans), [bandplans])

	const [tool, setTool] = useState<DrawKind>("add")
	const [pop, setPop] = useState<Pop | null>(null)
	const [renaming, setRenaming] = useState<string | null>(null)
	const [toast, setToast] = useState<Toast | null>(null)

	// ---- the view opens fitted on the plan's ranges, else on the region's VHF bands
	useEffect(() => {
		// read the store, not the render's snapshot: a prefill may have fitted the view in this same commit
		const now = setupStore.get()
		if (now.view) return
		const fit =
			fitView(now.draft.ranges) ??
			(bands.length > 0 ? bandsView(bands.map(b => b.band)) : null)
		if (fit) setView(fit)
		else if (bandplans) setView(bandsView(bandplans.flatMap(p => p.ranges)))
	}, [view, draft.ranges, bands, bandplans])
	const shownView: View = view ?? { lo: 117e6, hi: 175e6 }

	// ---- a prefill (Shift-drag on the spectrum, "Scan this range") adds a range when the plan opens or while open
	const prefill = useStore(scannerUi, s => s.prefill)
	useEffect(() => {
		if (!prefill) return
		const r = takePrefill()
		if (!r) return
		const range = customRange(
			r.startHz,
			r.endHz,
			data.scanner.get().bandplans,
			bandHint(r.startHz, r.endHz, data.bandplan.get().view?.bands ?? NO_BANDS),
		)
		updateDraft(d => addRange(d, range))
		const fit = fitView([range])
		if (fit) setView(fit)
	}, [prefill, data.scanner])

	// ---- toast (Undo after Remove)
	useEffect(() => {
		if (!toast) return
		const t = setTimeout(() => setToast(null), 5000)
		return () => clearTimeout(t)
	}, [toast])

	// ---- preview: debounced, a newer one aborts the older
	const valid = draftValid(draft)
	const spec = useMemo(() => (valid ? buildSpec(draft) : null), [draft, valid])
	const specKey = spec ? JSON.stringify(spec) : ""
	const [pv, setPv] = useState<PreviewState>({
		preview: null,
		loading: false,
		error: null,
		issues: [],
	})
	const [consent, setConsent] = useState<{
		impact: Impact | null
		needed: boolean
	}>({ impact: null, needed: false })
	useEffect(() => {
		setConsent({ impact: null, needed: false })
		if (!spec) {
			setPv({ preview: null, loading: false, error: null, issues: [] })
			return
		}
		setPv(p => ({ ...p, loading: true }))
		const ac = new AbortController()
		const t = setTimeout(() => {
			data.scanner.previewPlan(spec, { signal: ac.signal }).then(
				preview => {
					if (!ac.signal.aborted)
						setPv({
							preview,
							loading: false,
							error: null,
							issues: preview.issues,
						})
				},
				(error: unknown) => {
					if (ac.signal.aborted) return
					setPv({
						preview: null,
						loading: false,
						error: errorMessage(error),
						issues: planIssues(error),
					})
				},
			)
		}, 300)
		return () => {
			clearTimeout(t)
			ac.abort()
		}
		// the spec's text is the dependency: an equal plan is not previewed twice
	}, [specKey])

	const autoSkips = useMemo(
		() => (pv.preview ? autoSkipsOf(pv.preview, decoderName) : []),
		[pv.preview, decoderName],
	)

	// ---- start
	const [starting, setStarting] = useState(false)
	const [startError, setStartError] = useState<string | null>(null)
	const impact = consent.impact ?? pv.preview?.impact ?? null
	const errors = pv.issues.filter(i => i.severity === "error")
	const warnings = pv.issues.filter(i => i.severity === "warning")
	const scannerOff =
		statusCode === "SCANNER_DISABLED" || statusCode === "NOT_FOUND"
	const canStart =
		valid &&
		!starting &&
		errors.length === 0 &&
		!readOnly &&
		!scannerOff &&
		pv.error === null
	const start = () => {
		if (!spec || !canStart) return
		setStarting(true)
		setStartError(null)
		const takeover = consent.needed || impactDisturbs(impact)
		data.scanner.startJob(spec, takeover ? { takeover: true } : {}).then(
			() => {
				setStarting(false)
				closePlan()
			},
			(error: unknown) => {
				setStarting(false)
				const who = takeoverImpact(error)
				if (who) {
					// the receiver got busier since the preview: show who, the next press consents
					setConsent({ impact: who, needed: true })
					return
				}
				const issues = planIssues(error)
				setStartError(sentence(issues[0]?.message ?? errorMessage(error)))
			},
		)
	}

	// ---- edits
	const set = (fn: (d: PlanDraft) => PlanDraft) => {
		setStartError(null)
		updateDraft(fn)
	}
	const onDraw = (kind: DrawKind, lo: number, hi: number) => {
		if (kind === "skip") set(d => addSkip(d, lo, hi))
		else
			set(d =>
				addRange(d, customRange(lo, hi, bandplans, bandHint(lo, hi, bands))),
			)
	}
	const bandsOn = useMemo(
		() =>
			new Set(
				draft.ranges.flatMap(r =>
					r.preset?.startsWith("band:") ? [r.preset.slice(5)] : [],
				),
			),
		[draft.ranges],
	)
	const onBand = (b: LaneBand) => {
		if (bandsOn.has(b.key))
			set(d => ({
				...d,
				ranges: d.ranges.filter(r => r.preset !== `band:${b.key}`),
			}))
		else
			set(d =>
				addRange(d, {
					...customRange(b.startHz, b.endHz, bandplans, {
						name: b.name,
						stepHz: b.stepHz,
						group: b.group,
					}),
					preset: `band:${b.key}`,
				}),
			)
	}
	// a preset outside the ruler's stretch brings the ruler to the plan
	const pickPreset = (p: Preset) => {
		const was = setupStore.get().draft
		const next = togglePreset(was, p)
		set(() => next)
		const added = next.ranges.filter(r => !was.ranges.includes(r))
		const v = setupStore.get().view
		if (
			added.length > 0 &&
			v &&
			added.some(r => r.endHz < v.lo || r.startHz > v.hi)
		) {
			const fit = fitView(next.ranges)
			if (fit) setView(fit)
		}
	}
	const remove = (r: PlanRange) => {
		const before = setupStore.get().draft
		set(d => removeRange(d, r.key))
		setPop(null)
		setToast({
			text: `Removed ${r.name}`,
			undo: () => updateDraft(() => before),
		})
	}
	const fit = () => {
		const v = fitView([...draft.ranges]) ?? bandsView(bands.map(b => b.band))
		setView(v)
	}

	const bad = useMemo(
		() =>
			new Set(draft.ranges.filter(r => rangeError(r) !== null).map(r => r.key)),
		[draft.ranges],
	)
	const rulerSkips: RulerSkip[] = useMemo(
		() => [
			...draft.skips.map(x => ({
				key: x.key,
				startHz: x.startHz,
				endHz: x.endHz,
				title: x.reason ?? "Skipped by you",
			})),
			...autoSkips.map(x => ({
				key: `a${x.startHz}`,
				startHz: x.startHz,
				endHz: x.endHz,
				title: x.why,
			})),
		],
		[draft.skips, autoSkips],
	)

	// ---- footer words
	const firstBad = draft.ranges.findIndex(r => rangeError(r) !== null)
	const badRange = draft.ranges[firstBad]
	let summary: string
	let tone: "quiet" | "danger" | "normal" = "normal"
	if (draft.ranges.length === 0) {
		summary = "Pick a preset, click a band or drag on the ruler"
		tone = "quiet"
	} else if (badRange) {
		summary = `${firstBad + 1} · ${badRange.name} · ${rangeError(badRange) ?? ""}`
		tone = "danger"
	} else if (startError) {
		summary = startError
		tone = "danger"
	} else if (errors[0]) {
		summary = sentence(errors[0].message)
		tone = "danger"
	} else if (pv.error) {
		summary = sentence(pv.error)
		tone = "danger"
	} else if (pv.preview) summary = previewSummary(pv.preview)
	else {
		summary = "Planning…"
		tone = "quiet"
	}
	const startTitle = readOnly
		? "Read-only access: this browser cannot start a scan"
		: scannerOff
			? "The scanner is off on this WaveKit"
			: undefined

	const anchorOf = (el: HTMLElement): PopAnchor => ({ el })
	const popRange =
		pop && pop.kind !== "options"
			? (draft.ranges.find(r => r.key === pop.key) ?? null)
			: null

	return (
		<>
			<header className="wk-pl-head" data-composing="">
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
					<h2 className="wk-h2 wk-pl-ellipsis">Scan a band</h2>
				</div>
				<div
					role="group"
					aria-label="Presets"
					className="wk-pl-presets wk-hscroll"
				>
					{presets.length === 0 && (
						<span className="wk-pl-note">
							{bandplans === null
								? "Loading presets…"
								: "No presets for this region"}
						</span>
					)}
					{presets.map(p => {
						const on = presetOn(p, draft.ranges)
						return (
							<Chip
								key={p.id}
								pressed={on}
								title={p.name}
								onClick={() => pickPreset(p)}
							>
								{p.label}
							</Chip>
						)
					})}
				</div>
				{mode === "pane" && (
					<Button
						variant="ghost"
						size="lg"
						className="wk-pl-hide"
						onClick={onHide}
						aria-label="Hide the plan"
						title="Hide the plan · Esc"
					>
						Hide
						<Glyph name="hide" size={16} />
					</Button>
				)}
			</header>

			<section aria-label="Ruler" className="wk-pl-rulersec">
				<SetupRuler
					lanes={lanes}
					ranges={draft.ranges}
					skips={rulerSkips}
					view={shownView}
					onView={setView}
					tool={tool}
					onDraw={onDraw}
					onBand={onBand}
					bandsOn={bandsOn}
					gutter={size !== "narrow"}
					compact={size === "narrow"}
					bad={bad}
				/>
				<div className="wk-pl-tools">
					<Seg
						label="Dragging on the ruler"
						value={tool}
						onChange={setTool}
						options={[
							{ value: "add", label: "Add" },
							{ value: "skip", label: "Skip" },
						]}
					/>
					<Overview view={shownView} ranges={draft.ranges} onView={setView} />
					<div className="wk-pl-zoom">
						<button
							type="button"
							className="wk-icon-btn"
							aria-label="Zoom out"
							title="Zoom out · Ctrl + scroll"
							onClick={() => setView(zoomView(shownView, 1 / 0.6))}
						>
							<Glyph name="minus" />
						</button>
						<button
							type="button"
							className="wk-icon-btn"
							aria-label="Zoom in"
							title="Zoom in · Ctrl + scroll"
							onClick={() => setView(zoomView(shownView, 0.6))}
						>
							<Glyph name="plus" />
						</button>
						<Button
							variant="ghost"
							onClick={fit}
							title={
								draft.ranges.length > 0
									? "Fit your ranges"
									: "Fit the band plan"
							}
						>
							Fit
						</Button>
					</div>
				</div>
			</section>

			<div className="wk-pl-table wk-scroll" role="table" aria-label="Ranges">
				{size === "wide" && draft.ranges.length > 0 && (
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
						<span role="columnheader" style={{ gridArea: "act" }} />
					</div>
				)}
				{draft.ranges.length === 0 && (
					<p className="wk-pl-empty">No ranges yet</p>
				)}
				{draft.ranges.map((r, i) => (
					<SetupRow
						key={r.key}
						r={r}
						num={i + 1}
						draft={draft}
						autoSkips={autoSkips}
						renaming={renaming === r.key}
						onRename={() => setRenaming(r.key)}
						onRenamed={name => {
							setRenaming(null)
							if (name && name !== r.name)
								set(d => updateRange(d, r.key, { name }))
						}}
						onEdge={(lo, hi) =>
							set(d => updateRange(d, r.key, { startHz: lo, endHz: hi }))
						}
						onPop={(kind, el) =>
							setPop({ kind, key: r.key, anchor: anchorOf(el) })
						}
					/>
				))}
			</div>

			{toast && (
				<div role="status" className="wk-toast wk-pl-toast">
					<span className="wk-pl-toasttext">{toast.text}</span>
					{toast.undo && (
						<Button
							variant="tonal"
							size="sm"
							onClick={() => {
								toast.undo?.()
								setToast(null)
							}}
						>
							Undo
						</Button>
					)}
				</div>
			)}

			{/* the first error is the footer's summary; more errors list here (warnings stay in its tooltip) */}
			{errors.length > 1 && valid && (
				<div className="wk-pl-issues" role="list" aria-label="Plan issues">
					{errors.slice(1, 4).map(i => (
						<span
							key={`${i.code}:${i.message}`}
							role="listitem"
							className="wk-pl-issue"
							data-severity={i.severity}
							title={i.message}
						>
							{i.message}
						</span>
					))}
				</div>
			)}

			<footer className="wk-pl-foot">
				<Button
					variant="ghost"
					size="lg"
					className="wk-pl-optbtn"
					aria-haspopup="dialog"
					aria-expanded={pop?.kind === "options"}
					onClick={e =>
						setPop({ kind: "options", anchor: anchorOf(e.currentTarget) })
					}
				>
					<Glyph name="options" />
					Options
					{optionsChanged(draft.options) && (
						<span className="wk-pl-dot" title="Changed from the defaults" />
					)}
				</Button>
				<span
					role="status"
					className="wk-pl-summary"
					data-tone={tone}
					data-loading={(pv.loading && pv.preview !== null) || undefined}
					title={warnings.map(w => w.message).join("\n") || undefined}
				>
					{summary}
				</span>
				{valid && (pv.preview || consent.impact) && errors.length === 0 && (
					<span
						className="wk-pl-consent"
						title="Takes the receiver until the scan ends"
					>
						<Glyph name="pause" size={14} />
						<span className="wk-pl-ellipsis">
							{consentText(impact, decoderName)}
						</span>
					</span>
				)}
				<span className="wk-pl-spring" />
				<Button
					variant="primary"
					size="lg"
					className="wk-pl-start"
					disabled={!canStart}
					title={startTitle}
					onClick={start}
				>
					{starting ? "Starting…" : "Start · takes the receiver"}
				</Button>
			</footer>

			{pop && (
				<Popover
					anchor={pop.anchor}
					root={root}
					up={pop.kind === "options"}
					role={pop.kind === "more" ? "menu" : "dialog"}
					width={
						pop.kind === "skips" || pop.kind === "options"
							? 380
							: pop.kind === "more"
								? 200
								: 320
					}
					label={
						pop.kind === "options"
							? "Options"
							: pop.kind === "spacing"
								? `Channel spacing for ${popRange?.name ?? ""}`
								: pop.kind === "protos"
									? `Protocols for ${popRange?.name ?? ""}`
									: pop.kind === "skips"
										? `Skips in ${popRange?.name ?? ""}`
										: (popRange?.name ?? "")
					}
					onClose={() => setPop(null)}
				>
					{pop.kind === "options" && (
						<OptionsBody
							options={draft.options}
							onChange={o => set(d => ({ ...d, options: o }))}
						/>
					)}
					{pop.kind === "spacing" && popRange && (
						<SpacingBody
							r={popRange}
							onChange={sp =>
								set(d => updateRange(d, popRange.key, { spacingHz: sp }))
							}
						/>
					)}
					{pop.kind === "protos" && popRange && (
						<ProtocolPicker
							protocols={popRange.protocols}
							signalsOnly={draft.options.signalsOnly}
							onChange={(ps: ScannerProtocol[]) =>
								set(d => updateRange(d, popRange.key, { protocols: ps }))
							}
						/>
					)}
					{pop.kind === "skips" && popRange && (
						<SkipsEditor
							name={popRange.name}
							range={popRange}
							skips={skipsIn(draft.skips, popRange)}
							auto={skipsIn(autoSkips, popRange)}
							onAdd={(lo, hi) => set(d => addSkip(d, lo, hi))}
							onRemove={key => set(d => removeSkip(d, key))}
							onChange={(key, lo, hi) =>
								set(d => ({
									...d,
									skips: d.skips.map(x =>
										x.key === key ? { ...x, startHz: lo, endHz: hi } : x,
									),
								}))
							}
						/>
					)}
					{pop.kind === "more" && popRange && (
						<div className="wk-pl-menu">
							<button
								type="button"
								role="menuitem"
								className="wk-option"
								onClick={() => {
									setPop(null)
									setRenaming(popRange.key)
								}}
							>
								Rename
							</button>
							<button
								type="button"
								role="menuitem"
								className="wk-option wk-pl-danger"
								onClick={() => remove(popRange)}
							>
								Remove
							</button>
						</div>
					)}
				</Popover>
			)}
		</>
	)
}

// ---- one range row

function SetupRow({
	r,
	num,
	draft,
	autoSkips,
	renaming,
	onRename,
	onRenamed,
	onEdge,
	onPop,
}: {
	r: PlanRange
	num: number
	draft: PlanDraft
	autoSkips: readonly AutoSkip[]
	renaming: boolean
	onRename: () => void
	onRenamed: (name: string) => void
	onEdge: (lo: number, hi: number) => void
	onPop: (
		kind: "spacing" | "protos" | "skips" | "more",
		el: HTMLElement,
	) => void
}) {
	const err = rangeError(r)
	const mine = skipsIn(draft.skips, r)
	const auto = skipsIn(autoSkips, r)
	const n = mine.length + auto.length
	const why = [
		...new Set([
			...auto.map(x => x.why),
			...mine.map(x => x.reason ?? "yours"),
		]),
	]
	const skipText = n === 0 ? "None" : `${n} · ${why.join(", ")}`
	const spMine = !sameSpacing(r.spacingHz, r.planSpacingHz)
	return (
		<div
			role="row"
			className="wk-pl-row"
			data-bad={err !== null || undefined}
			aria-label={`Range ${num}, ${r.name}`}
		>
			<span role="cell" className="wk-pl-c-n">
				<span className="wk-pl-num">{num}</span>
			</span>
			<span role="cell" className="wk-pl-c-name">
				{renaming ? (
					<RenameInput name={r.name} onDone={onRenamed} />
				) : (
					<span
						className="wk-pl-name"
						title={`${r.name} · double-click to rename`}
						onDoubleClick={onRename}
					>
						{r.name}
					</span>
				)}
			</span>
			<span role="cell" className="wk-pl-c-edges">
				<EdgeInput
					hz={r.startHz}
					label={`${r.name}, low edge, MHz`}
					invalid={err !== null}
					title={err ?? undefined}
					onCommit={v => onEdge(v, r.endHz)}
				/>
				<span aria-hidden="true" className="wk-pl-dash">
					–
				</span>
				<EdgeInput
					hz={r.endHz}
					label={`${r.name}, high edge, MHz`}
					invalid={err !== null}
					title={err ?? undefined}
					onCommit={v => onEdge(r.startHz, v)}
				/>
			</span>
			<span role="cell" className="wk-pl-c-sp">
				<button
					type="button"
					className="wk-pl-cell wk-pl-spchip"
					aria-haspopup="dialog"
					aria-label={`Channel spacing for ${r.name}: ${spacingText(r.spacingHz)}`}
					title={spMine ? "Changed from the band plan" : "From the band plan"}
					onClick={e => onPop("spacing", e.currentTarget)}
				>
					<span className="wk-pl-ellipsis">{spacingText(r.spacingHz)}</span>
					{spMine && <span className="wk-pl-dot" aria-hidden="true" />}
					<Glyph name="chevron" size={12} />
				</button>
			</span>
			<span role="cell" className="wk-pl-c-protos">
				<button
					type="button"
					className="wk-pl-cell wk-pl-protos"
					aria-haspopup="dialog"
					aria-label={`Protocols for ${r.name}`}
					title={
						draft.options.signalsOnly ? "Just find signals is on" : undefined
					}
					onClick={e => onPop("protos", e.currentTarget)}
				>
					<ProtocolChips
						protocols={r.protocols}
						off={draft.options.signalsOnly}
					/>
					<Glyph name="pencil" size={13} className="wk-pl-edit" />
				</button>
			</span>
			<span role="cell" className="wk-pl-c-skips">
				<button
					type="button"
					className="wk-pl-cell wk-pl-skips"
					aria-haspopup="dialog"
					aria-label={`Skips in ${r.name}: ${skipText}`}
					title={skipText}
					onClick={e => onPop("skips", e.currentTarget)}
				>
					{n > 0 && <span className="wk-pl-hatch" aria-hidden="true" />}
					<span className="wk-pl-ellipsis">{skipText}</span>
				</button>
			</span>
			<span role="cell" className="wk-pl-c-act">
				<button
					type="button"
					className="wk-icon-btn"
					aria-haspopup="menu"
					aria-label={`More for ${r.name}`}
					title="Rename or remove"
					onClick={e => onPop("more", e.currentTarget)}
				>
					<Glyph name="more" />
				</button>
			</span>
		</div>
	)
}

function RenameInput({
	name,
	onDone,
}: {
	name: string
	onDone: (name: string) => void
}) {
	const [text, setText] = useState(name)
	const ref = useRef<HTMLInputElement>(null)
	useEffect(() => {
		ref.current?.focus()
		ref.current?.select()
	}, [])
	return (
		<input
			ref={ref}
			className="wk-pl-box wk-pl-rename"
			value={text}
			aria-label="Range name"
			spellCheck={false}
			autoComplete="off"
			maxLength={100}
			onChange={e => setText(e.target.value)}
			onBlur={() => onDone(text.trim())}
			onKeyDown={e => {
				if (e.key === "Enter") onDone(text.trim())
				else if (e.key === "Escape") {
					e.preventDefault()
					e.stopPropagation()
					onDone(name)
				}
			}}
		/>
	)
}

// ---- popover bodies

function SpacingBody({
	r,
	onChange,
}: {
	r: PlanRange
	onChange: (sp: number[]) => void
}) {
	const [custom, setCustom] = useState("")
	const choices = [
		...new Set([...SPACING_CHOICES, ...r.planSpacingHz, ...r.spacingHz]),
	]
		.filter(v => v > 0)
		.sort((a, b) => a - b)
	const any = r.spacingHz.length === 0
	const toggle = (v: number) => {
		const has = r.spacingHz.includes(v)
		onChange(
			(has ? r.spacingHz.filter(x => x !== v) : [...r.spacingHz, v]).sort(
				(a, b) => b - a,
			),
		)
	}
	const customHz = (() => {
		const v = parseMHz(custom)
		return v === null ? null : Math.round(v / 1000)
	})()
	const okCustom = customHz !== null && customHz >= 100 && customHz <= 1_000_000
	return (
		<>
			<span className="wk-label wk-pl-th" data-strong="">
				Channel spacing, kHz
			</span>
			<div role="group" aria-label="Channel spacing" className="wk-pl-chips">
				{choices.map(v => (
					<Chip
						key={v}
						tick
						pressed={r.spacingHz.includes(v)}
						onClick={() => toggle(v)}
					>
						{kHz(v)}
					</Chip>
				))}
				<Chip
					tick
					pressed={any}
					title="No channel grid: hits keep their measured frequency"
					onClick={() => onChange([])}
				>
					Any
				</Chip>
			</div>
			<div className="wk-pl-inline">
				<input
					className="wk-pl-box wk-pl-grow"
					value={custom}
					placeholder="Other, e.g. 5"
					aria-label="Other channel spacing, kHz"
					inputMode="decimal"
					spellCheck={false}
					autoComplete="off"
					onChange={e => setCustom(e.target.value)}
					onKeyDown={e => {
						if (e.key === "Enter" && okCustom && customHz !== null) {
							toggle(customHz)
							setCustom("")
						}
					}}
				/>
				<Button
					variant="ghost"
					disabled={!okCustom}
					onClick={() => {
						if (customHz === null) return
						toggle(customHz)
						setCustom("")
					}}
				>
					Add
				</Button>
			</div>
			{!sameSpacing(r.spacingHz, r.planSpacingHz) && (
				<Button
					variant="ghost"
					size="sm"
					className="wk-pl-reset"
					onClick={() => onChange([...r.planSpacingHz])}
				>
					Use the band plan ({spacingText(r.planSpacingHz)})
				</Button>
			)}
		</>
	)
}

const STOPS: { value: StopAfter; label: string }[] = [
	{ value: "never", label: "Never" },
	{ value: "pass", label: "1 pass" },
	{ value: "10m", label: "10 min" },
	{ value: "1h", label: "1 h" },
]
const SENS: { value: Sensitivity; label: string }[] = [
	{ value: "low", label: "Low" },
	{ value: "normal", label: "Normal" },
	{ value: "high", label: "High" },
]

function OptionsBody({
	options,
	onChange,
}: {
	options: PlanOptions
	onChange: (o: PlanOptions) => void
}) {
	const sw = (
		key: "hold" | "record" | "signalsOnly" | "skipDecodedElsewhere",
		label: string,
		hint: string,
	) => (
		<div className="wk-pl-optrow" title={hint}>
			<span id={`wk-pl-opt-${key}`} className="wk-pl-optlabel">
				{label}
			</span>
			<Switch
				checked={options[key]}
				aria-labelledby={`wk-pl-opt-${key}`}
				onChange={v => onChange({ ...options, [key]: v })}
			/>
		</div>
	)
	return (
		<>
			{sw("hold", "Hold on activity", "Stay on a signal while it transmits")}
			{sw(
				"record",
				"Record calls",
				"Keep voice and analog recordings of what it hears",
			)}
			{sw(
				"signalsOnly",
				"Just find signals",
				"No decoding trials: the fastest sweep",
			)}
			{sw(
				"skipDecodedElsewhere",
				"Skip what decodes elsewhere",
				"Leave out channels a running decoder already covers",
			)}
			<div className="wk-pl-sep" aria-hidden="true" />
			<div className="wk-pl-optrow">
				<span id="wk-pl-opt-sens" className="wk-pl-optlabel">
					Sensitivity
				</span>
				<Seg
					label="Sensitivity"
					value={options.sensitivity}
					options={SENS}
					onChange={v => onChange({ ...options, sensitivity: v })}
				/>
			</div>
			<div className="wk-pl-optrow">
				<span id="wk-pl-opt-stop" className="wk-pl-optlabel">
					Stop after
				</span>
				<Seg
					label="Stop after"
					value={options.stopAfter}
					options={STOPS}
					onChange={v => onChange({ ...options, stopAfter: v })}
				/>
			</div>
			{JSON.stringify(options) !== JSON.stringify(DEFAULT_OPTIONS) && (
				<Button
					variant="ghost"
					size="sm"
					className="wk-pl-reset"
					onClick={() => onChange(DEFAULT_OPTIONS)}
				>
					Back to the defaults
				</Button>
			)}
		</>
	)
}
