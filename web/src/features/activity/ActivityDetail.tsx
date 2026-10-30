// One Activity event, pushed in over the list with Back: the decoded message card exactly as stored (every field,
// position, the stored JSON), what it probably is (a hypothesis from its stack: "Likely a paging-network idle
// beacon …"), who earlier rows of its stack said it is when this decode does not (a separate "Latest known" block,
// identity only), where, when and how strong it was heard, links to tune it and to its Scanner discovery, and the
// rows folded with it (or, opened by a link, earlier events from the same sender).
import type {
	ActivityRecord,
	ActivitySummary,
	Discovery,
} from "@wavekit/api-types"
import { useEffect, useMemo, useRef, useState } from "react"

import { useReadOnly, useServices } from "../../app/context.ts"
import { fetchActivityRecord, queryParams } from "../../data/activity-feed.ts"
import { errorMessage, useStore } from "../../data/index.ts"
import { shellStore } from "../../shell/store.ts"
import { Button } from "../../ui/Button.tsx"
import { Label } from "../../ui/Label.tsx"
import { clockText, dateText, useDisplay } from "../display.ts"
import { formatMHz } from "../format.ts"
import { summaryOfRecord } from "../messages/card.ts"
import { MessageCard } from "../messages/MessageCard.tsx"
import { openDiscovery } from "../scanner/ui-store.ts"
import { ActivityRow, FoldedRow } from "./ActivityList.tsx"
import type { ActivityStack, KnownIdentity } from "./fold.ts"
import {
	explainStack,
	foldActivity,
	knownFor,
	spanText,
	stackIn,
} from "./fold.ts"
import { fieldText, rowView } from "./rows.ts"
import { pagerDetailItem } from "./pager-detail.ts"

const RELATED = 6
/** Folded rows listed in the detail; a longer stack says how many more (the list expands them all). */
const FOLDED_SHOWN = 50
/** A discovery this close to the event's frequency is "its" discovery: half a 25 kHz channel. */
const DISCOVERY_TOLERANCE_HZ = 12_500
/** Reception strength fields the decoders send, shown under Heard. */
const STRENGTH = /^(rssi|signal|snr|level|power|dbfs)$/i

/** The folded rows the detail lists (at most FOLDED_SHOWN) and how many more the stack has. */
export function foldedShown<T>(members: readonly T[]): {
	shown: readonly T[]
	more: number
} {
	return {
		shown: members.slice(0, FOLDED_SHOWN),
		more: Math.max(0, members.length - FOLDED_SHOWN),
	}
}

/** The stack's channels other than this decode's own (`hz`), matched to the kHz. */
export function otherChannels(
	channelsHz: readonly number[],
	hz: number | null,
): number[] {
	const own = hz === null ? null : Math.round(hz / 1000)
	return channelsHz.filter(c => Math.round(c / 1000) !== own)
}

/** A discovery is this event's when it sits within DISCOVERY_TOLERANCE_HZ of its frequency. */
export function isNearDiscovery(
	d: Pick<Discovery, "frequencyHz"> | undefined,
	hz: number,
): boolean {
	return (
		d !== undefined && Math.abs(d.frequencyHz - hz) <= DISCOVERY_TOLERANCE_HZ
	)
}

/** The detail drops "Message type: unknown": the stack's explanation says what it is instead. */
export function withoutUnknownType(item: ActivitySummary): ActivitySummary {
	const unknown = (f: ActivitySummary["fields"][number]) =>
		f.key === "messageType" &&
		typeof f.value === "string" &&
		f.value.toLowerCase() === "unknown"
	return item.fields.some(unknown)
		? { ...item, fields: item.fields.filter(f => !unknown(f)) }
		: item
}

/** "8 Oct, 14:05:09" on the chosen clock. */
function fullTime(iso: string): string {
	const time = clockText(iso, { seconds: true })
	return time ? `${dateText(iso)}, ${time}` : iso
}

export interface ActivityDetailProps {
	item: ActivitySummary | null
	eventId: string
	onBack: () => void
}

