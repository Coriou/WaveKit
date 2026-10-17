// "Last 24 h" in an opened discovery (Scanner board): transmissions per hour as a bar strip, then the last
// few with their length. Read from the discovery's observations; read again when it is heard again.
import type { Discovery } from "@wavekit/api-types"
import { useEffect, useMemo, useState } from "react"

import { useServices } from "../../../app/context.ts"
import { errorMessage, validated } from "../../../data/api-client.ts"
import { useNow } from "../../hooks.ts"
import type { HistoryObservation } from "./history.ts"
import {
	HISTORY_LIMIT,
	axisLabels,
	barHeights,
	countText,
	dayHistory,
	historyAria,
	lastTransmissions,
	observationPageSchema,
} from "./history.ts"

interface Page {
	items: readonly HistoryObservation[]
	nextCursor: string | null
}

export function DiscoveryHistory({ d }: { d: Discovery }) {
	const { data } = useServices()
	const [page, setPage] = useState<Page | null>(null)
	const [error, setError] = useState<string | null>(null)
	const now = useNow(true, 60_000)

	useEffect(() => {
		const abort = new AbortController()
		const path = `/api/scanner/discoveries/${encodeURIComponent(d.id)}/observations`
		data.api
			.get<unknown>(path, {
				query: { limit: String(HISTORY_LIMIT) },
				signal: abort.signal,
			})
			.then(
				body => {
					if (abort.signal.aborted) return
					setPage(validated(observationPageSchema, body, "GET", path))
					setError(null)
				},
				(e: unknown) => {
					if (abort.signal.aborted) return
					setError(errorMessage(e))
				},
			)
		return () => abort.abort()
	}, [data.api, d.id, d.lastSeenAt])

	const day = useMemo(
		() => (page ? dayHistory(page.items, now, page.nextCursor) : null),
		[page, now],
	)
	const txs = useMemo(
		() =>
			page && day && !day.steady ? lastTransmissions(page.items, now) : [],
		[page, day, now],
	)

	if (!day)
		return (
			<div className="wks-hist">
				<div className="wks-hist-head">
					<h4 className="wk-label">Last 24 h</h4>
				</div>
				<p className="wks-hist-note">
					{error
						? `Could not read its history: ${error}`
						: "Reading its history…"}
				</p>
			</div>
		)

	const heights = barHeights(day)
	const [left, mid, right] = axisLabels(day)
	const last = day.bars.length - 1
	return (
		<div className="wks-hist">
			<div className="wks-hist-head">
				<h4 className="wk-label">Last 24 h</h4>
				<span className="wks-gap" />
				<span className="wks-hist-count">{countText(day)}</span>
			</div>
			<div
				className="wks-hist-bars"
				role="img"
				aria-label={historyAria(day)}
				data-steady={day.steady ? "" : undefined}
			>
				{day.bars.map((b, i) => (
					<span
						key={i}
						title={`${String(b.hour).padStart(2, "0")}:00 · ${b.count} heard`}
						data-empty={heights[i] === 0 ? "" : undefined}
						data-now={i === last && heights[i] !== 0 ? "" : undefined}
						style={{ height: Math.max(1, heights[i] ?? 0) }}
					/>
				))}
			</div>
			<div className="wks-hist-axis" aria-hidden="true">
				<span>{left}</span>
				<span>{mid}</span>
				<span>{right}</span>
			</div>
			{day.steady ? (
				<p className="wks-hist-note">
					Always on, so there are no transmissions to list.
				</p>
			) : txs.length > 0 ? (
				<ul className="wks-hist-txs" aria-label="Last transmissions">
					{txs.map(t => (
						<li key={t.id}>
							<span
								className="wks-hist-time"
								data-live={t.live ? "" : undefined}
							>
								{t.live && <span className="wk-live" aria-hidden="true" />}
								{t.time}
							</span>
							<span className="wks-hist-len">{t.length}</span>
							<span className="wks-hist-snr">{t.snr}</span>
						</li>
					))}
				</ul>
			) : (
				<p className="wks-hist-note">Nothing heard yet.</p>
			)}
		</div>
	)
}
