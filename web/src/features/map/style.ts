// The Map's own minimal MapLibre style (docs/web/DESIGN.md, "Map: decisions before design": ink land, darker sea,
// thin coastline in the hairline tint, faint graticule, few labels; Paper is a nautical chart) and the basemap
// source. The basemap is one config point: OpenFreeMap's vector tiles (OpenMapTiles schema) online, until core
// serves a regional PMTiles extract with its glyphs (docs/web/CORE-GAPS.md, Map tiles).
import type {
	ExpressionSpecification,
	LayerSpecification,
	StyleSpecification,
} from "maplibre-gl"

import type { MapPalette } from "./palette.ts"

export interface Basemap {
	/** What the footer says while it loads. */
	readonly label: string
	/** TileJSON of an OpenMapTiles-schema vector source. */
	readonly tileJson: string
	readonly glyphs: string
	readonly font: string
	readonly attribution: readonly {
		readonly text: string
		readonly href: string
	}[]
}

/** The only place the tile source is named. */
export const BASEMAP: Basemap = {
	label: "Online map (OpenFreeMap)",
	tileJson: "https://tiles.openfreemap.org/planet",
	glyphs: "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf",
	font: "Noto Sans Regular",
	attribution: [
		{ text: "OpenFreeMap", href: "https://openfreemap.org" },
		{ text: "© OpenMapTiles", href: "https://www.openmaptiles.org/" },
		{
			text: "© OpenStreetMap",
			href: "https://www.openstreetmap.org/copyright",
		},
	],
}

/** Source ids: the basemap and the GeoJSON sources the Map feeds. */
export const SRC = {
	base: "base",
	grid: "wk-grid",
	coverage: "wk-coverage",
	rings: "wk-rings",
	approx: "wk-approx",
	links: "wk-links",
	trails: "wk-trails",
	items: "wk-items",
} as const

export const LAYER = {
	bg: "wk-bg",
	water: "wk-water",
	shallow: "wk-shallow",
	coastHalo: "wk-coast-halo",
	coast: "wk-coast",
	grid: "wk-grid",
	covFill: "wk-cov-fill",
	covLine: "wk-cov-line",
	rings: "wk-rings",
	approxFill: "wk-approx-fill",
	approxLine: "wk-approx-line",
	places: "wk-places",
	links: "wk-links",
	trails: "wk-trails",
	items: "wk-items",
} as const

const EMPTY = { type: "FeatureCollection", features: [] } as const

/** Graticule steps by zoom (MapLibre zoom), like the board's 2° / 1° / 0.25° / 0.1°. */
export const GRID_STEPS: readonly {
	step: number
	minzoom: number
	maxzoom: number
}[] = [
	{ step: 2, minzoom: 0, maxzoom: 6 },
	{ step: 1, minzoom: 6, maxzoom: 8 },
	{ step: 0.25, minzoom: 8, maxzoom: 10 },
	{ step: 0.1, minzoom: 10, maxzoom: 24 },
]

const zoomed = (base: number): ExpressionSpecification => [
	"interpolate",
	["linear"],
	["zoom"],
	5,
	base * 0.6,
	9,
	base,
	13,
	base * 1.4,
]

/** Paint values that follow the theme (applied again on a theme change). */
export function themedPaint(
	pal: MapPalette,
	basemapUp: boolean,
): readonly [layer: string, prop: string, value: unknown][] {
	return [
		[LAYER.bg, "background-color", basemapUp ? pal.land : pal.sea],
		[LAYER.water, "fill-color", pal.sea],
		[LAYER.shallow, "line-color", pal.shallow ?? "rgba(0,0,0,0)"],
		[LAYER.coastHalo, "line-color", pal.coastHalo ?? "rgba(0,0,0,0)"],
		[LAYER.coast, "line-color", pal.coast],
		[LAYER.coast, "line-width", pal.coastW],
		[LAYER.grid, "line-color", pal.grid],
		[
			LAYER.covFill,
			"fill-color",
			["match", ["get", "p"], "adsb", pal.covAdsb.fill, pal.covAis.fill],
		],
		[
			LAYER.covLine,
			"line-color",
			["match", ["get", "p"], "adsb", pal.covAdsb.line, pal.covAis.line],
		],
		[LAYER.rings, "line-color", pal.ring],
		[LAYER.approxFill, "fill-color", pal.apxFill],
		[LAYER.approxLine, "line-color", pal.apxRing],
		[LAYER.places, "text-color", pal.place],
		[LAYER.places, "text-halo-color", pal.placeHalo],
		[
			LAYER.links,
			"line-color",
			["case", [">", ["get", "snr"], 5], pal.linkHi, pal.linkLo],
		],
	]
}

