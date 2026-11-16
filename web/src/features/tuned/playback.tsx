// The tuned card's side of the one player: a disc on the earlier rows that carry a recording, playing from
// the card's own list (source "tuned": those rows with audio, in the order shown).
import { useEffect, useMemo, useRef } from "react"

import { useServices } from "../../app/context.ts"
import { PlayDisc } from "../playback/PlaybackUi.tsx"
import type { QueueRef } from "../playback/service.ts"
import type { EarlierRow } from "./now.ts"

/** The rows' recordings as shown, by recording id, titled as the row reads. */
export function tunedQueue(rows: readonly EarlierRow[]): QueueRef {
	const ids: string[] = []
	const titles: Record<string, string> = {}
	for (const r of rows) {
		const rec = r.item.recording
		if (!rec || rec.id in titles) continue
		ids.push(rec.id)
		titles[rec.id] = r.a
	}
	return { source: "tuned", ids, titles }
}

/** Keeps the player's "tuned" queue on the rows shown while one of them plays; renders nothing. */
export function TunedQueue({ rows }: { rows: readonly EarlierRow[] }) {
	const { playback } = useServices()
	const queue = useMemo(() => tunedQueue(rows), [rows])
	useEffect(() => {
		playback.setQueue("tuned", queue.ids, queue.titles)
	}, [playback, queue])
	return null
}

/** The disc of an earlier row with a recording; nothing for one without. */
export function TunedDisc({
	row,
	rows,
}: {
	row: EarlierRow
	rows: readonly EarlierRow[]
}) {
	const shown = useRef(rows)
	shown.current = rows
	const rec = row.item.recording
	if (!rec) return null
	return (
		<PlayDisc
			id={rec.id}
			title={row.a}
			durationMs={rec.durationMs}
			queue={() => tunedQueue(shown.current)}
			inline
		/>
	)
}
