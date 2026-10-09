// Tabler MIT + custom extensions: see ../licenses/NOTICES.md.
export type IconNode = readonly [
	"path" | "circle" | "rect",
	Readonly<Record<string, string>>,
]
export const iconNodes = {
	aircraft: {
		base: [
			[
				"path",
				{
					d: "M16 10h4a2 2 0 0 1 0 4h-4l-4 7h-3l2 -7h-4l-2 2h-3l2 -4l-2 -4h3l2 2h4l-2 -7h3l4 7",
					transform: "rotate(-90 12 12)",
				},
			],
		],
		accent: [],
	},
	marine: {
		base: [
			[
				"path",
				{
					d: "M4 18l-1 -5h18l-2 4M5 13v-6h8l4 6M7 7v-4h-1",
				},
			],
		],
		accent: [
			[
				"path",
				{
					d: "M2 20a2.4 2.4 0 0 0 2 1a2.4 2.4 0 0 0 2 -1a2.4 2.4 0 0 1 2 -1a2.4 2.4 0 0 1 2 1a2.4 2.4 0 0 0 2 1a2.4 2.4 0 0 0 2 -1a2.4 2.4 0 0 1 2 -1a2.4 2.4 0 0 1 2 1a2.4 2.4 0 0 0 2 1a2.4 2.4 0 0 0 2 -1",
				},
			],
		],
	},
	"aviation-data": {
		base: [
			[
				"path",
				{
					d: "M3 8.5h12a2 2 0 0 1 2 2v6a2 2 0 0 1 -2 2H8l-4 3v-3H3a2 2 0 0 1 -2 -2v-6a2 2 0 0 1 2 -2Z",
					transform: "translate(1 0)",
				},
			],
			[
				"path",
				{
					d: "M6 11.5h6M6 14.5h3",
				},
			],
		],
		accent: [
			[
				"path",
				{
					d: "M17 3a5 5 0 0 1 5 5M17 6a2 2 0 0 1 2 2",
				},
			],
		],
	},
	voice: {
		base: [
			[
				"path",
				{
					d: "M9 5a3 3 0 0 1 3 -3a3 3 0 0 1 3 3v5a3 3 0 0 1 -3 3a3 3 0 0 1 -3 -3V5M8 21h8M12 17v4",
				},
			],
		],
		accent: [
			[
				"path",
				{
					d: "M5 10a7 7 0 0 0 14 0",
				},
			],
		],
	},
	paging: {
		base: [
			[
				"rect",
				{
					x: "2",
					y: "5",
					width: "20",
					height: "14",
					rx: "3",
				},
			],
			[
				"path",
				{
					d: "M6 16h2M12 16h.01M16 16h.01",
				},
			],
		],
		accent: [
			[
				"rect",
				{
					x: "6",
					y: "8",
					width: "12",
					height: "5",
					rx: "1",
				},
			],
		],
	},
	aprs: {
		base: [
			[
				"path",
				{
					d: "M17.657 16.657l-4.243 4.243a2 2 0 0 1 -2.827 0l-4.244 -4.243a8 8 0 1 1 11.314 0",
				},
			],
		],
		accent: [
			[
				"path",
				{
					d: "M9 11a3 3 0 1 0 6 0a3 3 0 0 0 -6 0",
				},
			],
		],
	},
	sensors: {
		base: [
			[
				"path",
				{
					d: "M12 12v.01M14.828 9.172a4 4 0 0 1 0 5.656M9.168 14.828a4 4 0 0 1 0 -5.656",
				},
			],
		],
		accent: [
			[
				"path",
				{
					d: "M17.657 6.343a8 8 0 0 1 0 11.314M6.337 17.657a8 8 0 0 1 0 -11.314",
				},
			],
		],
	},
	mesh: {
		base: [
			[
				"path",
				{
					d: "m10.82 7.2 -5.14 9.6M13.18 7.2l5.14 9.6M7 19h10",
				},
			],
		],
		accent: [
			[
				"circle",
				{
					cx: "12",
					cy: "5",
					r: "2.5",
				},
			],
			[
				"circle",
				{
					cx: "4.5",
					cy: "19",
					r: "2.5",
				},
			],
			[
				"circle",
				{
					cx: "19.5",
					cy: "19",
					r: "2.5",
				},
			],
		],
	},
} as const satisfies Record<
	string,
	{ readonly base: readonly IconNode[]; readonly accent: readonly IconNode[] }
>
export type CategoryName = keyof typeof iconNodes