export function ActivityDetail({
	item: listed,
	eventId,
	onBack,
}: ActivityDetailProps) {
	const { data, activity } = useServices()
	const readOnly = useReadOnly()
	useDisplay() // times and units follow Settings › Display
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

	// opened by its id (a link): the row is rebuilt from the stored record
	const item = useMemo(
		() => listed ?? (record ? summaryOfRecord(record) : null),
		[listed, record],
	)
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

	// the stack it belongs to, folded from the list it was opened from (live: it grows as decodes arrive)
	const loadedFrom = activity.stackFeed()
	const loaded = useStore(loadedFrom, v => v.items)
	const folded = useMemo(
		() => stackIn(loaded, loadedFrom, eventId),
		[loaded, loadedFrom, eventId],
	)
	const stack: ActivityStack | null = useMemo(
		() => folded ?? (item ? (foldActivity([item])[0] ?? null) : null),
		[folded, item],
	)

	// its Scanner discovery, when one sits on this frequency
	const [discovery, setDiscovery] = useState<Discovery | null>(null)
	const atHz = item?.frequencyHz ?? null
	useEffect(() => {
		setDiscovery(null)
		if (atHz === null) return
		const abort = new AbortController()
		data.api
			.get<{ items?: Discovery[] }>("/api/scanner/discoveries", {
				query: {
					nearHz: Math.round(atHz),
					toleranceHz: DISCOVERY_TOLERANCE_HZ,
					limit: 1,
				},
				signal: abort.signal,
			})
			.then(
				page => {
					const d = page.items?.[0]
					if (!abort.signal.aborted && d && isNearDiscovery(d, atHz))
						setDiscovery(d)
				},
				// an older core without the scanner store: no link
				() => undefined,
			)
		return () => abort.abort()
	}, [data.api, atHz])

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
	const alsoHeard = stack ? otherChannels(stack.channelsHz, hz) : []
	const provenance =
		record?.kind === "decoder-reception" ? record.payload.provenance : null

	const detailItem = item
		? withoutUnknownType(pagerDetailItem(item, record))
		: null
	const detailRecord =
		record?.kind === "decoder-reception" && detailItem && detailItem !== item
			? { ...record, payload: { ...record.payload, fields: detailItem.fields } }
			: record

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
					<MessageCard
						item={detailItem ?? item}
						record={detailRecord}
						flat
						readOnly={readOnly}
					/>
				) : (
					<h3 className="wka-detail-title">Event</h3>
				)}
				{stack && <WhatItIs stack={stack} />}
				{stack && item && <LatestKnown known={knownFor(stack, item)} />}
				{((entityKey !== null && v) || discovery !== null) && (
					<div className="wka-detail-actions">
						{entityKey !== null && v && (
							<Button
								variant="tonal"
								size="sm"
								onClick={() => activity.showEntity(entityKey, v.title)}
							>
								Only this
							</Button>
						)}
						{discovery !== null && (
							<Button
								variant="tonal"
								size="sm"
								title="This frequency's discovery in the Scanner"
								onClick={() => {
									openDiscovery(discovery.id)
									shellStore.openDrawer("scanner")
								}}
							>
								Open in Scanner
							</Button>
						)}
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
					{stack && stack.members.length > 1 && (
						<div className="wka-field">
							<dt>Seen (loaded list)</dt>
							<dd>
								{stack.members.length} times over{" "}
								{spanText(stack.lastMs - stack.firstMs)}, since{" "}
								<time dateTime={new Date(stack.firstMs).toISOString()}>
									{clockText(new Date(stack.firstMs).toISOString())}
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
					{alsoHeard.length > 0 && (
						<div className="wka-field">
							<dt>Also heard on (simulcast)</dt>
							<dd>{alsoHeard.map(c => formatMHz(c)).join(" · ")} MHz</dd>
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
					{item?.fields
						.filter(f => STRENGTH.test(f.key))
						.slice(0, 2)
						.map(f => (
							<div key={f.key} className="wka-field">
								<dt>{f.label}</dt>
								<dd>{fieldText(f)}</dd>
							</div>
						))}
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

				{stack && stack.members.length > 1 ? (
					<>
						<Label>
							Folded here · {stack.members.length} in the loaded list
						</Label>
						<div className="wka-related" role="list">
							{foldedShown(stack.members).shown.map(m => (
								<FoldedRow
									key={m.eventId}
									entryKey={m.eventId}
									item={m}
									measure={noop}
									cursor={false}
									current={m.eventId === eventId}
									onOpen={() => activity.open(m)}
								/>
							))}
						</div>
						{foldedShown(stack.members).more > 0 && (
							<p className="wka-foot">
								And {foldedShown(stack.members).more} more: expand the row in
								the list to see them all.
							</p>
						)}
					</>
				) : (
					related.length > 0 && (
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
					)
				)}
			</div>
		</section>
	)
}

const noop = () => undefined

/**
 * Who earlier rows of the stack said it is, when this decode does not (an aircraft's callsign on a
 * position-only decode): identity only, each with the time of the row that said it, apart from the event.
 */
function LatestKnown({ known }: { known: KnownIdentity }) {
	if (known.title === null && known.fields.length === 0) return null
	const at = (s: ActivitySummary) => (
		<time className="wka-known-at" dateTime={s.producedAt}>
			{" "}
			· {clockText(s.producedAt, { seconds: true })}
		</time>
	)
	return (
		<div className="wka-known">
			<Label>Latest known (from earlier rows)</Label>
			<dl className="wka-fields">
				{known.title && (
					<div className="wka-field">
						<dt>Name</dt>
						<dd>
							{known.title.value}
							{at(known.title.from)}
						</dd>
					</div>
				)}
				{known.fields.map(k => (
					<div key={k.field.key} className="wka-field">
						<dt>{k.field.label}</dt>
						<dd>
							{fieldText(k.field)}
							{at(k.from)}
						</dd>
					</div>
				))}
			</dl>
			<p className="wka-what-note">
				Not in this decode: an earlier row of the same stack said it.
			</p>
		</div>
	)
}

/** What it probably is: a hypothesis from the stack's rows, labelled as one. */
function WhatItIs({ stack }: { stack: ActivityStack }) {
	const e = explainStack(stack)
	return (
		<div className="wka-what" data-tone={e.tone}>
			<Label>What it is</Label>
			<p className="wka-what-text">{e.headline}</p>
			{e.tone === "likely" && (
				<p className="wka-what-note">
					A guess from the decodes in the loaded list, not a decoded fact.
				</p>
			)}
		</div>
	)
}
