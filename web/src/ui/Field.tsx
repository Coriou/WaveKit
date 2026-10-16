import type { InputHTMLAttributes, ReactNode, Ref } from "react"

import { cx } from "./cx.ts"

export interface FieldProps extends Omit<
	InputHTMLAttributes<HTMLInputElement>,
	"aria-label"
> {
	/** Accessible name of the input (the field has no visible label). */
	label: string
	/** Leading content, usually an icon. */
	leading?: ReactNode
	/** Trailing content, usually tokens or a clear button. */
	trailing?: ReactNode
	fieldClassName?: string
	ref?: Ref<HTMLInputElement>
}

/** `.wk-field`: the 44 px search shell with its input. */
export function Field({
	label,
	leading,
	trailing,
	fieldClassName,
	...rest
}: FieldProps) {
	return (
		<div className={cx("wk-field", fieldClassName)}>
			{leading}
			<input {...rest} aria-label={label} />
			{trailing}
		</div>
	)
}

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
	ref?: Ref<HTMLInputElement>
}

/** `.wk-input`: the 32 px inline field. */
export function Input({ className, ...rest }: InputProps) {
	return <input {...rest} className={cx("wk-input", className)} />
}
