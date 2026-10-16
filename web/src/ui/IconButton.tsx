import type { ButtonHTMLAttributes, Ref } from "react"

import { cx, flag } from "./cx.ts"

export type IconButtonSize = "xs" | "sm" | "md" | "lg" | "touch"

export interface IconButtonProps extends Omit<
	ButtonHTMLAttributes<HTMLButtonElement>,
	"aria-label"
> {
	/** Accessible name; icon buttons have no visible text. */
	label: string
	size?: IconButtonSize
	/** `data-close`: the 36 px close button of drawers and sheets. */
	close?: boolean
	/** Toggle state, rendered as `aria-pressed`. */
	pressed?: boolean
	ref?: Ref<HTMLButtonElement>
}

/** `.wk-icon-btn`. */
export function IconButton({
	label,
	size,
	close,
	pressed,
	className,
	type = "button",
	...rest
}: IconButtonProps) {
	return (
		<button
			{...rest}
			type={type}
			aria-label={label}
			aria-pressed={pressed}
			className={cx("wk-icon-btn", className)}
			data-size={size === "md" ? undefined : size}
			data-close={flag(close)}
		/>
	)
}
