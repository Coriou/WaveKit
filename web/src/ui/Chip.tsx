import type { ButtonHTMLAttributes, ReactNode, Ref } from "react"

import { cx, flag } from "./cx.ts"

export interface ChipProps extends ButtonHTMLAttributes<HTMLButtonElement> {
	size?: "sm" | "md"
	/** On state, rendered as `aria-pressed`. */
	pressed?: boolean
	/** `data-tick`: the leading dot that fills when on. */
	tick?: boolean
	/** A `.wk-count` after the label. */
	count?: ReactNode
	ref?: Ref<HTMLButtonElement>
}

/** `.wk-chip` as a toggle button. */
export function Chip({
	size,
	pressed,
	tick,
	count,
	className,
	children,
	type = "button",
	...rest
}: ChipProps) {
	return (
		<button
			{...rest}
			type={type}
			aria-pressed={pressed}
			className={cx("wk-chip", className)}
			data-size={size === "sm" ? "sm" : undefined}
			data-tick={flag(tick)}
		>
			{children}
			{count !== undefined && <span className="wk-count">{count}</span>}
		</button>
	)
}
