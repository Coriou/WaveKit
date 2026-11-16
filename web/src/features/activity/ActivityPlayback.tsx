// The disc on an Activity row or card with audio, and the detail's Recording block (the waveform as a seek
// view of the one player, Keep). The dock goes compact while the open event's recording is the playing one.
import type { ActivitySummary } from "@wavekit/api-types"
import { useEffect, useMemo, useRef } from "react"

import { useServices } from "../../app/context.ts"
import { useStore } from "../../data/index.ts"
import { Label } from "../../ui/Label.tsx"
import { KeepButton, PlayDisc, WaveView } from "../playback/PlaybackUi.tsx"
import type { QueueRef } from "../playback/service.ts"
import { foldedOf } from "./fold.ts"
import { activityQueue, recordingOf, recordingTitleOf } from "./playback.ts"

/** The play disc of a row with audio; nothing for a row without. */
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
	if (rec === null) return null
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
	const { playback, activity } = useServices()
	const rec = recordingOf(item)
	const id = rec?.id ?? null
	useEffect(() => {
		playback.setExpanded("activity", id)
		return () => playback.setExpanded("activity", null)
	}, [playback, id])
	// the list it was opened from, as shown
	const feed = activity.stackFeed()
	const items = useStore(feed, s => s.items)
	const queue = useMemo(
		() => activityQueue(foldedOf(items, feed)),
		[items, feed],
	)
	const queueRef = useRef(queue)
	queueRef.current = queue
	if (rec === null) return null
	const title = recordingTitleOf(item)
	const read = () => {
		const q = queueRef.current
		return q.ids.includes(rec.id)
			? q
			: {
					source: "activity" as const,
					ids: [rec.id],
					titles: { [rec.id]: title },
				}
	}
	return (
		<section className="wka-rec" aria-label="Recording">
			<Label>Recording</Label>
			<div className="wka-rec-row">
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
			</div>
			<div className="wka-rec-actions">
				<KeepButton id={rec.id} title={title} />
			</div>
		</section>
	)
}
