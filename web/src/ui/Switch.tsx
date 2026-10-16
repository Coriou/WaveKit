import type { ButtonHTMLAttributes, Ref } from "react"

import { cx } from "./cx.ts"

export interface SwitchProps extends Omit<
	ButtonHTMLAttributes<HTMLButtonElement>,
	"onChange" | "role" | "aria-checked"
> {
	checked: boolean
	onChange: (checked: boolean) => void
	/** `row`: the 52 × 44 hit box of settings rows. */
	size?: "row"
	ref?: Ref<HTMLButtonElement>
}

/** `.wk-switch`: a `role="switch"` button. Name it with `aria-label` or `aria-labelledby`. */
export function Switch({
	checked,
	onChange,
	size,
	className,
	onClick,
	type = "button",
	...rest
}: SwitchProps) {
	return (
		<button
			{...rest}
			type={type}
			role="switch"
			aria-checked={checked}
			className={cx("wk-switch", className)}
			data-size={size}
			onClick={e => {
				onClick?.(e)
				if (!e.defaultPrevented) onChange(!checked)
			}}
		/>
	)
}
