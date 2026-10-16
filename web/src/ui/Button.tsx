import type { ButtonHTMLAttributes, Ref } from "react"

import { cx } from "./cx.ts"

export type ButtonVariant =
	| "primary"
	| "amber"
	| "tonal"
	| "danger"
	| "outline"
	| "ghost"
export type ButtonSize = "sm" | "md" | "lg"

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
	variant?: ButtonVariant
	size?: ButtonSize
	ref?: Ref<HTMLButtonElement>
}

/** `.wk-btn`. A leading `<svg>` child gets the recipe's icon spacing. */
export function Button({
	variant,
	size,
	className,
	type = "button",
	...rest
}: ButtonProps) {
	return (
		<button
			{...rest}
			type={type}
			className={cx("wk-btn", className)}
			data-variant={variant}
			data-size={size === "md" ? undefined : size}
		/>
	)
}
