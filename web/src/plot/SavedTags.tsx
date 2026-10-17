// Saved-frequency tags on the plot's band-lane row (docs/web/canvas/Spectrum.dc.html): solid accent chips with a
// bookmark, starting at their frequency; click recalls (mode, bandwidth, tone, then tune). They sit above the lane
// names on an opaque ground, so a band name under a tag gives way to it. Re-renders only when the saved list, the
// view, the width or the tuned frequency change (never per frame).
import "./saved-tags.css"

import { memo, useMemo } from "react"
import type { SavedFrequency } from "@wavekit/api-types"

import type { DataLayer } from "../data/index.ts"
import { isPendingId, useStore } from "../data/index.ts"
import { recallSaved, savedMeta } from "../features/tuner/saved.ts"
import type { SpectrumViewSpan } from "../spectrum/index.ts"
import { formatMHz } from "./maths.ts"
import type { PlotController } from "./plot-store.ts"
import { placeSavedTags, SAVED_TAG_MAX_LABEL_PX } from "./saved-tags.ts"

export interface SavedTagsProps {
	data: DataLayer
	controller: PlotController
	view: SpectrumViewSpan
	widthPx: number
	tunedHz: number | null
}

const BOOKMARK = "M18 7v14l-6 -4l-6 4v-14a4 4 0 0 1 4 -4h4a4 4 0 0 1 4 4z"

export const SavedTags = memo(function SavedTags({
	data,
	controller,
	view,
	widthPx,
	tunedHz,
}: SavedTagsProps) {
	const items = useStore(data.savedFrequencies, s => s.items)
	const showLabels = useStore(data.savedFrequencies, s => s.showLabels)
	const byId = useMemo(() => new Map(items.map(f => [f.id, f])), [items])
	const placed = useMemo(
		() => placeSavedTags(items, view, { widthPx, showLabels, tunedHz }),
		[items, view.startHz, view.endHz, widthPx, showLabels, tunedHz],
	)
	const recall = (f: SavedFrequency) =>
		void recallSaved(
			{
				config: () => data.liveAudio.get().status?.config,
				setConfig: patch => data.liveAudio.setConfig(patch),
				tune: hz => controller.tuneTo(hz),
			},
			f,
		)
	return (
		<>
			{placed.map(t => {
				const f = byId.get(t.id)
				if (!f) return null
				const text = `${f.name} · ${formatMHz(f.frequencyHz, 4)} MHz · ${savedMeta(f)}`
				return (
					<button
						key={t.id}
						type="button"
						className="wk-plot-saved"
						data-tuned={
							tunedHz !== null && Math.round(tunedHz) === t.hz ? "" : undefined
						}
						data-pending={isPendingId(f.id) ? "" : undefined}
						style={{ left: t.x }}
						aria-label={`Saved: ${text}`}
						title={text}
						onClick={() => recall(f)}
					>
						<svg
							width="10"
							height="10"
							viewBox="0 0 24 24"
							fill="currentColor"
							aria-hidden="true"
							focusable="false"
						>
							<path d={BOOKMARK} />
						</svg>
						{t.labelled && (
							<span style={{ maxWidth: SAVED_TAG_MAX_LABEL_PX }}>{f.name}</span>
						)}
					</button>
				)
			})}
		</>
	)
})
