// The Map view's UI state: shown layers and overlays (remembered on this device), the overlays menu, selection,
// follow, hover and the cluster chooser. Plain data so it tests in node.
import { Store } from "../../data/store.ts"
import type { LayerId } from "./items.ts"

export type OverlayId = "rings" | "coverage" | "trails" | "labels" | "links"

export const OVERLAY_IDS: readonly OverlayId[] = [
	"rings",
	"coverage",
	"trails",
	"labels",
	"links",
]

export interface MapUiState {
	readonly layers: Readonly<Record<LayerId, boolean>>
	readonly overlays: Readonly<Record<OverlayId, boolean>>
	readonly overlaysOpen: boolean
	readonly selected: string | null
	readonly follow: boolean
	/** Hovered item at its screen position, with how many more are within reach. */
	readonly hover: {
		readonly id: string
		readonly x: number
		readonly y: number
		readonly more: number
	} | null
	/** A click on a dense spot: up to six items to choose from, and how many were there. */
	readonly chooser: {
		readonly x: number
		readonly y: number
		readonly ids: readonly string[]
		readonly count: number
	} | null
}

const STORAGE_KEY = "wavekit.web.map"

const DEFAULT_LAYERS: Record<LayerId, boolean> = {
	aircraft: true,
	vessels: true,
	aprs: true,
	mesh: true,
}
const DEFAULT_OVERLAYS: Record<OverlayId, boolean> = {
	rings: true,
	coverage: true,
	trails: true,
	labels: true,
	links: true,
}

function boolRecord<K extends string>(
	keys: readonly K[],
	raw: unknown,
	fallback: Record<K, boolean>,
): Record<K, boolean> {
	const out = { ...fallback }
	if (typeof raw !== "object" || raw === null) return out
	const r = raw as Record<string, unknown>
	for (const k of keys) {
		const v = r[k]
		if (typeof v === "boolean") out[k] = v
	}
	return out
}

/** Stored layers and overlays; anything missing or unreadable falls back to all on. */
export function parseStored(
	raw: string | null,
): Pick<MapUiState, "layers" | "overlays"> {
	let data: unknown = null
	try {
		data = raw ? (JSON.parse(raw) as unknown) : null
	} catch {
		data = null
	}
	const r =
		typeof data === "object" && data !== null
			? (data as Record<string, unknown>)
			: {}
	return {
		layers: boolRecord(
			["aircraft", "vessels", "aprs", "mesh"],
			r["layers"],
			DEFAULT_LAYERS,
		),
		overlays: boolRecord(OVERLAY_IDS, r["overlays"], DEFAULT_OVERLAYS),
	}
}

function readStorage(): string | null {
	try {
		return typeof window === "undefined"
			? null
			: window.localStorage.getItem(STORAGE_KEY)
	} catch {
		return null
	}
}

function writeStorage(s: MapUiState): void {
	try {
		window.localStorage.setItem(
			STORAGE_KEY,
			JSON.stringify({ layers: s.layers, overlays: s.overlays }),
		)
	} catch {
		// private mode or blocked storage: the choice lasts for this page only
	}
}

export class MapUi extends Store<MapUiState> {
	private readonly persist: boolean

	constructor(stored: string | null = readStorage(), persist = true) {
		super({
			...parseStored(stored),
			overlaysOpen: false,
			selected: null,
			follow: false,
			hover: null,
			chooser: null,
		})
		this.persist = persist
	}

	toggleLayer(id: LayerId): void {
		this.update(s => {
			const layers = { ...s.layers, [id]: !s.layers[id] }
			return { ...s, layers }
		})
		this.save()
	}

	toggleOverlay(id: OverlayId): void {
		this.update(s => ({
			...s,
			overlays: { ...s.overlays, [id]: !s.overlays[id] },
		}))
		this.save()
	}

	setOverlaysOpen(open: boolean): void {
		this.update(s =>
			s.overlaysOpen === open ? s : { ...s, overlaysOpen: open, chooser: null },
		)
	}

	select(id: string | null): void {
		this.update(s =>
			s.selected === id && s.chooser === null
				? s
				: {
						...s,
						selected: id,
						follow: false,
						chooser: null,
						overlaysOpen: id ? false : s.overlaysOpen,
					},
		)
	}

	setFollow(follow: boolean): void {
		this.update(s =>
			s.follow === follow || (follow && !s.selected) ? s : { ...s, follow },
		)
	}

	setHover(hover: MapUiState["hover"]): void {
		this.update(s => {
			const h = s.hover
			if (h === hover) return s
			if (
				h &&
				hover &&
				h.id === hover.id &&
				h.more === hover.more &&
				h.x === hover.x &&
				h.y === hover.y
			)
				return s
			return { ...s, hover }
		})
	}

	openChooser(chooser: NonNullable<MapUiState["chooser"]>): void {
		this.update(s => ({ ...s, chooser, hover: null }))
	}

	/** Escape inside the map: chooser, then the overlays menu, then the selection. False when nothing was open. */
	escape(): boolean {
		const s = this.get()
		if (s.chooser) this.update(x => ({ ...x, chooser: null }))
		else if (s.overlaysOpen) this.update(x => ({ ...x, overlaysOpen: false }))
		else if (s.selected)
			this.update(x => ({ ...x, selected: null, follow: false }))
		else return false
		return true
	}

	/** A click on empty map: closes the chooser, the menu and the selection. */
	clearAll(): void {
		this.update(s =>
			s.chooser || s.overlaysOpen || s.selected
				? {
						...s,
						chooser: null,
						overlaysOpen: false,
						selected: null,
						follow: false,
					}
				: s,
		)
	}

	private save(): void {
		if (this.persist) writeStorage(this.get())
	}
}
