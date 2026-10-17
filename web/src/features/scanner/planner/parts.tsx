// Small pieces both planner modes use: glyphs, the anchored popover, typed MHz edges, the protocol and skip editors.
import {
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
	type KeyboardEvent,
	type ReactNode,
} from "react"
import type { ScannerProtocol } from "@wavekit/api-types"

import { Button } from "../../../ui/Button.tsx"
import { Chip } from "../../../ui/Chip.tsx"
import { cx } from "../../../ui/cx.ts"
import {
	choiceOn,
	edgesText,
	mhzField,
	parseMHz,
	PROTOCOL_CHOICES,
	protocolLabels,
	toggleChoice,
} from "./plan.ts"

/** Table layout by the planner's width: one line from 860 px, two lines below, stacked on a phone. */
export type PlannerSize = "wide" | "two" | "narrow"

const GLYPHS = {
	back: "M15 6l-6 6l6 6",
	hide: "M7 7l5 5l-5 5M13 7l5 5l-5 5",
	more: "",
	chevron: "M6 9l6 6l6 -6",
	plus: "M12 5v14M5 12h14",
	minus: "M5 12h14",
	x: "M6 6l12 12M18 6l-12 12",
	lock: "M5 13a2 2 0 0 1 2 -2h10a2 2 0 0 1 2 2v6a2 2 0 0 1 -2 2h-10a2 2 0 0 1 -2 -2zM8 11v-4a4 4 0 1 1 8 0v4",
	options: "M4 8h4m4 0h8M4 16h10m4 0h2M8 6v4M14 14v4",
	pause: "M6 5h4v14h-4zM14 5h4v14h-4z",
	scan: "M21 12h-8a1 1 0 1 0 -1 1v8a9 9 0 0 0 9 -9M16 9a5 5 0 1 0 -7 7M20.486 9a9 9 0 1 0 -11.482 11.495",
	pencil: "M4 20h4l10.5 -10.5a2.828 2.828 0 1 0 -4 -4l-10.5 10.5v4",
	bookmark: "M18 7v14l-6 -4l-6 4v-14a4 4 0 0 1 4 -4h4a4 4 0 0 1 4 4z",
	save: "M6 4h10l4 4v10a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2v-12a2 2 0 0 1 2 -2M10 14a2 2 0 1 0 4 0a2 2 0 1 0 -4 0M14 4v4h-6v-4",
} as const

export type GlyphName = keyof typeof GLYPHS

/** A decorative 24 px outline glyph (the control carries the name). */
export function Glyph({
	name,
	size = 16,
	className,
}: {
	name: GlyphName
	size?: number
	className?: string | undefined
}) {
	if (name === "more")
		return (
			<svg
				width={size}
				height={size}
				viewBox="0 0 24 24"
				fill="currentColor"
				aria-hidden="true"
				className={className}
			>
				<circle cx="5" cy="12" r="1.7" />
				<circle cx="12" cy="12" r="1.7" />
				<circle cx="19" cy="12" r="1.7" />
			</svg>
		)
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
			className={className}
		>
			<path d={GLYPHS[name]} />
		</svg>
	)
}

// ---- the anchored popover

export interface PopAnchor {
	/** The control that opened it (focus goes back there). */
	readonly el: HTMLElement
}

export interface PopoverProps {
	anchor: PopAnchor
	/** The planner root the popover is placed in. */
	root: HTMLElement | null
	label: string
	width?: number
	/** Opens upwards from the anchor (the footer's Options). */
	up?: boolean
	role?: "dialog" | "menu"
	onClose: () => void
	children: ReactNode
}

