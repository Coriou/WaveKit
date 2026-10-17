// The end of Activity's chip row (Activity board): "With audio" and the time range chip ("Any time ▾") with its
// menu of rolling ranges and a custom span. Both narrow the drawer's list and every column.
import { useEffect, useRef, useState } from "react"
import type { KeyboardEvent as ReactKeyboardEvent } from "react"

import { useServices } from "../../app/context.ts"
import { useStore } from "../../data/index.ts"
import { Button } from "../../ui/Button.tsx"
import { Chip } from "../../ui/Chip.tsx"
import { Icon } from "../../ui/Icon.tsx"
import type { TimeRange } from "./scope.ts"
import {
	TIME_RANGES,
	customRange,
	localInput,
	rangeLabel,
	sameRange,
} from "./scope.ts"

export function ScopeChips() {
	const { activity } = useServices()
	const audio = useStore(activity, s => s.audio)
	return (
		<>
			<span className="wka-chips-sep" aria-hidden="true" />
			<Chip
				size="sm"
				pressed={audio}
				title="Only transmissions and calls (voice). Playback comes once recordings are linked to events."
				onClick={() => activity.setAudio(!audio)}
			>
				<Icon name="headphones" />
				With audio
			</Chip>
			<RangeChip />
		</>
	)
}

function RangeChip() {
	const { activity } = useServices()
	const range = useStore(activity, s => s.range)
	const [open, setOpen] = useState(false)
	const [custom, setCustom] = useState(false)
	const chip = useRef<HTMLButtonElement>(null)
	const menu = useRef<HTMLDivElement>(null)

	const close = (focusBack: boolean) => {
		setOpen(false)
		setCustom(false)
		if (focusBack) chip.current?.focus()
	}

	useEffect(() => {
		if (!open) return
		menu.current
			?.querySelector<HTMLElement>("[aria-checked=true], [role=menuitemradio]")
			?.focus()
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return
			e.preventDefault()
			e.stopPropagation()
			close(true)
		}
		const onDown = (e: PointerEvent) => {
			const t = e.target as Node | null
			if (t && (menu.current?.contains(t) || chip.current?.contains(t))) return
			close(false)
		}
		document.addEventListener("keydown", onKey, true)
		document.addEventListener("pointerdown", onDown, true)
		return () => {
			document.removeEventListener("keydown", onKey, true)
			document.removeEventListener("pointerdown", onDown, true)
		}
	}, [open])

	const pick = (r: TimeRange) => {
		activity.setRange(r)
		close(true)
	}

	const onMenuKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
		if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return
		const items = [
			...(menu.current?.querySelectorAll<HTMLElement>("[role^=menuitem]") ??
				[]),
		]
		const at = items.indexOf(document.activeElement as HTMLElement)
		if (at < 0) return
		e.preventDefault()
		const by = e.key === "ArrowDown" ? 1 : -1
		items[(at + by + items.length) % items.length]?.focus()
	}

	const now = Date.now()
	return (
		<span className="wka-range">
			<Chip
				ref={chip}
				size="sm"
				pressed={range.kind !== "any"}
				aria-haspopup="menu"
				aria-expanded={open}
				title="When it was heard"
				onClick={() => (open ? close(false) : setOpen(true))}
			>
				{rangeLabel(range, now)}
				<Icon name="chevron-down" />
			</Chip>
			{open && (
				<div
					ref={menu}
					role="menu"
					aria-label="Time range"
					className="wk-menu wka-range-menu"
					onKeyDown={onMenuKey}
				>
					{TIME_RANGES.map(r => (
						<button
							key={r.id}
							type="button"
							role="menuitemradio"
							aria-checked={sameRange(range, { kind: r.id })}
							className="wk-option"
							onClick={() => pick({ kind: r.id })}
						>
							{r.label}
						</button>
					))}
					<div className="wk-menu-sep" />
					<button
						type="button"
						role="menuitemradio"
						aria-checked={range.kind === "custom"}
						aria-expanded={custom}
						className="wk-option"
						onClick={() => setCustom(c => !c)}
					>
						Custom range…
					</button>
					{custom && (
						<CustomRange range={range} now={now} onApply={r => pick(r)} />
					)}
				</div>
			)}
		</span>
	)
}

function CustomRange({
	range,
	now,
	onApply,
}: {
	range: TimeRange
	now: number
	onApply: (r: TimeRange) => void
}) {
	const [from, setFrom] = useState(() =>
		localInput(range.kind === "custom" ? range.from : now - 3_600_000),
	)
	const [to, setTo] = useState(() =>
		range.kind === "custom" && range.to !== null ? localInput(range.to) : "",
	)
	const next = customRange(from, to)
	const max = localInput(now + 60_000)
	return (
		<form
			className="wka-range-custom"
			onSubmit={e => {
				e.preventDefault()
				if (next) onApply(next)
			}}
		>
			<label>
				<span className="wk-label">From</span>
				<input
					className="wk-input"
					type="datetime-local"
					value={from}
					max={max}
					onChange={e => setFrom(e.target.value)}
				/>
			</label>
			<label>
				<span className="wk-label">To</span>
				<input
					className="wk-input"
					type="datetime-local"
					value={to}
					min={from}
					onChange={e => setTo(e.target.value)}
				/>
			</label>
			<span className="wka-range-hint">
				{next === null
					? "The end must come after the start."
					: to === ""
						? "No end: new events keep arriving."
						: "A past range: nothing new arrives."}
			</span>
			<Button type="submit" variant="tonal" size="sm" disabled={next === null}>
				Show
			</Button>
		</form>
	)
}
