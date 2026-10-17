// One settings row (DESIGN.md "Settings polish › Row grid"): label, control and ⋯ in three columns, compact controls
// on the label line, wide ones under it; a changed bar with "Reset to …", effect and lock glyphs, and full-width notes
// for waiting, error, warning and locked values.
import { useEffect, useId, useRef, useState, type CSSProperties } from "react"

import {
	rampGradient,
	themeColors,
	type WaterfallName,
} from "../../spectrum/ramp.ts"
import { Chip } from "../../ui/Chip.tsx"
import { Seg } from "../../ui/Seg.tsx"
import { Switch } from "../../ui/Switch.tsx"
import {
	isChanged,
	type SettingRow,
	type SettingValue,
	type TextWidget,
} from "./model.ts"
import { SetIcon } from "./icons.tsx"

export interface RowProps {
	row: SettingRow
	/** The staged value while the change waits for Apply. */
	staged?: SettingValue
	/** Breadcrumb in search results ("Audio › More"). */
	crumb?: string
	error?: string
	flash?: boolean
	phone?: boolean
	onChange: (value: SettingValue) => void
	onUndo: () => void
	onReset: () => void
	onCopy: () => void
}

const WIDE_SEG_CHARS = 22

/** Wide rows put their control under the label: text, chips, sliders and long segmented controls. */
function isWide(row: SettingRow, phone: boolean): boolean {
	const w = row.widget
	if (
		w.kind === "text" ||
		w.kind === "chips" ||
		w.kind === "slider" ||
		w.kind === "ramp"
	)
		return true
	// a phone keeps labels on one line: steppers and selects go under them
	if (phone && (w.kind === "stepper" || w.kind === "select")) return true
	if (w.kind === "seg")
		return (
			w.options.reduce((n, o) => n + o.label.length + 3, 0) >
			(phone ? WIDE_SEG_CHARS - 6 : WIDE_SEG_CHARS)
		)
	return false
}

export function SettingRowView({
	row,
	staged,
	crumb,
	error,
	flash,
	phone = false,
	onChange,
	onUndo,
	onReset,
	onCopy,
}: RowProps) {
	const labelId = useId()
	const noteId = useId()
	const [menu, setMenu] = useState(false)
	const [fieldError, setFieldError] = useState<string | null>(null)
	const waiting = staged !== undefined
	const value = waiting ? staged : row.value
	const changed = isChanged(row)
	const disabled = row.disabled !== undefined || row.write === undefined
	const wide = isWide(row, phone)
	const warn = row.warn?.(value) ?? null
	const err = fieldError ?? error ?? row.error ?? null

	const note = err
		? { tone: "danger", text: err }
		: waiting
			? {
					tone: "amber",
					text: `Waiting for Apply · ${row.effect?.text ?? "applies with the others"}`,
					undo: true,
				}
			: row.lock
				? { tone: "quiet", text: row.lock }
				: row.disabled
					? { tone: "quiet", text: row.disabled }
					: null

	return (
		<div
			className="wkf-set-row"
			data-setting={row.id}
			data-changed={changed || undefined}
			data-waiting={waiting || undefined}
			data-flash={flash || undefined}
		>
			<div className="wkf-set-grid" data-wide={wide || undefined}>
				<div className="wkf-set-lab">
					{crumb && <div className="wkf-set-crumb">{crumb}</div>}
					<div className="wkf-set-name">
						<span id={labelId}>{row.label}</span>
						{row.effect && (
							<span className="wkf-set-glyph" title={row.effect.text}>
								<SetIcon
									name={row.effect.kind === "hardware" ? "plug" : "restart"}
									size={14}
								/>
								<span className="wk-sr">{row.effect.text}</span>
							</span>
						)}
						{row.lock && (
							<span className="wkf-set-glyph" title={row.lock}>
								<SetIcon name="lock" size={14} />
								<span className="wk-sr">Locked</span>
							</span>
						)}
						{changed && !waiting && row.def && row.write && !row.disabled && (
							<button type="button" className="wkf-set-reset" onClick={onReset}>
								Reset to {row.def.text}
							</button>
						)}
					</div>
					{row.help && <div className="wkf-set-help">{row.help}</div>}
				</div>
				<div className="wkf-set-ctl">
					<Control
						row={row}
						value={value}
						labelId={labelId}
						noteId={note ? noteId : undefined}
						disabled={disabled}
						phone={phone}
						onChange={v => {
							setFieldError(null)
							onChange(v)
						}}
						onInvalid={setFieldError}
					/>
				</div>
				<div className="wkf-set-more-wrap">
					<button
						type="button"
						className="wk-icon-btn wkf-set-more"
						aria-haspopup="menu"
						aria-expanded={menu}
						aria-label={`More for ${row.label}`}
						onClick={() => setMenu(m => !m)}
					>
						<SetIcon name="dots" size={16} />
					</button>
					{menu && (
						<RowMenu
							label={row.label}
							canReset={changed && !!row.def && !!row.write && !row.disabled}
							resetText={row.def ? `Reset to ${row.def.text}` : "Reset"}
							onClose={() => setMenu(false)}
							onReset={onReset}
							onCopy={onCopy}
						/>
					)}
				</div>
				{(note || warn) && (
					<div className="wkf-set-note" id={noteId}>
						{note && (
							<span
								data-tone={note.tone}
								role={note.tone === "danger" ? "alert" : undefined}
							>
								{note.text}
								{"undo" in note && note.undo && (
									<button
										type="button"
										className="wkf-set-undo"
										onClick={onUndo}
									>
										Undo
									</button>
								)}
							</span>
						)}
						{warn && <span data-tone="amber">{warn}</span>}
					</div>
				)}
			</div>
		</div>
	)
}

