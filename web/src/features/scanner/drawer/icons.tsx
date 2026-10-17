// The Scanner drawer's glyphs (Tabler, MIT; outline 24 px), copied from the Scanner board. Kept here rather
// than in ui/Icon.tsx so the shared set only grows when a second feature needs one.
import type { SVGProps } from "react"

const PATHS = {
	eye: [
		"M10 12a2 2 0 1 0 4 0a2 2 0 0 0 -4 0",
		"M21 12c-2.4 4 -5.4 6 -9 6c-3.6 0 -6.6 -2 -9 -6c2.4 -4 5.4 -6 9 -6c3.6 0 6.6 2 9 6",
	],
	"eye-off": [
		"M10.585 10.587a2 2 0 0 0 2.829 2.828",
		"M16.681 16.673a8.717 8.717 0 0 1 -4.681 1.327c-3.6 0 -6.6 -2 -9 -6c1.272 -2.12 2.712 -3.678 4.32 -4.674m2.86 -1.146a9.055 9.055 0 0 1 1.82 -.18c3.6 0 6.6 2 9 6c-.666 1.11 -1.379 2.067 -2.138 2.87",
		"M3 3l18 18",
	],
	star: [
		"M12 17.75l-6.172 3.245l1.179 -6.873l-5 -4.867l6.9 -1l3.086 -6.253l3.086 6.253l6.9 1l-5 4.867l1.179 6.873z",
	],
	lock: ["M5 11h14v10h-14z", "M8 11v-4a4 4 0 1 1 8 0v4"],
	check: ["M5 12l5 5l10 -10"],
	sort: ["M4 6h9M4 12h7M4 18h7M15 15l3 3l3 -3M18 6v12"],
	bookmark: ["M18 7v14l-6 -4l-6 4v-14a4 4 0 0 1 4 -4h4a4 4 0 0 1 4 4z"],
	identify: [
		"M4 8v-2a2 2 0 0 1 2 -2h2M4 16v2a2 2 0 0 0 2 2h2M16 4h2a2 2 0 0 1 2 2v2M16 20h2a2 2 0 0 0 2 -2v-2M7 12h10",
	],
	headphones: [
		"M4 15a2 2 0 0 1 2 -2h1a2 2 0 0 1 2 2v3a2 2 0 0 1 -2 2h-1a2 2 0 0 1 -2 -2z",
		"M15 15a2 2 0 0 1 2 -2h1a2 2 0 0 1 2 2v3a2 2 0 0 1 -2 2h-1a2 2 0 0 1 -2 -2z",
		"M4 15v-3a8 8 0 0 1 16 0v3",
	],
	"chevron-up": ["M6 15l6 -6l6 6"],
	"chevron-down": ["M6 9l6 6l6 -6"],
	"chevron-left": ["M15 6l-6 6l6 6"],
	"chevron-right": ["M9 6l6 6l-6 6"],
	scanner: [
		"M21 12h-8a1 1 0 1 0 -1 1v8a9 9 0 0 0 9 -9",
		"M16 9a5 5 0 1 0 -7 7",
		"M20.486 9a9 9 0 1 0 -11.482 11.495",
	],
	wave: ["M3 12h2l2 -6l3 12l3 -9l2 3h6"],
	alert: [
		"M12 9v4",
		"M12 16h.01",
		"M10.363 3.591l-8.106 13.534a1.914 1.914 0 0 0 1.636 2.871h16.214a1.914 1.914 0 0 0 1.636 -2.87l-8.106 -13.536a1.914 1.914 0 0 0 -3.274 0z",
	],
	search: ["M3 10a7 7 0 1 0 14 0a7 7 0 1 0 -14 0", "M21 21l-6 -6"],
	close: ["M6 6l12 12M18 6l-12 12"],
} as const satisfies Record<string, readonly string[]>

export type ScanIconName = keyof typeof PATHS

export function ScanIcon({
	name,
	size = 16,
	filled,
	...rest
}: Omit<SVGProps<SVGSVGElement>, "children" | "viewBox"> & {
	name: ScanIconName
	size?: number
	/** Fill the shape with currentColor (a kept star, a saved bookmark). */
	filled?: boolean
}) {
	return (
		<svg
			viewBox="0 0 24 24"
			width={size}
			height={size}
			fill={filled ? "currentColor" : "none"}
			stroke="currentColor"
			strokeWidth={2}
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
			focusable="false"
			{...rest}
		>
			{PATHS[name].map(d => (
				<path key={d} d={d} />
			))}
		</svg>
	)
}

/** The ⋯ glyph (three filled dots). */
export function DotsIcon({ size = 18 }: { size?: number }) {
	return (
		<svg
			viewBox="0 0 24 24"
			width={size}
			height={size}
			fill="currentColor"
			aria-hidden="true"
			focusable="false"
		>
			<circle cx="5" cy="12" r="1.6" />
			<circle cx="12" cy="12" r="1.6" />
			<circle cx="19" cy="12" r="1.6" />
		</svg>
	)
}
