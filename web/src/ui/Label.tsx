import type { HTMLAttributes } from "react"

import { cx, flag } from "./cx.ts"

export interface LabelProps extends HTMLAttributes<HTMLElement> {
	/** `data-strong`: the 13 px bold section label. */
	strong?: boolean
	/** Element to render; a `<label>` needs `htmlFor` from the caller. */
	as?: "span" | "div" | "h3" | "h4" | "label"
	htmlFor?: string
}

/** `.wk-label`: uppercase section label. */
export function Label({
	strong,
	as: Tag = "span",
	className,
	...rest
}: LabelProps) {
	return (
		<Tag
			{...rest}
			className={cx("wk-label", className)}
			data-strong={flag(strong)}
		/>
	)
}