/** A popover inside the planner, under (or over) its anchor, clamped to the planner; a pointer outside closes it. */
export function Popover({
	anchor,
	root,
	label,
	width = 300,
	up,
	role = "dialog",
	onClose,
	children,
}: PopoverProps) {
	const box = useRef<HTMLDivElement>(null)
	const [pos, setPos] = useState<{
		left: number
		top?: number
		bottom?: number
		maxH: number
	} | null>(null)
	useLayoutEffect(() => {
		if (!root) return
		const r = root.getBoundingClientRect()
		const a = anchor.el.getBoundingClientRect()
		const w = Math.min(width, r.width - 16)
		const left = Math.max(8, Math.min(a.left - r.left, r.width - w - 8))
		const below = r.bottom - a.bottom - 12
		const above = a.top - r.top - 12
		if (!up && (below >= 220 || below >= above))
			setPos({ left, top: a.bottom - r.top + 6, maxH: below })
		else setPos({ left, bottom: r.bottom - a.top + 6, maxH: above })
	}, [anchor, root, width, up])
	useEffect(() => {
		const first = box.current?.querySelector<HTMLElement>(
			"input, button:not([disabled])",
		)
		first?.focus({ preventScroll: true })
	}, [pos === null])
	const close = () => {
		onClose()
		anchor.el.focus({ preventScroll: true })
	}
	const onKey = (e: KeyboardEvent) => {
		if (e.key !== "Escape") return
		e.preventDefault()
		e.stopPropagation()
		close()
	}
	return (
		<>
			<div className="wk-pl-scrim" aria-hidden="true" onPointerDown={close} />
			<div
				ref={box}
				role={role}
				aria-label={label}
				className="wk-pl-pop wk-scroll"
				onKeyDown={onKey}
				style={{
					width: Math.min(width, (root?.clientWidth ?? width) - 16),
					left: pos?.left ?? 0,
					top: pos?.top,
					bottom: pos?.bottom,
					maxHeight: pos ? Math.max(160, pos.maxH) : undefined,
					visibility: pos ? undefined : "hidden",
				}}
			>
				{children}
			</div>
		</>
	)
}

// ---- typed MHz edge

export interface EdgeInputProps {
	hz: number
	label: string
	onCommit: (hz: number) => void
	invalid?: boolean | undefined
	title?: string | undefined
	className?: string | undefined
}

/** A MHz text field: commits on Enter or blur, reverts on Escape; the typed text stays while it is not a number. */
export function EdgeInput({
	hz,
	label,
	onCommit,
	invalid,
	title,
	className,
}: EdgeInputProps) {
	const [text, setText] = useState(() => mhzField(hz))
	const [focused, setFocused] = useState(false)
	useEffect(() => {
		if (!focused) setText(mhzField(hz))
	}, [hz, focused])
	const bad = parseMHz(text) === null
	const commit = () => {
		const v = parseMHz(text)
		if (v !== null && v !== hz) onCommit(v)
	}
	return (
		<input
			className={cx("wk-pl-box", className)}
			value={text}
			aria-label={label}
			aria-invalid={invalid || bad || undefined}
			title={title}
			inputMode="decimal"
			spellCheck={false}
			autoComplete="off"
			onFocus={() => setFocused(true)}
			onBlur={() => {
				setFocused(false)
				commit()
			}}
			onChange={e => setText(e.target.value)}
			onKeyDown={e => {
				if (e.key === "Enter") commit()
				else if (e.key === "Escape" && text !== mhzField(hz)) {
					e.stopPropagation()
					e.preventDefault()
					setText(mhzField(hz))
				}
			}}
		/>
	)
}

// ---- protocols

/** The protocol chips of a row: up to `max`, then "+N". */
export function ProtocolChips({
	protocols,
	max = 3,
	off,
}: {
	protocols: readonly string[]
	max?: number
	/** "Just find signals" is on: the chips read as off. */
	off?: boolean
}) {
	const labels = protocolLabels(protocols)
	if (labels.length === 0)
		return <span className="wk-pl-none">{off ? "Off" : "Any signal"}</span>
	const shown = labels.slice(0, max)
	return (
		<>
			{shown.map(l => (
				<span key={l} className="wk-pl-proto" data-off={off || undefined}>
					{l}
				</span>
			))}
			{labels.length > shown.length && (
				<span className="wk-pl-more">+{labels.length - shown.length}</span>
			)}
		</>
	)
}

