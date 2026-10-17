import type { SVGProps } from "react"

// Interface glyphs (Tabler, MIT; outline 24 px), copied from the Immersive board. @wavekit/brand/react only ships the
// decoder category icons (WaveKitIcon), so the shell's nav and control glyphs live here until the brand kit has them.
const PATHS = {
	spectrum: [
		"M3 7c3 0 1.5 10 4.5 10s1.5 -7 4.5 -7s1.5 7 4.5 7s1.5 -10 4.5 -10",
	],
	map: ["M3 7l6 -3l6 3l6 -3v13l-6 3l-6 -3l-6 3v-13", "M9 4v13", "M15 7v13"],
	activity: ["M3 12h4l3 8l4 -16l3 8h4"],
	scanner: [
		"M21 12h-8a1 1 0 1 0 -1 1v8a9 9 0 0 0 9 -9",
		"M16 9a5 5 0 1 0 -7 7",
		"M20.486 9a9 9 0 1 0 -11.482 11.495",
	],
	recordings: [
		"M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0",
		"M9 12a3 3 0 1 0 6 0a3 3 0 1 0 -6 0",
	],
	search: ["M3 10a7 7 0 1 0 14 0a7 7 0 1 0 -14 0", "M21 21l-6 -6"],
	settings: [
		"M10.325 4.317c.426 -1.756 2.924 -1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543 -.94 3.31 .826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756 .426 1.756 2.924 0 3.35a1.724 1.724 0 0 0 -1.066 2.573c.94 1.543 -.826 3.31 -2.37 2.37a1.724 1.724 0 0 0 -2.572 1.065c-.426 1.756 -2.924 1.756 -3.35 0a1.724 1.724 0 0 0 -2.573 -1.066c-1.543 .94 -3.31 -.826 -2.37 -2.37a1.724 1.724 0 0 0 -1.065 -2.572c-1.756 -.426 -1.756 -2.924 0 -3.35a1.724 1.724 0 0 0 1.066 -2.573c-.94 -1.543 .826 -3.31 2.37 -2.37c1 .608 2.296 .07 2.572 -1.065z",
		"M9 12a3 3 0 1 0 6 0a3 3 0 0 0 -6 0",
	],
	close: ["M6 6l12 12M18 6l-12 12"],
	"chevron-down": ["M6 9l6 6l6 -6"],
	"chevron-up": ["M6 15l6 -6l6 6"],
	keyboard: [
		"M2 8a2 2 0 0 1 2 -2h16a2 2 0 0 1 2 2v8a2 2 0 0 1 -2 2h-16a2 2 0 0 1 -2 -2z",
		"M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10",
	],
	headphones: [
		"M4 15a2 2 0 0 1 2 -2h1a2 2 0 0 1 2 2v3a2 2 0 0 1 -2 2h-1a2 2 0 0 1 -2 -2z",
		"M15 15a2 2 0 0 1 2 -2h1a2 2 0 0 1 2 2v3a2 2 0 0 1 -2 2h-1a2 2 0 0 1 -2 -2z",
		"M4 15v-3a8 8 0 0 1 16 0v3",
	],
	play: ["M7 4v16l13 -8z"],
	bookmark: ["M18 7v14l-6 -4l-6 4v-14a4 4 0 0 1 4 -4h4a4 4 0 0 1 4 4z"],
	pin: [
		"M15 4.5l-4 4l-4 1.5l-1.5 1.5l7 7l1.5 -1.5l1.5 -4l4 -4",
		"M9 15l-4.5 4.5",
		"M14.5 4l5.5 5.5",
	],
	dots: [
		"M4 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0",
		"M11 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0",
		"M18 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0",
	],
	copy: [
		"M8 10a2 2 0 0 1 2 -2h8a2 2 0 0 1 2 2v8a2 2 0 0 1 -2 2h-8a2 2 0 0 1 -2 -2z",
		"M16 8v-2a2 2 0 0 0 -2 -2h-8a2 2 0 0 0 -2 2v8a2 2 0 0 0 2 2h2",
	],
	lock: [
		"M5 13a2 2 0 0 1 2 -2h10a2 2 0 0 1 2 2v6a2 2 0 0 1 -2 2h-10a2 2 0 0 1 -2 -2z",
		"M8 11v-4a4 4 0 1 1 8 0v4",
	],
	tune: ["M5 12h14", "M13 18l6 -6", "M13 6l6 6"],
	columns: ["M4 4h16v16h-16z", "M9.33 4v16", "M14.67 4v16"],
	grip: [
		"M9 6m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0",
		"M9 12m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0",
		"M9 18m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0",
		"M15 6m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0",
		"M15 12m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0",
		"M15 18m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0",
	],
	"chevron-left": ["M15 6l-6 6l6 6"],
	"chevron-right": ["M9 6l6 6l-6 6"],
} as const satisfies Record<string, readonly string[]>

export type IconName = keyof typeof PATHS

export interface IconProps extends Omit<
	SVGProps<SVGSVGElement>,
	"children" | "viewBox"
> {
	name: IconName
	/** Pixel size; omit inside recipes that size their `> svg` (buttons, chips, tiles). */
	size?: number
}

/** A decorative outline glyph (`aria-hidden`); the control that holds it carries the name. */
export function Icon({ name, size, ...rest }: IconProps) {
	return (
		<svg
			{...rest}
			viewBox="0 0 24 24"
			width={size}
			height={size}
			fill="none"
			stroke="currentColor"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
			focusable="false"
		>
			{PATHS[name].map(d => (
				<path key={d} d={d} />
			))}
		</svg>
	)
}

/**
 * The WaveKit mark, as the Tuner board draws it. Same path as WaveKitMark in @wavekit/brand/react, which the web
 * bundle cannot import yet: brand resolves its own React 18 copy (needs `resolve.dedupe` in web/vite.config.ts).
 */
export function Mark({
	size = 24,
	label = "WaveKit",
	...rest
}: Omit<SVGProps<SVGSVGElement>, "children" | "viewBox"> & {
	size?: number
	label?: string
}) {
	return (
		<svg
			{...rest}
			viewBox="0 0 256 256"
			width={size}
			height={size}
			fill="none"
			role="img"
			aria-label={label}
			focusable="false"
		>
			<path
				d="M28 68C72 68 34 188 78 188C112 188 94 104 128 104C162 104 144 188 178 188C222 188 184 68 228 68"
				stroke="currentColor"
				strokeWidth={26}
				strokeLinejoin="round"
			/>
		</svg>
	)
}
