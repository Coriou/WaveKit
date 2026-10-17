// One Activity event, pushed in over the list with Back: the decoded message card (every field, position, the stored
// JSON), where and when it was heard, and earlier events from the same sender.
import type { ActivityRecord, ActivitySummary } from "@wavekit/api-types"
import { useEffect, useRef, useState } from "react"

import { useReadOnly, useServices } from "../../app/context.ts"
import { fetchActivityRecord, queryParams } from "../../data/activity-feed.ts"
import { errorMessage } from "../../data/index.ts"
import { Button } from "../../ui/Button.tsx"
import { Label } from "../../ui/Label.tsx"
import { formatMHz } from "../format.ts"
import { MessageCard } from "../messages/MessageCard.tsx"
import { ActivityRow } from "./ActivityList.tsx"
import { rowView } from "./rows.ts"

const RELATED = 6

function fullTime(iso: string): string {
	const d = new Date(iso)
	if (Number.isNaN(d.getTime())) return iso
	return d.toLocaleString("en-GB", {
		day: "numeric",
		month: "short",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	})
}

export interface ActivityDetailProps {
	item: ActivitySummary | null
	eventId: string
	onBack: () => void
}

export function ActivityDetail({ item, eventId, onBack }: ActivityDetailProps) {
	const { data, activity } = useServices()
	const readOnly = useReadOnly()
	const [record, setRecord] = useState<ActivityRecord | null>(null)
	const [state, setState] = useState<"loading" | "ready" | "gone" | "error">(
		"loading",
	)
	const [error, setError] = useState<string | null>(null)
	const [related, setRelated] = useState<readonly ActivitySummary[]>([])
	const back = useRef<HTMLButtonElement>(null)

	useEffect(() => back.current?.focus(), [eventId])

	useEffect(() => {
		const abort = new AbortController()
		setState("loading")
		setRecord(null)
		fetchActivityRecord(data.api, eventId, abort.signal).then(
			r => {
				if (abort.signal.aborted) return
				setRecord(r)
				setState(r === null ? "gone" : "ready")
			},
			(e: unknown) => {
				if (abort.signal.aborted) return
				setError(errorMessage(e))
				setState("error")
			},
		)
		return () => abort.abort()
	}, [data.api, eventId])

	const entityKey = item?.entityKey ?? null
	useEffect(() => {
		setRelated([])
		if (entityKey === null) return
		const abort = new AbortController()
		data.api
			.request<{ items?: ActivitySummary[] }>(
				"GET",
				"/api/activity",
				undefined,
				{
					query: {
						...queryParams({ entityKey }),
						order: "desc",
						limit: RELATED + 1,
					},
					signal: abort.signal,
				},
			)
			.then(
				page => {
					if (!abort.signal.aborted)
						setRelated(
							(page.items ?? [])
								.filter(i => i.eventId !== eventId)
								.slice(0, RELATED),
						)
				},
				() => undefined,
			)
		return () => abort.abort()
	}, [data.api, entityKey, eventId])

	const onKeyDown = (e: React.KeyboardEvent) => {
		if (
			e.key === "Escape" ||
			(e.key === "Backspace" && !(e.target instanceof HTMLInputElement))
		) {
			e.preventDefault()
			onBack()
		}
	}

	const v = item ? rowView(item) : null
	const hz = item?.frequencyHz ?? null
	const provenance =
		record?.kind === "decoder-reception" ? record.payload.provenance : null

	return (
		<section className="wka-detail" aria-label="Event" onKeyDown={onKeyDown}>
			<div className="wka-detail-bar">
				<Button
					ref={back}
					variant="ghost"
					size="sm"
					onClick={onBack}
					title="Back to the list  Esc"
				>
					‹ Back
				</Button>
			</div>
			<div className="wka-detail-body wk-scroll">
				{item ? (
					<MessageCard item={item} record={record} flat readOnly={readOnly} />
				) : (
					<h3 className="wka-detail-title">Event</h3>
				)}
				{entityKey !== null && v && (
					<div className="wka-detail-actions">
						<Button
							variant="tonal"
							size="sm"
							onClick={() => activity.showEntity(entityKey, v.title)}
						>
							Only this
						</Button>
					</div>
				)}

				{state === "gone" && (
					<p className="wkf-warn">
						This event is no longer kept. The list still shows its summary.
					</p>
				)}
				{state === "error" && (
					<p className="wkf-warn">Could not load the event: {error}</p>
				)}

				<Label>Heard</Label>
				<dl className="wka-fields">
					{item && (
						<div className="wka-field">
							<dt>When</dt>
							<dd>
								<time dateTime={item.producedAt}>
									{fullTime(item.producedAt)}
								</time>
							</dd>
						</div>
					)}
					{hz !== null && (
						<div className="wka-field">
							<dt>Frequency</dt>
							<dd>{formatMHz(hz)} MHz</dd>
						</div>
					)}
					{item?.decoderId && (
						<div className="wka-field">
							<dt>Decoder</dt>
							<dd>{item.decoderId}</dd>
						</div>
					)}
					{item?.sourceId && (
						<div className="wka-field">
							<dt>Receiver</dt>
							<dd>{item.sourceId}</dd>
						</div>
					)}
					{provenance?.frequency &&
						provenance.frequency.tuningTrust !== "commanded" && (
							<div className="wka-field">
								<dt>Tuning</dt>
								<dd>
									{provenance.frequency.tuningTrust === "relay"
										? "Set through the relay"
										: "Not confirmed"}
								</dd>
							</div>
						)}
				</dl>

				{related.length > 0 && (
					<>
						<Label>Earlier from {v?.title ?? "this sender"}</Label>
						<div className="wka-related" role="list">
							{related.map(r => (
								<ActivityRow
									key={r.eventId}
									item={r}
									measure={noop}
									cursor={false}
									current={false}
									fresh={false}
									onOpen={() => activity.open(r)}
								/>
							))}
						</div>
					</>
				)}
			</div>
		</section>
	)
}

const noop = () => undefined