export function ProtocolPicker({
	protocols,
	onChange,
	signalsOnly,
}: {
	protocols: readonly ScannerProtocol[]
	onChange: (next: ScannerProtocol[]) => void
	signalsOnly?: boolean
}) {
	return (
		<>
			<span className="wk-label wk-pl-th" data-strong="">
				Protocols to try
			</span>
			<div role="group" aria-label="Protocols" className="wk-pl-chips">
				{PROTOCOL_CHOICES.map(c => (
					<Chip
						key={c.label}
						size="sm"
						tick
						pressed={choiceOn(protocols, c)}
						onClick={() => onChange(toggleChoice(protocols, c))}
					>
						{c.label}
					</Chip>
				))}
			</div>
			{signalsOnly && (
				<span className="wk-pl-note">Off while Just find signals is on</span>
			)}
		</>
	)
}

// ---- skips

export interface SkipItem {
	readonly key: string
	readonly startHz: number
	readonly endHz: number
	readonly reason?: string
}

export interface AutoSkip {
	readonly startHz: number
	readonly endHz: number
	/** "AIS, already decoded by AIS-catcher". */
	readonly why: string
}

export function SkipsEditor({
	name,
	range,
	skips,
	auto,
	onChange,
	onAdd,
	onRemove,
}: {
	name: string
	range: { startHz: number; endHz: number }
	skips: readonly SkipItem[]
	auto: readonly AutoSkip[]
	onChange: (key: string, startHz: number, endHz: number) => void
	onAdd: (startHz: number, endHz: number) => void
	onRemove: (key: string) => void
}) {
	const mid = Math.round((range.startHz + range.endHz) / 2 / 5000) * 5000
	return (
		<>
			<span className="wk-label wk-pl-th" data-strong="">
				Skips in {name}
			</span>
			{skips.length === 0 && auto.length === 0 && (
				<span className="wk-pl-note">None</span>
			)}
			{auto.map(x => (
				<div key={`a${x.startHz}`} className="wk-pl-skiprow" title={x.why}>
					<span className="wk-pl-hatch" aria-hidden="true" />
					<span className="wk-pl-skipedges">
						{edgesText(x.startHz, x.endHz)}
					</span>
					<span className="wk-pl-skipwhy">{x.why}</span>
				</div>
			))}
			{skips.map(x => (
				<div key={x.key} className="wk-pl-skiprow">
					<span className="wk-pl-hatch" aria-hidden="true" />
					<EdgeInput
						hz={x.startHz}
						label="Skip, low edge, MHz"
						className="wk-pl-box-sm"
						invalid={x.endHz <= x.startHz}
						onCommit={v => onChange(x.key, v, x.endHz)}
					/>
					<span aria-hidden="true" className="wk-pl-dash">
						–
					</span>
					<EdgeInput
						hz={x.endHz}
						label="Skip, high edge, MHz"
						className="wk-pl-box-sm"
						invalid={x.endHz <= x.startHz}
						onCommit={v => onChange(x.key, x.startHz, v)}
					/>
					<span className="wk-pl-skipwhy">{x.reason ?? "Skipped by you"}</span>
					<button
						type="button"
						className="wk-icon-btn"
						data-size="sm"
						aria-label="Remove this skip"
						title="Remove this skip"
						onClick={() => onRemove(x.key)}
					>
						<Glyph name="x" size={12} />
					</button>
				</div>
			))}
			<Button
				variant="ghost"
				size="sm"
				className="wk-pl-addskip"
				title="Or drag across the ruler with Skip"
				onClick={() => onAdd(mid - 12_500, mid + 12_500)}
			>
				<Glyph name="plus" size={13} />
				Add a skip
			</Button>
		</>
	)
}
