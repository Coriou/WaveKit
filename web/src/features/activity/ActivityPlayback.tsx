// The disc on an Activity row or card with audio, and the detail's Recording block (the waveform as a seek
// view of the one player, Keep). Both only drive the one player; the dock stays the transport. A row whose
// file the core is still saving (linked, not served yet: recording-readiness.ts) shows a quiet "Saving" disc
// of the same size in the disc's place, which turns into the play disc once the file is served.
import type { ActivitySummary } from "@wavekit/api-types"
import { useMemo, useRef } from "react"

import { useServices } from "../../app/context.ts"
import { useStore } from "../../data/index.ts"
import { recordingReadiness } from "../../data/recording-readiness.ts"
import { Label } from "../../ui/Label.tsx"
import { KeepButton, PlayDisc, WaveView } from "../playback/PlaybackUi.tsx"
import type { QueueRef } from "../playback/service.ts"
import { foldedOf } from "./fold.ts"
import {
	activityListKey,
	activityQueue,
	recordingOf,
	recordingTitleOf,
} from "./playback.ts"

/** Whether the core is still saving recording `id` (linked, not served yet). */
export function useRecordingSaving(id: string | null): boolean {
	return useStore(recordingReadiness.saving, m => id !== null && m.has(id))
}

export const SAVING_TITLE = "Saving the recording: it plays in a few seconds"

/** The disc's place while its file is saved: the same footprint, nothing to press, never an error. */
export function SavingDisc({
	inline = false,
	className,
}: {
	inline?: boolean
	className?: string
}) {
	return (
		<span
			className={className ? `wkp-disc ${className}` : "wkp-disc"}
			data-saving=""
			data-inline={inline || undefined}
			role="img"
			aria-label="Saving the recording"
			title={SAVING_TITLE}
		>
			<span className="wkp-disc-face wka-saving-face" aria-hidden="true" />
			<span className="wkp-disc-dur">Saving</span>
		</span>
	)
}

/** The play disc of a row with audio (Saving while its file is saved); nothing for a row without. */
export function ActivityDisc({
	item,
	queue,
	inline = false,
}: {
	item: ActivitySummary
	queue: () => QueueRef
	inline?: boolean
}) {
	const rec = recordingOf(item)
	const saving = useRecordingSaving(rec?.id ?? null)
	if (rec === null) return null
	if (saving) return <SavingDisc inline={inline} className="wka-disc" />
	return (
		<PlayDisc
			id={rec.id}
			title={recordingTitleOf(item)}
			durationMs={rec.durationMs}
			queue={queue}
			className="wka-disc"
			inline={inline}
		/>
	)
}

/** The open event's recording: disc, waveform (seek view) and Keep. */
export function RecordingBlock({ item }: { item: ActivitySummary }) {
	const { activity } = useServices()
	const rec = recordingOf(item)
	// the list it was opened from, as shown (its own queue key)
	const feed = activity.stackFeed()
	const list = activityListKey(feed)
	const items = useStore(feed, s => s.items)
	const queue = useMemo(
		() => activityQueue(foldedOf(items, feed), list),
		[items, feed, list],
	)
	const queueRef = useRef(queue)
	queueRef.current = queue
	const saving = useRecordingSaving(rec?.id ?? null)
	if (rec === null) return null
	const title = recordingTitleOf(item)
	const read = () => {
		const q = queueRef.current
		return q.ids.includes(rec.id)
			? q
			: {
					source: "activity" as const,
					list,
					ids: [rec.id],
					titles: { [rec.id]: title },
				}
	}
	return (
		<section className="wka-rec" aria-label="Recording">
			<Label>Recording</Label>
			<div className="wka-rec-row">
				{saving ? (
					<>
						<SavingDisc />
						<p className="wka-rec-saving">{SAVING_TITLE}.</p>
					</>
				) : (
					<>
						<PlayDisc
							id={rec.id}
							title={title}
							durationMs={rec.durationMs}
							queue={read}
						/>
						<div className="wka-rec-wave">
							<WaveView
								id={rec.id}
								title={title}
								durationMs={rec.durationMs}
								queue={read}
							/>
						</div>
					</>
				)}
			</div>
			<div className="wka-rec-actions">
				<KeepButton id={rec.id} title={title} />
			</div>
		</section>
	)
}
