import type { HTMLAttributes, Ref } from "react"

import { cx, flag } from "./cx.ts"

export interface IslandProps extends HTMLAttributes<HTMLDivElement> {
	/** `data-expanded`: the denser panel glass of an open island panel. */
	expanded?: boolean
	tone?: "amber"
	ref?: Ref<HTMLDivElement>
}

/** `.wk-island`: a glass island. Glass budget: never nest one inside another blurred element. */
export function Island({ expanded, tone, className, ...rest }: IslandProps) {
	return (
		<div
			{...rest}
			className={cx("wk-island", className)}
			data-expanded={flag(expanded)}
			data-tone={tone}
		/>
	)
}

/** `.wk-island.wk-island-head`: the 56 px collapsed island header row. */
export function IslandHead({
	className,
	...rest
}: Omit<IslandProps, "expanded">) {
	return <Island {...rest} className={cx("wk-island-head", className)} />
}