function RowMenu({
	label,
	canReset,
	resetText,
	onClose,
	onReset,
	onCopy,
}: {
	label: string
	canReset: boolean
	resetText: string
	onClose: () => void
	onReset: () => void
	onCopy: () => void
}) {
	const ref = useRef<HTMLDivElement>(null)
	useEffect(() => {
		ref.current
			?.querySelector<HTMLButtonElement>("button:not([aria-disabled])")
			?.focus()
		const away = (e: PointerEvent) => {
			if (!ref.current?.parentElement?.contains(e.target as Node)) onClose()
		}
		document.addEventListener("pointerdown", away)
		return () => document.removeEventListener("pointerdown", away)
	}, [onClose])
	return (
		<div
			ref={ref}
			role="menu"
			aria-label={label}
			className="wk-menu wkf-set-menu"
			onKeyDown={e => {
				if (e.key === "Escape") {
					e.stopPropagation()
					onClose()
					;(
						ref.current?.parentElement?.querySelector(
							"button",
						) as HTMLButtonElement | null
					)?.focus()
				}
			}}
		>
			<button
				type="button"
				role="menuitem"
				className="wk-option"
				aria-disabled={!canReset || undefined}
				onClick={() => {
					if (!canReset) return
					onClose()
					onReset()
				}}
			>
				<SetIcon name="restart" size={15} />
				{resetText}
			</button>
			<button
				type="button"
				role="menuitem"
				className="wk-option"
				onClick={() => {
					onClose()
					onCopy()
				}}
			>
				<SetIcon name="copy" size={15} />
				Copy as YAML
			</button>
		</div>
	)
}

interface ControlProps {
	row: SettingRow
	value: SettingValue
	labelId: string
	noteId: string | undefined
	disabled: boolean
	phone: boolean
	onChange: (value: SettingValue) => void
	onInvalid: (error: string | null) => void
}

