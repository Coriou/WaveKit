// Settings › Receiver › Per-band gain (GET/PUT /api/tuner-band-gain): the gain the core sets in each
// frequency range when the scanner tunes there, and on your own tuning too once "Per-band gain for my
// tuning" is on. The table edits a draft (MHz and dB as typed, or Keep) checked against the core's rules
// before Save sends the whole table; the switch saves at once. The row is listed by rows.ts like any
// other (search, crumbs, ⌘K) and drawn here because a table fits no single-widget row.
import { useEffect, useId, useMemo, useState, type CSSProperties } from "react"

import { useReadOnly, useServices } from "../../app/context.ts"
import { useStore } from "../../data/index.ts"
import {
	BAND_GAIN_LIMITS,
	bandGainFromDraft,
	bandGainStore,
	draftOf,
	newDraftKey,
	sameBandGain,
	type BandGainDraftErrors,
	type BandGainDraftRow,
	type BandGainField,
} from "../../data/receiver-band-gain.ts"
import { Button } from "../../ui/Button.tsx"
import { Chip } from "../../ui/Chip.tsx"
import { Switch } from "../../ui/Switch.tsx"
import { SetIcon } from "./icons.tsx"
import type { SettingRow } from "./model.ts"

export const BAND_GAIN_ROW_ID = "rx.bandGain"

/** The row rows.ts lists: found by search and ⌘K, drawn by BandGainRow. */
export function bandGainRow(): SettingRow {
	return {
		id: BAND_GAIN_ROW_ID,
		group: "receiver",
		label: "Per-band gain",
		help: "The gain the scanner sets in each band",
		keys: [
			"band gain",
			"gain table",
			"overload",
			"ism",
			"868",
			"915",
			"scanner",
			"per band",
		],
		widget: { kind: "read" },
		value: null,
		text: "Per band",
	}
}

const GRID: CSSProperties = {
	display: "grid",
	gridTemplateColumns:
		"minmax(0, 6.5em) minmax(0, 6.5em) minmax(0, 8.5em) minmax(0, 1fr) 28px",
	columnGap: 6,
	rowGap: 6,
	alignItems: "center",
}
const FULL: CSSProperties = { width: "100%" }
const SPAN: CSSProperties = { gridColumn: "1 / -1" }

const READ_ONLY = "Read-only access: sign in on this WaveKit to change it"

function emptyRow(): BandGainDraftRow {
	return {
		key: newDraftKey(),
		minMHz: "",
		maxMHz: "",
		keep: false,
		gainDb: "",
		label: "",
	}
}

