// One Activity event, pushed in over the list with Back: what it was, every decoded field, where and
// when it was heard, earlier events from the same sender, and the stored JSON.
import type {
	ActivityRecord,
	ActivitySummary,
	DecodeField,
} from "@wavekit/api-types"
import { WaveKitIcon } from "@wavekit/brand/react"
import { useEffect, useRef, useState } from "react"

import { useReadOnly, useServices } from "../../app/context.ts"
import { fetchActivityRecord, queryParams } from "../../data/activity-feed.ts"
import { errorMessage } from "../../data/index.ts"
import { Button } from "../../ui/Button.tsx"
import { Label } from "../../ui/Label.tsx"
import { formatMHz, formatWidth } from "../format.ts"
import { ActivityRow } from "./ActivityList.tsx"
import { fieldText, rowView } from "./rows.ts"

const RELATED = 6

/** Fields of the stored record (all of them, where the summary keeps only the first few). */
export function recordFields(record: ActivityRecord): DecodeField[] {
	switch (record.kind) {
		case "decoder-reception":
			return [...record.payload.fields]
		case "analog-transmission": {
			const p = record.payload
			const out: DecodeField[] = [
				{
					key: "duration",
					label: "Duration",
					value: Math.round(p.durationMs / 100) / 10,
					unit: "s",
				},
				{ key: "modulation", label: "Mode", value: p.modulation.toUpperCase() },
				{ key: "bandwidth", label: "Width", value: formatWidth(p.bandwidthHz) },
				{ key: "squelch", label: "Squelch", value: p.squelchMode },
			]
			if (p.peakChannelPowerDbfs !== null)
				out.push({
					key: "peak",
					label: "Peak",
					value: Math.round(p.peakChannelPowerDbfs * 10) / 10,
					unit: "dBFS",
				})
			if (p.tone?.ctcssHz != null)
				out.push({
					key: "ctcss",
					label: "CTCSS",
					value: p.tone.ctcssHz,
					unit: "Hz",
				})
			if (p.tone?.dcs)
				out.push({
					key: "dcs",
					label: "DCS",
					value: `${p.tone.dcs.code} ${p.tone.dcs.polarity}`,
				})
			if (p.tone?.dtmf)
				out.push({ key: "dtmf", label: "DTMF", value: p.tone.dtmf })
			out.push({ key: "closed", label: "Ended by", value: p.closeReason })
			return out
		}
		case "ingestion-gap": {
			const p = record.payload
			return [
				{ key: "dropped", label: "Not kept", value: p.dropped },
				{ key: "reason", label: "Reason", value: p.reason },
				{ key: "decoders", label: "Decoders", value: p.decoderIds.join(", ") },
			]
		}
		default:
			return []
	}
}

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
	const { data, activity, tuning } = useServices()
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
	// The message is shown above the fields; do not repeat it in the grid.
	const fields = (record ? recordFields(record) : (item?.fields ?? [])).filter(
		f => v?.message == null || f.value !== v.message,
	)
	const hz = item?.frequencyHz ?? null
	const decoded =
		record?.kind === "decoder-reception"
			? record.payload.decodedData
			: record?.payload
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
				<header className="wka-detail-head">
					<span className="wk-tile" aria-hidden="true">
						{v?.icon ? (
							<WaveKitIcon name={v.icon} size={16} />
						) : (
							<span className="wka-tile-dot" />
						)}
					</span>
					<div className="wka-main">
						<h3 className="wka-detail-title">{v?.title ?? "Event"}</h3>
						{v?.subtitle && <span className="wka-sub">{v.subtitle}</span>}
						{item && (
							<time className="wka-sub" dateTime={item.producedAt}>
								{fullTime(item.producedAt)}
							</time>
						)}
					</div>
				</header>

				{v?.message != null && <p className="wka-detail-msg">{v.message}</p>}

				<div className="wka-detail-actions">
					{hz !== null && (
						<Button
							variant="primary"
							size="sm"
							disabled={readOnly}
							onClick={() => void tuning.tune(hz)}
						>
							Tune {formatMHz(hz)}
						</Button>
					)}
					{entityKey !== null && v && (
						<Button
							variant="tonal"
							size="sm"
							onClick={() => activity.showEntity(entityKey, v.title)}
						>
							Only this
						</Button>
					)}
				</div>

				{state === "gone" && (
					<p className="wkf-warn">
						This event is no longer kept. The list still shows its summary.
					</p>
				)}
				{state === "error" && (
					<p className="wkf-warn">Could not load the event: {error}</p>
				)}

				{fields.length > 0 && (
					<dl className="wka-fields">
						{fields.map(f => (
							<div key={f.key} className="wka-field">
								<dt>{f.label}</dt>
								<dd>{fieldText(f)}</dd>
							</div>
						))}
					</dl>
				)}

				<Label>Heard</Label>
				<dl className="wka-fields">
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
					{item?.position && (
						<div className="wka-field">
							<dt>Position</dt>
							<dd>
								{item.position.lat.toFixed(4)}, {item.position.lon.toFixed(4)}
								{item.position.altM !== undefined
									? ` · ${Math.round(item.position.altM)} m`
									: ""}
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

				{decoded !== undefined && (
					<details className="wka-raw">
						<summary>Raw event</summary>
						<pre>{JSON.stringify(decoded, null, 2)}</pre>
					</details>
				)}
			</div>
		</section>
	)
}

const noop = () => undefined
