import type { HTMLAttributes } from "react"

import { cx } from "./cx.ts"

/** `.wk-kbd`: a key cap. */
export function Kbd({ className, ...rest }: HTMLAttributes<HTMLElement>) {
	return <kbd {...rest} className={cx("wk-kbd", className)} />
}
