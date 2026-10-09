import type { SVGProps } from "react"
import { markPath } from "./geometry.js"

export type WaveKitMarkProps = Omit<
	SVGProps<SVGSVGElement>,
	"children" | "viewBox" | "strokeWidth"
> & {
	size?: number
	/** The small cut (30-unit stroke) is for 16–23 px. Defaults by size. */
	opticalSize?: "standard" | "small"
	label?: string
}

export function WaveKitMark({
	size = 24,
	opticalSize = size < 24 ? "small" : "standard",
	label,
	...rest
}: WaveKitMarkProps) {
	return (
		<svg
			{...rest}
			xmlns="http://www.w3.org/2000/svg"
			viewBox="0 0 256 256"
			width={size}
			height={size}
			fill="none"
			role={label ? "img" : undefined}
			aria-label={label}
			aria-hidden={label ? undefined : true}
			focusable="false"
		>
			<path
				d={markPath}
				fill="none"
				stroke="currentColor"
				strokeWidth={opticalSize === "small" ? 30 : 26}
				strokeLinecap="butt"
				strokeLinejoin="round"
			/>
		</svg>
	)
}
