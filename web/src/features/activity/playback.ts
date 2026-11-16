// Activity's side of the one player: which rows have audio (the core's `recording` link on the summary, none
// on rows without a file, D-STAR and DMR rows of calls not recorded included) and the queue a row plays from:
// the recording ids of the rows with audio, in the order shown.
import type { ActivityRecordingLink, ActivitySummary } from "@wavekit/api-types"

import type { QueueRef } from "../playback/service.ts"
import type { ActivityStack } from "./fold.ts"
import { rowView } from "./rows.ts"

/** The row's playable recording; null when it has none. */
export function recordingOf(s: ActivitySummary): ActivityRecordingLink | null {
	return s.recording ?? null
}

/** The dock's title for a row's recording. */
export function recordingTitleOf(s: ActivitySummary): string {
	return rowView(s).title
}

/** The Activity queue: the stacks as shown (their row), those with audio, by recording id. */
export function activityQueue(stacks: readonly ActivityStack[]): QueueRef {
	const ids: string[] = []
	const titles: Record<string, string> = {}
	for (const st of stacks) {
		const rec = recordingOf(st.view)
		if (rec === null || rec.id in titles) continue
		ids.push(rec.id)
		titles[rec.id] = recordingTitleOf(st.view)
	}
	return { source: "activity", ids, titles }
}
