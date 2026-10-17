// Marker glyphs (the board's shapes): drawn once per theme into images MapLibre places on the GPU, and the same
// shapes as SVG paths for the legend.
import type { GlyphId } from "./items.ts"
import type { MapPalette } from "./palette.ts"

type Pt = readonly [number, number]

export const PLANE: readonly Pt[] = [
	[0, -9],
	[1.5, -3],
	[8, 1],
	[8, 3],
	[1.5, 1.5],
	[1, 6],
	[3.5, 8],
	[3.5, 9],
	[0, 8.2],
	[-3.5, 9],
	[-3.5, 8],
	[-1, 6],
	[-1.5, 1.5],
	[-8, 3],
	[-8, 1],
	[-1.5, -3],
]
export const HULL: readonly Pt[] = [
	[0, -8],
	[4, -2],
	[4, 7],
	[-4, 7],
	[-4, -2],
]
const DIAMOND: readonly Pt[] = [
	[0, -5],
	[5, 0],
	[0, 5],
	[-5, 0],
]
const HEX: readonly Pt[] = Array.from(
	{ length: 6 },
	(_, k): Pt => [
		5 * Math.cos((Math.PI / 3) * k),
		5 * Math.sin((Math.PI / 3) * k),
	],
)

export const svgPath = (pts: readonly Pt[]) =>
	`M${pts.map(p => `${p[0].toFixed(2)} ${p[1].toFixed(2)}`).join("L")}Z`

export interface LegendEntry {
	readonly label: string
	readonly d: string
	readonly fill: string
	readonly stroke: string
}

const dot = (r: number) =>
	`M${-r} 0a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`

/** The legend: one swatch per glyph (aircraft in the middle altitude step; the ramp sits under it). */
export function legend(pal: MapPalette): LegendEntry[] {
	const d = pal.data
	return [
		{
			label: "Aircraft",
			d: svgPath(PLANE),
			fill: pal.alt[2] ?? d.aprs,
			stroke: "none",
		},
		{ label: "Vessel", d: svgPath(HULL), fill: d.vessel, stroke: "none" },
		{ label: "Moored", d: dot(4), fill: d.vessel, stroke: "none" },
		{
			label: "Aid to navigation",
			d: svgPath(DIAMOND),
			fill: "none",
			stroke: d.vessel,
		},
		{ label: "APRS station", d: dot(4.5), fill: d.aprs, stroke: "none" },
		{ label: "Weather", d: "M-4.5 -4.5h9v9h-9Z", fill: "none", stroke: d.aprs },
		{ label: "Mesh node", d: svgPath(HEX), fill: d.mesh, stroke: "none" },
	]
}

export const GLYPH_IDS: readonly GlyphId[] = [
	"plane-0",
	"plane-1",
	"plane-2",
	"plane-3",
	"plane-4",
	"hull",
	"moored",
	"aton",
	"aprs",
	"wx",
	"mesh",
]

/** CSS px of the square each glyph is drawn in. */
const SIZE = 24

export interface GlyphImage {
	readonly width: number
	readonly height: number
	readonly data: Uint8ClampedArray
}

/** A 2D context to draw into; the default is one CPU-backed canvas (read back once per glyph, so no GPU readback). */
export type MakeContext = (
	w: number,
	h: number,
) => CanvasRenderingContext2D | null

const defaultContext: MakeContext = (w, h) => {
	const c = document.createElement("canvas")
	c.width = w
	c.height = h
	return c.getContext("2d", { willReadFrequently: true })
}

/** Draws every glyph for a palette; `ratio` is the device pixel ratio (images are SIZE·ratio square). */
export function drawGlyphs(
	pal: MapPalette,
	ratio: number,
	makeContext: MakeContext = defaultContext,
): Map<GlyphId, GlyphImage> {
	const px = Math.round(SIZE * ratio)
	const out = new Map<GlyphId, GlyphImage>()
	const g = makeContext(px, px)
	if (!g) return out
	for (const id of GLYPH_IDS) {
		g.setTransform(1, 0, 0, 1, 0, 0)
		g.clearRect(0, 0, px, px)
		g.setTransform(ratio, 0, 0, ratio, (SIZE / 2) * ratio, (SIZE / 2) * ratio)
		g.lineJoin = "round"
		const poly = (pts: readonly Pt[]) => {
			g.beginPath()
			pts.forEach((p, i) => (i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1])))
			g.closePath()
		}
		const fillStroke = (
			fill: string | null,
			stroke: string | null,
			w = 1.2,
		) => {
			if (fill) {
				g.fillStyle = fill
				g.fill()
			}
			if (stroke) {
				g.strokeStyle = stroke
				g.lineWidth = w
				g.stroke()
			}
		}
		const circle = (r: number) => {
			g.beginPath()
			g.arc(0, 0, r, 0, Math.PI * 2)
		}
		if (id.startsWith("plane-")) {
			poly(PLANE)
			// outline first so the fill keeps its full shape
			fillStroke(null, pal.outline, 2.4)
			fillStroke(pal.alt[Number(id.slice(6))] ?? pal.data.aprs, null)
		} else if (id === "hull") {
			poly(HULL)
			fillStroke(null, pal.outline, 2.4)
			fillStroke(pal.data.vessel, null)
		} else if (id === "moored") {
			circle(4)
			fillStroke(pal.data.vessel, pal.outline, 1)
		} else if (id === "aton") {
			poly(DIAMOND)
			fillStroke(null, pal.outline, 3)
			fillStroke(null, pal.data.vessel, 1.4)
		} else if (id === "aprs") {
			circle(4.5)
			fillStroke(pal.data.aprs, pal.outline, 1)
			circle(1.6)
			fillStroke(pal.hole, null)
		} else if (id === "wx") {
			g.beginPath()
			g.rect(-4.5, -4.5, 9, 9)
			fillStroke(null, pal.outline, 3)
			fillStroke(null, pal.data.aprs, 1.4)
		} else if (id === "mesh") {
			poly(HEX)
			fillStroke(pal.data.mesh, pal.outline, 1)
		}
		const img = g.getImageData(0, 0, px, px)
		out.set(id, { width: px, height: px, data: img.data })
	}
	return out
}