function Control({
	row,
	value,
	labelId,
	noteId,
	disabled,
	phone,
	onChange,
	onInvalid,
}: ControlProps) {
	const w = row.widget
	const aria = {
		"aria-labelledby": labelId,
		...(noteId ? { "aria-describedby": noteId } : {}),
	}
	switch (w.kind) {
		case "switch":
			return (
				<Switch
					{...aria}
					size="row"
					checked={value === true}
					disabled={disabled}
					onChange={onChange}
				/>
			)
		case "seg":
			return (
				<Seg
					label={row.label}
					options={w.options.map(o => ({
						value: o.value,
						label: o.label,
						disabled: disabled || o.disabled !== undefined,
					}))}
					value={String(value)}
					onChange={v => onChange(v)}
					{...(phone ? { size: "lg" as const } : {})}
				/>
			)
		case "ramp": {
			// strips drawn from the scope's own ground and accent (the row re-renders on a theme change)
			const colors =
				typeof document === "undefined"
					? null
					: themeColors(document.documentElement)
			return (
				<div
					role="radiogroup"
					{...aria}
					className="wkf-set-ramps"
					onKeyDown={e => {
						const keys: Record<string, number> = {
							ArrowRight: 1,
							ArrowDown: 1,
							ArrowLeft: -1,
							ArrowUp: -1,
						}
						const d = keys[e.key]
						if (d === undefined || disabled) return
						e.preventDefault()
						const i = w.options.findIndex(o => o.value === value)
						const n = w.options.length
						const next = w.options[(i + d + n) % n]
						if (!next) return
						onChange(next.value)
						const host = e.currentTarget
						requestAnimationFrame(() =>
							host
								.querySelector<HTMLElement>(`[data-value="${next.value}"]`)
								?.focus(),
						)
					}}
				>
					{w.options.map(o => {
						const on = o.value === value
						return (
							<button
								key={o.value}
								type="button"
								role="radio"
								aria-checked={on}
								data-value={o.value}
								tabIndex={on ? 0 : -1}
								className="wkf-set-ramp"
								disabled={disabled || o.disabled !== undefined}
								onClick={() => onChange(o.value)}
							>
								<span className="wkf-set-ramp-ring">
									<span
										aria-hidden="true"
										className="wkf-set-ramp-strip"
										style={
											colors
												? {
														background: rampGradient(
															o.value as WaterfallName,
															colors,
														),
													}
												: undefined
										}
									/>
								</span>
								<span className="wkf-set-ramp-label">
									<svg
										width="11"
										height="11"
										viewBox="0 0 24 24"
										fill="none"
										stroke="currentColor"
										strokeWidth="3"
										strokeLinecap="round"
										strokeLinejoin="round"
										aria-hidden="true"
										style={{ opacity: on ? 1 : 0 }}
									>
										<path d="M5 12l5 5l10 -10" />
									</svg>
									<span>{o.label}</span>
								</span>
							</button>
						)
					})}
				</div>
			)
		}
		case "select":
			return (
				<select
					{...aria}
					className="wk-select wkf-set-select"
					data-size={phone ? "touch" : undefined}
					value={String(value ?? "")}
					disabled={disabled}
					onChange={e => onChange(e.target.value)}
				>
					{w.options.map(o => (
						<option
							key={o.value}
							value={o.value}
							disabled={o.disabled !== undefined}
						>
							{o.label}
						</option>
					))}
				</select>
			)
		case "stepper":
			return (
				<Stepper
					aria={aria}
					label={row.label}
					value={typeof value === "number" ? value : null}
					min={w.min}
					max={w.max}
					step={w.step}
					unit={w.unit ?? ""}
					disabled={disabled}
					phone={phone}
					onChange={onChange}
				/>
			)
		case "slider": {
			const v = typeof value === "number" ? value : w.min
			const frac = (v - w.min) / (w.max - w.min || 1)
			return (
				<div className="wkf-set-slider">
					<div
						className="wk-slider wkf-grow"
						style={{ "--wk-value": String(frac) } as CSSProperties}
					>
						<div className="wk-slider-track">
							<div className="wk-slider-fill" />
						</div>
						<div className="wk-slider-knob" />
						<input
							{...aria}
							type="range"
							min={w.min}
							max={w.max}
							step={w.step}
							value={v}
							disabled={disabled}
							aria-valuetext={w.format(v)}
							onChange={e => onChange(Number(e.target.value))}
						/>
					</div>
					<b className="wkf-num">{w.format(v)}</b>
				</div>
			)
		}
		case "text":
			return (
				<TextControl
					aria={aria}
					widget={w}
					value={value}
					disabled={disabled}
					onCommit={onChange}
					onInvalid={onInvalid}
				/>
			)
		case "chips": {
			const list = Array.isArray(value) ? (value as readonly string[]) : []
			return (
				<div role="group" {...aria} className="wkf-set-chips">
					{w.options.map(o => {
						const on = list.includes(o.value)
						return (
							<Chip
								key={o.value}
								size="sm"
								tick
								pressed={on}
								disabled={disabled}
								onClick={() =>
									onChange(
										on ? list.filter(x => x !== o.value) : [...list, o.value],
									)
								}
							>
								{o.label}
							</Chip>
						)
					})}
				</div>
			)
		}
		case "link":
			return (
				<button type="button" className="wkf-set-link" onClick={w.action}>
					{w.text}
					<SetIcon name="chevron-right" size={14} />
				</button>
			)
		case "buttons":
			return (
				<span className="wkf-set-btns">
					{w.buttons.map(b =>
						b.href ? (
							<a
								key={b.label}
								className="wk-btn"
								data-variant="outline"
								href={b.href}
								download
							>
								{b.label}
							</a>
						) : (
							<button
								key={b.label}
								type="button"
								className="wk-btn"
								data-variant="outline"
								onClick={b.action}
							>
								{b.label}
							</button>
						),
					)}
				</span>
			)
		case "read":
		case "page":
			return <span className="wkf-set-read">{row.text}</span>
	}
}

