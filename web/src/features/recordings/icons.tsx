// The Recordings drawer's glyphs (Tabler, MIT; outline 24 px), from the Recordings board.
import type { SVGProps } from "react"

const PATHS = {
	voice: [
		"M9 5a3 3 0 0 1 3 -3a3 3 0 0 1 3 3v5a3 3 0 0 1 -3 3a3 3 0 0 1 -3 -3V5M8 21h8M12 17v4",
		"M5 10a7 7 0 0 0 14 0",
	],
	scan: [
		"M21 12h-8a1 1 0 1 0 -1 1v8a9 9 0 0 0 9 -9",
		"M16 9a5 5 0 1 0 -7 7",
		"M20.486 9a9 9 0 1 0 -11.482 11.495",
	],
	star: [
		"M12 17.75l-6.172 3.245l1.179 -6.873l-5 -4.867l6.9 -1l3.086 -6.253l3.086 6.253l6.9 1l-5 4.867l1.179 6.873z",
	],
	download: [
		"M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2 -2v-2",
		"M7 11l5 5l5 -5",
		"M12 4v12",
	],
	tune: ["M3 7c3 0 1.5 10 4.5 10s1.5 -7 4.5 -7s1.5 7 4.5 7s1.5 -10 4.5 -10"],
	activity: ["M3 12h4l3 8l4 -16l3 8h4"],
	trash: [
		"M4 7h16",
		"M10 11v6",
		"M14 11v6",
		"M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2 -2l1 -12",
		"M9 7v-3a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v3",
	],
	lock: ["M5 11h14v10h-14z", "M8 11v-4a4 4 0 1 1 8 0v4"],
	prev: ["M20 5v14l-12 -7z", "M4 5v14"],
	next: ["M4 5v14l12 -7z", "M20 5v14"],
	close: ["M6 6l12 12M18 6l-12 12"],
	"chevron-up": ["M6 15l6 -6l6 6"],
	refresh: [
		"M20 11a8.1 8.1 0 0 0 -15.5 -2m-.5 -4v4h4",
		"M4 13a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4",
	],
} as const satisfies Record<string, readonly string[]>

export type RecIconName = keyof typeof PATHS

export function RecIcon({
	name,
	size = 16,
	filled,
	...rest
}: Omit<SVGProps<SVGSVGElement>, "children" | "viewBox"> & {
	name: RecIconName
	size?: number
	/** Fill the shape with currentColor (a kept star). */
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

export function PlayGlyph({
	playing,
	size = 12,
}: {
	playing: boolean
	size?: number
}) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 24 24"
			aria-hidden="true"
			focusable="false"
		>
			{playing ? (
				<>
					<rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor" />
					<rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor" />
				</>
			) : (
				<path d="M8 5v14l11 -7z" fill="currentColor" />
			)}
		</svg>
	)
}
