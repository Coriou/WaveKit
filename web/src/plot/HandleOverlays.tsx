// Drawn handles of the plot (docs/web/canvas/Spectrum.dc.html): the passband's edges and the dashed squelch
// line. Pointer input is geometric (use-handles.ts), so these never take the pointer; each is a focusable
// slider for the keyboard (arrows, PageUp/PageDown).
import type { KeyboardEvent } from "react"

import type { LiveAudioStore } from "../data/live-audio-store.ts"
import { useStore } from "../data/index.ts"
import type { SpectrumLevels, SpectrumViewSpan } from "../spectrum/index.ts"
import { type HandleController, squelchLineDbfs } from "./handle-controller.ts"
import {
	type BandwidthRange,
	SQUELCH_MAX_DBFS,
	SQUELCH_MIN_DBFS,
	handleGeometry,
	handleKey,
	nudgeBandwidth,
	nudgeSquelch,
} from "./handles.ts"

function formatDb(db: number): string {
	return String(Math.round(db)).replace("-", "−")
}

function formatKHz(hz: number): string {
	return `${(hz / 1000).toFixed(hz % 1000 === 0 ? 0 : 1)} kHz`
}

/** The passband's two edges, inside `.wk-plot-vfo`; only drawn once they can be grabbed. */
export function VfoEdges({
	handles,
	bandwidthHz,
	range,
	readOnly,
}: {
	handles: HandleController
	bandwidthHz: number
	range: BandwidthRange
	readOnly: boolean
}) {
	const onKeyDown = (e: KeyboardEvent) => {
		const k = handleKey(e.key)
		if (!k || readOnly) return
		e.preventDefault()
		handles.setBandwidth(nudgeBandwidth(bandwidthHz, k.dir, range, k.big))
	}
	return (
		<>
			<span className="wk-plot-vfo-edge" data-side="left" aria-hidden="true" />
			<span
				className="wk-plot-vfo-edge"
				data-side="right"
				role="slider"
				tabIndex={readOnly ? -1 : 0}
				aria-label="Channel bandwidth"
				aria-valuemin={range[0]}
				aria-valuemax={range[1]}
				aria-valuenow={bandwidthHz}
				aria-valuetext={formatKHz(bandwidthHz)}
				aria-readonly={readOnly || undefined}
				onKeyDown={onKeyDown}
			/>
		</>
	)
}

/**
 * The squelch threshold as a dashed line across the passband (at least 180 px), on the plot's dB scale.
 * Subscribes to the live-audio store itself, so level events redraw only this line, and only when the
 * threshold moves by half a dB.
 */
export function SquelchLine({
	liveAudio,
	handles,
	preview,
	view,
	widthPx,
	traceCss,
	levels,
	vfoHz,
	bandwidthHz,
	readOnly,
}: {
	liveAudio: LiveAudioStore
	handles: HandleController
	/** A value being dragged or keyed in, shown until written. */
	preview: number | null
	view: SpectrumViewSpan
	widthPx: number
	traceCss: number
	levels: SpectrumLevels
	vfoHz: number | null
	bandwidthHz: number
	readOnly: boolean
}) {
	const threshold = useStore(liveAudio, squelchLineDbfs)
	const auto = useStore(liveAudio, s => s.status?.config.squelchMode === "auto")
	const db = preview ?? threshold
	const line = handleGeometry({
		view,
		widthPx,
		traceCss,
		levels,
		vfoHz,
		bandwidthHz,
		edgesAllowed: false,
		vfoAllowed: false,
		squelchDbfs: db,
	}).squelch
	if (!line || db === null) return null
	const isAuto = auto && preview === null
	const onKeyDown = (e: KeyboardEvent) => {
		const k = handleKey(e.key)
		if (!k || readOnly) return
		e.preventDefault()
		handles.setSquelch(nudgeSquelch(db, k.dir, k.big))
	}
	return (
		<div
			className="wk-plot-sq"
			data-auto={isAuto ? "" : undefined}
			role="slider"
			tabIndex={readOnly ? -1 : 0}
			aria-label="Squelch threshold"
			aria-valuemin={SQUELCH_MIN_DBFS}
			aria-valuemax={SQUELCH_MAX_DBFS}
			aria-valuenow={Math.round(db)}
			aria-valuetext={`${isAuto ? "Auto · " : ""}${formatDb(db)} dBFS`}
			aria-readonly={readOnly || undefined}
			title={
				readOnly
					? undefined
					: isAuto
						? "Auto squelch: drag to set it by hand"
						: "Drag to set the squelch"
			}
			style={{ top: line.y, left: line.left, width: line.right - line.left }}
			onKeyDown={onKeyDown}
		>
			<span aria-hidden="true">{isAuto ? "SQUELCH · AUTO" : "SQUELCH"}</span>
		</div>
	)
}