export function buildStyle(
	pal: MapPalette,
	basemap: Basemap = BASEMAP,
): StyleSpecification {
	const layers: LayerSpecification[] = [
		{
			id: LAYER.bg,
			type: "background",
			paint: { "background-color": pal.sea },
		},
		{
			id: LAYER.water,
			type: "fill",
			source: SRC.base,
			"source-layer": "water",
			paint: { "fill-color": pal.sea, "fill-antialias": true },
		},
		{
			// Paper: the chart's shallow-water band, a wide stroke offset into the water
			id: LAYER.shallow,
			type: "line",
			source: SRC.base,
			"source-layer": "water",
			minzoom: 6,
			paint: {
				"line-color": pal.shallow ?? "rgba(0,0,0,0)",
				"line-width": zoomed(14),
				"line-offset": zoomed(7),
				"line-blur": 2,
			},
		},
		{
			id: LAYER.coastHalo,
			type: "line",
			source: SRC.base,
			"source-layer": "water",
			paint: {
				"line-color": pal.coastHalo ?? "rgba(0,0,0,0)",
				"line-width": 5,
			},
		},
		{
			id: LAYER.coast,
			type: "line",
			source: SRC.base,
			"source-layer": "water",
			layout: { "line-join": "round" },
			paint: { "line-color": pal.coast, "line-width": pal.coastW },
		},
		...GRID_STEPS.map(
			(g, i): LayerSpecification => ({
				id: i === 0 ? LAYER.grid : `${LAYER.grid}-${i}`,
				type: "line",
				source: SRC.grid,
				minzoom: g.minzoom,
				maxzoom: g.maxzoom,
				filter: ["==", ["get", "s"], g.step],
				paint: { "line-color": pal.grid, "line-width": 1 },
			}),
		),
		{
			id: LAYER.covFill,
			type: "fill",
			source: SRC.coverage,
			paint: {
				"fill-color": [
					"match",
					["get", "p"],
					"adsb",
					pal.covAdsb.fill,
					pal.covAis.fill,
				],
			},
		},
		{
			id: LAYER.covLine,
			type: "line",
			source: SRC.coverage,
			paint: {
				"line-color": [
					"match",
					["get", "p"],
					"adsb",
					pal.covAdsb.line,
					pal.covAis.line,
				],
				"line-width": 1,
			},
		},
		{
			id: LAYER.rings,
			type: "line",
			source: SRC.rings,
			paint: {
				"line-color": pal.ring,
				"line-width": 1,
				"line-dasharray": [3, 6],
			},
		},
		{
			id: LAYER.approxFill,
			type: "fill",
			source: SRC.approx,
			paint: { "fill-color": pal.apxFill },
		},
		{
			id: LAYER.approxLine,
			type: "line",
			source: SRC.approx,
			paint: {
				"line-color": pal.apxRing,
				"line-width": 1,
				"line-dasharray": [4, 4],
			},
		},
		{
			// few labels: cities from z6, towns from z8, villages from z10.5
			id: LAYER.places,
			type: "symbol",
			source: SRC.base,
			"source-layer": "place",
			filter: [
				"any",
				["all", ["==", ["get", "class"], "city"], [">=", ["zoom"], 5.5]],
				["all", ["==", ["get", "class"], "town"], [">=", ["zoom"], 8]],
				["all", ["==", ["get", "class"], "village"], [">=", ["zoom"], 10.5]],
			],
			layout: {
				"text-field": ["coalesce", ["get", "name:latin"], ["get", "name"]],
				"text-font": [basemap.font],
				"text-size": 11.5,
				"text-anchor": "left",
				"text-offset": [0.5, 0],
				"text-max-width": 10,
				"symbol-sort-key": ["coalesce", ["get", "rank"], 10],
			},
			paint: {
				"text-color": pal.place,
				"text-halo-color": pal.placeHalo,
				"text-halo-width": 1.5,
			},
		},
		{
			id: LAYER.links,
			type: "line",
			source: SRC.links,
			paint: {
				"line-color": [
					"case",
					[">", ["get", "snr"], 5],
					pal.linkHi,
					pal.linkLo,
				],
				"line-width": 1,
				"line-dasharray": [3, 3],
			},
		},
		{
			id: LAYER.trails,
			type: "line",
			source: SRC.trails,
			layout: { "line-cap": "round", "line-join": "round" },
			paint: {
				"line-color": ["get", "c"],
				"line-opacity": ["get", "a"],
				"line-width": 1.5,
			},
		},
		{
			id: LAYER.items,
			type: "symbol",
			source: SRC.items,
			layout: {
				"icon-image": ["get", "g"],
				"icon-rotate": ["get", "r"],
				"icon-rotation-alignment": "map",
				"icon-allow-overlap": true,
				"icon-ignore-placement": true,
				"symbol-sort-key": ["get", "z"],
			},
		},
	]
	return {
		version: 8,
		glyphs: basemap.glyphs,
		sources: {
			[SRC.base]: { type: "vector", url: basemap.tileJson },
			[SRC.grid]: { type: "geojson", data: EMPTY },
			[SRC.coverage]: { type: "geojson", data: EMPTY },
			[SRC.rings]: { type: "geojson", data: EMPTY },
			[SRC.approx]: { type: "geojson", data: EMPTY },
			[SRC.links]: { type: "geojson", data: EMPTY },
			[SRC.trails]: { type: "geojson", data: EMPTY },
			[SRC.items]: { type: "geojson", data: EMPTY },
		},
		layers,
	}
}
