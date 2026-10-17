import {
	useRef,
	type CSSProperties,
	type KeyboardEvent,
	type ReactNode,
} from "react"

import { cx } from "./cx.ts"

export interface SegOption<T extends string> {
	value: T
	label: ReactNode
	/** Accessible name when `label` is not text (an icon). */
	ariaLabel?: string
	disabled?: boolean
}

export interface SegProps<T extends string> {
	/** Accessible name of the group. */
	label: string
	options: ReadonlyArray<SegOption<T>>
	value: T
	onChange: (value: T) => void
	size?: "md" | "lg"
	/** `.is-wide`: equal columns filling the width. */
	wide?: boolean
	/** `.is-grid` with this many columns (`--wk-seg-cols`). */
	columns?: number
	className?: string
	id?: string
}

/** `.wk-seg`: a single-choice radio group. Arrow keys move and select; one tab stop. */
export function Seg<T extends string>({
	label,
	options,
	value,
	onChange,
	size,
	wide,
	columns,
	className,
	id,
}: SegProps<T>) {
	const group = useRef<HTMLDivElement>(null)
	const enabled = options.filter(o => !o.disabled)
	const checked = options.some(o => o.value === value)
	const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
		const step =
			e.key === "ArrowRight" || e.key === "ArrowDown"
				? 1
				: e.key === "ArrowLeft" || e.key === "ArrowUp"
					? -1
					: 0
		const edge =
			e.key === "Home" ? 0 : e.key === "End" ? enabled.length - 1 : -1
		if (!step && edge < 0) return
		e.preventDefault()
		const at = enabled.findIndex(o => o.value === value)
		const next =
			edge >= 0
				? enabled[edge]
				: enabled[(at + step + enabled.length) % enabled.length]
		if (!next) return
		onChange(next.value)
		group.current
			?.querySelector<HTMLButtonElement>(
				`[data-value="${CSS.escape(next.value)}"]`,
			)
			?.focus()
	}
	const style = columns
		? ({ "--wk-seg-cols": String(columns) } as CSSProperties)
		: undefined
	return (
		<div
			ref={group}
			id={id}
			role="radiogroup"
			aria-label={label}
			className={cx(
				"wk-seg",
				wide && "is-wide",
				columns !== undefined && "is-grid",
				className,
			)}
			data-size={size === "lg" ? "lg" : undefined}
			style={style}
			onKeyDown={onKey}
		>
			{options.map(o => {
				const on = o.value === value
				// with no option checked (an unknown value) the first enabled one keeps the tab stop
				const stop = on || (!checked && o === enabled[0])
				return (
					<button
						key={o.value}
						type="button"
						role="radio"
						aria-checked={on}
						aria-label={o.ariaLabel}
						data-value={o.value}
						disabled={o.disabled}
						tabIndex={stop ? 0 : -1}
						onClick={() => onChange(o.value)}
					>
						{o.label}
					</button>
				)
			})}
		</div>
	)
}
