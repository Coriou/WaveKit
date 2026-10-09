import { createElement, type SVGProps } from "react"
import { iconNodes, type CategoryName, type IconNode } from "./icon-nodes.js"

export type { CategoryName } from "./icon-nodes.js"

export type WaveKitIconProps = Omit<
	SVGProps<SVGSVGElement>,
	"children" | "viewBox" | "strokeWidth"
> & {
	name: CategoryName
	size?: number
	tone?: "mono" | "on-light" | "on-dark"
	label?: string
}

// [base, accent] stroke colours per tone. Mono inherits `color`.
const tones = {
	mono: ["currentColor", "currentColor"],
	"on-light": ["#111C19", "#16735C"],
	"on-dark": ["#F4F7F5", "#7BECC7"],
} as const

function draw(nodes: readonly IconNode[]) {
	return nodes.map(([tag, attrs], index) =>
		createElement(tag, { ...attrs, key: index }),
	)
}

export function WaveKitIcon({
	name,
	size = 24,
	tone = "mono",
	label,
	...rest
}: WaveKitIconProps) {
	const nodes = iconNodes[name]
	const [base, accent] = tones[tone]
	return (
		<svg
			{...rest}
			xmlns="http://www.w3.org/2000/svg"
			viewBox="0 0 24 24"
			width={size}
			height={size}
			fill="none"
			strokeWidth={2}
			strokeLinecap="round"
			strokeLinejoin="round"
			focusable="false"
			role={label ? "img" : undefined}
			aria-label={label}
			aria-hidden={label ? undefined : true}
		>
			<g stroke={base}>{draw(nodes.base)}</g>
			<g stroke={accent}>{draw(nodes.accent)}</g>
		</svg>
	)
}
