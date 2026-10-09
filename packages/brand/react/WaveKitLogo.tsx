import type { SVGProps } from "react"
import {
	baselinePath,
	baselineTransform,
	integratedMarkTransform,
	letteringPath,
	letteringTransform,
	markPath,
} from "./geometry.js"

export type LogoTone =
	| "on-light"
	| "on-dark"
	| "ink"
	| "black"
	| "white"
	| "currentColor"

export type WaveKitLogoProps = Omit<
	SVGProps<SVGSVGElement>,
	"children" | "viewBox"
> & {
	tone?: LogoTone
	/** Adds the official baseline. Only use at 320 CSS px wide or more. */
	baseline?: boolean
	label?: string
	decorative?: boolean
}

// [signal, lettering] fill/stroke colours per tone.
const tones: Record<LogoTone, readonly [string, string]> = {
	"on-light": ["#16735C", "#111C19"],
	"on-dark": ["#7BECC7", "#F4F7F5"],
	ink: ["#111C19", "#111C19"],
	black: ["#000", "#000"],
	white: ["#fff", "#fff"],
	currentColor: ["currentColor", "currentColor"],
}

export function WaveKitLogo({
	tone = "on-light",
	baseline = false,
	label,
	decorative = false,
	width,
	height,
	style,
	...rest
}: WaveKitLogoProps) {
	const [signal, text] = tones[tone]
	const name =
		label ?? (baseline ? "WaveKit — MAKE SENSE OF THE SPECTRUM" : "WaveKit")
	return (
		<svg
			{...rest}
			xmlns="http://www.w3.org/2000/svg"
			viewBox={`0 0 680 ${baseline ? 215 : 164}`}
			width={width ?? (baseline ? 320 : 180)}
			height={height}
			style={{ display: "block", height: "auto", ...style }}
			fill="none"
			role={decorative ? undefined : "img"}
			aria-hidden={decorative || undefined}
			aria-label={decorative ? undefined : name}
			focusable="false"
		>
			<g transform={integratedMarkTransform}>
				<path
					d={markPath}
					fill="none"
					stroke={signal}
					strokeWidth={26}
					strokeLinecap="butt"
					strokeLinejoin="round"
				/>
			</g>
			<g transform={letteringTransform}>
				<path d={letteringPath} fill={text} />
			</g>
			{baseline && (
				<g transform={baselineTransform}>
					<path d={baselinePath} fill={text} />
				</g>
			)}
		</svg>
	)
}