export function BandGainRow({
	crumb,
	flash = false,
}: {
	crumb?: string | undefined
	flash?: boolean
}) {
	const { data } = useServices()
	const readOnly = useReadOnly()
	const store = bandGainStore(data.api)
	const state = useStore(store)
	const labelId = useId()
	const switchId = useId()
	useEffect(() => {
		void store.load()
	}, [store])

	const view = state.view
	const limits = view?.limits ?? BAND_GAIN_LIMITS
	// the core's table as a draft; edits replace it until Save or Discard
	const base = useMemo(() => (view ? draftOf(view.settings).rows : []), [view])
	const [rows, setRows] = useState<readonly BandGainDraftRow[] | null>(null)
	const [errors, setErrors] = useState<BandGainDraftErrors | null>(null)
	const [message, setMessage] = useState<string | null>(null)
	const shown = rows ?? base
	const dirty = rows !== null
	const disabled = readOnly || view === null || state.saving

	const edit = (next: readonly BandGainDraftRow[]) => {
		setRows(next)
		setErrors(null)
		setMessage(null)
	}
	const change = (key: string, patch: Partial<BandGainDraftRow>) =>
		edit(shown.map(r => (r.key === key ? { ...r, ...patch } : r)))

	const discard = () => {
		setRows(null)
		setErrors(null)
		setMessage(null)
	}
	const save = async () => {
		if (!view) return
		const parsed = bandGainFromDraft(
			{ applyToMyTuning: view.settings.applyToMyTuning, rows: shown },
			limits,
		)
		if ("errors" in parsed) {
			setErrors(parsed.errors)
			setMessage("Fix the marked fields, then save")
			return
		}
		if (sameBandGain(parsed.settings, view.settings)) {
			discard()
			return
		}
		const result = await store.save(parsed.settings)
		if (result.ok) {
			setRows(null)
			setErrors(null)
			setMessage(null)
		} else setMessage(result.message)
	}
	const setApply = async (on: boolean) => {
		if (!view) return
		setMessage(null)
		const result = await store.save({ ...view.settings, applyToMyTuning: on })
		if (!result.ok) setMessage(result.message)
	}

	const fieldError = (key: string, field: BandGainField) =>
		errors?.rows[key]?.[field]
	const note = !view
		? state.unavailable
			? "Not available: this core has no per-band gain"
			: (state.error ?? "Loading…")
		: readOnly
			? READ_ONLY
			: null

	const input = (
		row: BandGainDraftRow,
		field: BandGainField,
		label: string,
		placeholder: string,
		inputMode: "decimal" | "text",
	) => {
		const bad = fieldError(row.key, field)
		return (
			<input
				className="wk-input wkf-set-box wkf-num"
				style={FULL}
				aria-label={label}
				aria-invalid={bad ? true : undefined}
				data-bad={bad ? true : undefined}
				title={bad}
				inputMode={inputMode}
				spellCheck={false}
				autoComplete="off"
				placeholder={placeholder}
				disabled={disabled}
				value={row[field]}
				onChange={e => change(row.key, { [field]: e.target.value })}
			/>
		)
	}

	const rowName = (row: BandGainDraftRow, i: number) =>
		row.label.trim() || `band ${i + 1}`
	const problems = errors
		? shown.flatMap((row, i) =>
				(["minMHz", "maxMHz", "gainDb", "label"] as const)
					.map(f => fieldError(row.key, f))
					.filter((m): m is string => m !== undefined)
					.map(m => `${rowName(row, i)}: ${m}`),
			)
		: []

	return (
		<div
			className="wkf-set-row"
			data-setting={BAND_GAIN_ROW_ID}
			data-changed={view?.provenance === "runtime" || undefined}
			data-waiting={dirty || undefined}
			data-flash={flash || undefined}
		>
			<div className="wkf-set-grid" data-wide="">
				<div className="wkf-set-lab">
					{crumb && <div className="wkf-set-crumb">{crumb}</div>}
					<div className="wkf-set-name">
						<span id={labelId}>Per-band gain</span>
					</div>
					<div className="wkf-set-help">
						A gain that suits one band can overload the dongle in another (868
						and 915 MHz sit beside strong cellular signals). Scanner hops,
						dwells and jobs set the gain listed for the band they tune into and
						give yours back after. Keep leaves the gain alone.
					</div>
				</div>
				<div className="wkf-set-ctl" style={{ flexDirection: "column" }}>
					{view && (
						<div
							role="group"
							aria-labelledby={labelId}
							style={{ ...GRID, ...FULL }}
						>
							<span className="wk-label">From MHz</span>
							<span className="wk-label">To MHz</span>
							<span className="wk-label">Gain dB</span>
							<span className="wk-label">Name</span>
							<span />
							{shown.map((row, i) => {
								const name = rowName(row, i)
								return (
									<div key={row.key} style={{ display: "contents" }}>
										{input(row, "minMHz", `${name} from MHz`, "863", "decimal")}
										{input(row, "maxMHz", `${name} to MHz`, "870", "decimal")}
										<span style={{ display: "flex", gap: 4, minWidth: 0 }}>
											{row.keep
												? null
												: input(
														row,
														"gainDb",
														`${name} gain in dB`,
														"37.2",
														"decimal",
													)}
											<Chip
												size="sm"
												pressed={row.keep}
												disabled={disabled}
												aria-label={`${name}: keep the gain`}
												onClick={() => change(row.key, { keep: !row.keep })}
											>
												Keep
											</Chip>
										</span>
										{input(row, "label", `${name} name`, "Optional", "text")}
										<button
											type="button"
											className="wk-icon-btn"
											aria-label={`Remove ${name}`}
											disabled={disabled}
											onClick={() => edit(shown.filter(r => r.key !== row.key))}
										>
											<SetIcon name="x" size={13} strokeWidth={2.2} />
										</button>
									</div>
								)
							})}
							{shown.length === 0 && (
								<span className="wkf-set-help" style={SPAN}>
									No bands: the scanner never changes the gain.
								</span>
							)}
							<span className="wkf-set-btns" style={SPAN}>
								<Button
									size="sm"
									variant="outline"
									disabled={disabled || shown.length >= limits.maxEntries}
									onClick={() => edit([...shown, emptyRow()])}
								>
									Add band
								</Button>
								{dirty && (
									<>
										<Button
											size="sm"
											variant="primary"
											disabled={disabled}
											onClick={() => void save()}
										>
											{state.saving ? "Saving…" : "Save"}
										</Button>
										<Button
											size="sm"
											variant="ghost"
											disabled={state.saving}
											onClick={discard}
										>
											Discard
										</Button>
									</>
								)}
							</span>
							<span
								style={{
									...SPAN,
									display: "flex",
									gap: 10,
									alignItems: "center",
									marginTop: 6,
								}}
							>
								<span style={{ flex: 1, minWidth: 0 }}>
									<span className="wkf-set-name" id={switchId}>
										Per-band gain for my tuning
									</span>
									<span className="wkf-set-help">
										Off: only the scanner uses the table. On: your own retunes
										set the band's gain too, and give yours back outside the
										bands.
									</span>
								</span>
								<Switch
									size="row"
									checked={view.settings.applyToMyTuning}
									aria-labelledby={switchId}
									disabled={disabled}
									onChange={on => void setApply(on)}
								/>
							</span>
						</div>
					)}
				</div>
				{(note || message || problems.length > 0 || errors?.table) && (
					<div className="wkf-set-note">
						{note && <span data-tone="quiet">{note}</span>}
						{message && (
							<span data-tone="danger" role="alert">
								{message}
							</span>
						)}
						{errors?.table && <span data-tone="danger">{errors.table}</span>}
						{problems.map(p => (
							<span key={p} data-tone="danger">
								{p}
							</span>
						))}
					</div>
				)}
			</div>
		</div>
	)
}