function Stepper({
	aria,
	label,
	value,
	min,
	max,
	step,
	unit,
	disabled,
	phone,
	onChange,
}: {
	aria: Record<string, string>
	label: string
	value: number | null
	min: number
	max: number
	step: number
	unit: string
	disabled: boolean
	phone: boolean
	onChange: (value: SettingValue) => void
}) {
	const [draft, setDraft] = useState<string | null>(null)
	const round = (v: number) => Math.round(v / step) * step
	const clamp = (v: number) => Math.min(max, Math.max(min, round(v)))
	const fmt = (v: number) => String(Number(v.toFixed(6)))
	const bump = (dir: 1 | -1) => {
		const base = value ?? (min <= 0 && max >= 0 ? 0 : min)
		const next = clamp(base + dir * step)
		if (next !== value) onChange(next)
	}
	const commit = () => {
		if (draft === null) return
		const n = Number(draft.replace(",", ".").replace(/[^\d.+-]/g, ""))
		setDraft(null)
		if (draft.trim() === "" || !Number.isFinite(n)) return
		const next = clamp(n)
		if (next !== value) onChange(next)
	}
	const atMin = value !== null && value <= min
	const atMax = value !== null && value >= max
	return (
		<div
			role="group"
			{...aria}
			className="wk-stepper wkf-set-stepper"
			data-size={phone ? "touch" : undefined}
		>
			<button
				type="button"
				aria-label={`Decrease ${label}`}
				aria-disabled={disabled || atMin || undefined}
				onClick={() => !disabled && !atMin && bump(-1)}
			>
				−
			</button>
			<input
				aria-label={label}
				inputMode="decimal"
				spellCheck={false}
				disabled={disabled}
				value={draft ?? (value === null ? "" : fmt(value))}
				placeholder="—"
				onChange={e => setDraft(e.target.value)}
				onBlur={commit}
				onKeyDown={e => {
					if (e.key === "Enter") commit()
					else if (e.key === "Escape" && draft !== null) {
						e.stopPropagation()
						setDraft(null)
					} else if (e.key === "ArrowUp") {
						e.preventDefault()
						bump(1)
					} else if (e.key === "ArrowDown") {
						e.preventDefault()
						bump(-1)
					}
				}}
			/>
			{unit && <span className="wkf-set-unit">{unit.trim()}</span>}
			<button
				type="button"
				aria-label={`Increase ${label}`}
				aria-disabled={disabled || atMax || undefined}
				onClick={() => !disabled && !atMax && bump(1)}
			>
				+
			</button>
		</div>
	)
}

function TextControl({
	aria,
	widget,
	value,
	disabled,
	onCommit,
	onInvalid,
}: {
	aria: Record<string, string>
	widget: TextWidget
	value: SettingValue
	disabled: boolean
	onCommit: (value: SettingValue) => void
	onInvalid: (error: string | null) => void
}) {
	const [draft, setDraft] = useState<string | null>(null)
	const [bad, setBad] = useState(false)
	const [reveal, setReveal] = useState(false)
	const [filling, setFilling] = useState(false)
	const shown = widget.format(value)
	const fill = async () => {
		if (!widget.fill || filling) return
		setFilling(true)
		const got = await widget.fill.run()
		setFilling(false)
		if ("error" in got) {
			onInvalid(got.error)
			return
		}
		setBad(false)
		onInvalid(null)
		setDraft(null)
		if (widget.format(got.value) !== shown) onCommit(got.value)
	}
	const commit = () => {
		if (draft === null) return
		const parsed = widget.parse(draft)
		if ("error" in parsed) {
			setBad(true)
			onInvalid(parsed.error)
			return
		}
		setBad(false)
		onInvalid(null)
		setDraft(null)
		if (widget.format(parsed.value) !== shown) onCommit(parsed.value)
	}
	return (
		<span className="wkf-set-text">
			<input
				{...aria}
				className="wk-input wkf-set-box"
				data-bad={bad || undefined}
				type={widget.secret && !reveal ? "password" : "text"}
				inputMode={widget.inputMode ?? "text"}
				spellCheck={false}
				autoComplete="off"
				disabled={disabled}
				placeholder={widget.placeholder}
				value={draft ?? shown}
				onChange={e => setDraft(e.target.value)}
				onBlur={commit}
				onKeyDown={e => {
					if (e.key === "Enter") commit()
					else if (e.key === "Escape" && draft !== null) {
						e.stopPropagation()
						setDraft(null)
						setBad(false)
						onInvalid(null)
					}
				}}
			/>
			{widget.secret && (
				<button
					type="button"
					className="wk-btn"
					data-variant="ghost"
					onClick={() => setReveal(r => !r)}
				>
					{reveal ? "Hide" : "Reveal"}
				</button>
			)}
			{widget.fill && !disabled && (
				<button
					type="button"
					className="wk-btn wkf-set-fill"
					data-variant="outline"
					aria-busy={filling || undefined}
					disabled={filling}
					onClick={() => void fill()}
				>
					{filling ? (
						<span className="wk-spinner" aria-hidden="true" />
					) : (
						<SetIcon name="locate" size={15} />
					)}
					<span className="wkf-set-fill-text">
						{filling ? widget.fill.busyLabel : widget.fill.label}
					</span>
				</button>
			)}
		</span>
	)
}
