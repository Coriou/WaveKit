import "./transmission.css"

// The Transmission view: one transmission, pushed into the drawer the user is in, in the order a listener asks
// about it: Listen; What we know (Who, Tone, Signal, Ended, Kept); the Conversation, oldest first with Play all;
// the channel's doors (History, Open in Scanner, Tune); and, collapsed, the expert Details with every id and raw
// number. It renders only the Transmission DTO (loadTransmission); Back and Esc return to the origin in one step.
import type { JsonValue } from "@wavekit/api-types"
import { useEffect, useMemo, useRef, useState } from "react"
import type { KeyboardEvent as ReactKeyboardEvent } from "react"

import { useServices } from "../../app/context.ts"
import { errorMessage } from "../../data/index.ts"
import { showAppToast } from "../../shell/toast.ts"
import { Button } from "../../ui/Button.tsx"
import { Label } from "../../ui/Label.tsx"
import { useDisplay } from "../display.ts"
import { JsonView } from "../messages/JsonView.tsx"
import {
	historyLabel,
	protocolSpelling,
	rasterHz,
	savedNameAt,
	showChannel,
	stepAt,
	useSavedNames,
} from "../naming.ts"
import { KeepButton, PlayDisc, WaveView } from "../playback/PlaybackUi.tsx"
import type { QueueRef } from "../playback/service.ts"
import { useDrawerVisible } from "../playback/visible.ts"
import { formatBytes } from "../recordings/model.ts"
import type { TransmissionDto, TransmissionMember } from "./contract.ts"
import { parseRef, refText } from "./contract.ts"
import { loadTransmission, TransmissionNotFoundError } from "./load.ts"
import type { OpenTransmission } from "./nav.ts"
import { openInScanner, replaceTransmission } from "./nav.ts"
import {
	channelText,
	CLOSE_WORDS,
	ctcssText,
	durationWords,
	FINISH_CUT_WORDS,
	ITEM_CUT_WORDS,
	KEPT_BY_WORDS,
	measuredText,
	NO_AUDIO_WORDS,
	signalText,
	SPEECH_WORDS,
	startText,
	toneRow,
	wordsFor,
} from "./words.ts"

const DETAILS_KEY = "wavekit.web.transmission.detailsOpen"

function readDetailsOpen(): boolean {
	try {
		return globalThis.localStorage?.getItem(DETAILS_KEY) === "1"
	} catch {
		return false
	}
}

function writeDetailsOpen(open: boolean): void {
	try {
		globalThis.localStorage?.setItem(DETAILS_KEY, open ? "1" : "0")
	} catch {
		// private windows and full storage: remembered for this page only
	}
}

/** What a transmission is, in content words, when nobody is named: "FM voice", "Digital voice". */
export function transmissionWhat(t: TransmissionDto): string {
	if (t.identity?.talkgroup) return `TG ${t.identity.talkgroup}`
	if (t.identity?.label) return t.identity.label
	if (t.kind === "voice-analog")
		return protocolSpelling(t.protocol) ?? "FM voice"
	if (t.kind === "voice-digital") return "Digital voice"
	return "Transmission"
}

/** The title: the channel's saved name, else what it is. */
export function transmissionHeading(t: TransmissionDto): string {
	return savedNameAt(t.channel.hz) ?? t.channel.name ?? transmissionWhat(t)
}

/** "What we know": at most six short rows in a fixed order; Tone always for analog FM. */
export function knownRows(
	t: TransmissionDto,
): { term: string; value: string; hint: string | null }[] {
	const rows: { term: string; value: string; hint: string | null }[] = []
	const who = [
		t.identity?.talkgroup ? `TG ${t.identity.talkgroup}` : null,
		t.identity?.radio ? `radio ${t.identity.radio}` : null,
	].filter((x): x is string => x !== null)
	if (who.length > 0)
		rows.push({ term: "Who", value: who.join(" · "), hint: null })
	if (t.tone !== null) rows.push({ term: "Tone", ...toneRow(t.tone) })
	const signal = signalText(t.signal?.snrDb)
	if (signal !== null) rows.push({ term: "Signal", value: signal, hint: null })
	const ended =
		wordsFor(FINISH_CUT_WORDS, t.close?.reason) ??
		wordsFor(ITEM_CUT_WORDS, t.verdict.itemCut) ??
		wordsFor(CLOSE_WORDS, t.close?.reason)
	if (ended !== null) rows.push({ term: "Ended", value: ended, hint: null })
	const kept =
		wordsFor(KEPT_BY_WORDS, t.verdict.keptBy) ??
		(t.verdict.speech !== "unchecked" ? SPEECH_WORDS[t.verdict.speech] : null)
	if (kept !== null) rows.push({ term: "Kept", value: kept, hint: null })
	return rows.slice(0, 6)
}

/** The Conversation's queue: every member with audio, oldest first, under its own list (no list rewrites it). */
export function conversationQueue(
	t: TransmissionDto,
	source: "recordings" | "activity",
	title: string,
): QueueRef | null {
	const members = t.group?.members ?? []
	const ids = members
		.map(m => m.audioId)
		.filter((id): id is string => id !== null)
	if (ids.length === 0) return null
	const titles: Record<string, string> = {}
	for (const m of members)
		if (m.audioId !== null)
			titles[m.audioId] = `${title} · ${startText(m.startedAt)}`
	return { source, list: "transmission", ids, titles }
}

type LoadState =
	| { status: "loading" }
	| { status: "ready"; t: TransmissionDto }
	| { status: "missing" }
	| { status: "error"; error: string }

export function TransmissionView({
	open,
	onBack,
}: {
	open: OpenTransmission
	onBack: () => void
}) {
	const services = useServices()
	const { data, playback } = services
	useDisplay() // times follow Settings › Display
	useSavedNames() // a saved name renames the title
	const [state, setState] = useState<LoadState>({ status: "loading" })
	const [attempt, setAttempt] = useState(0)
	const back = useRef<HTMLButtonElement>(null)
	const key = refText(open.ref)
	// the ref's text is its identity; the summary only seeds the first read
	const opened = useRef(open)
	opened.current = open

	useEffect(() => back.current?.focus({ preventScroll: true }), [])

	useEffect(() => {
		const abort = new AbortController()
		setState({ status: "loading" })
		loadTransmission(opened.current.ref, {
			api: data.api,
			recordings: () => data.recordings.get().items,
			summary: opened.current.summary,
			signal: abort.signal,
		}).then(
			t => {
				if (!abort.signal.aborted) setState({ status: "ready", t })
			},
			(e: unknown) => {
				if (abort.signal.aborted) return
				setState(
					e instanceof TransmissionNotFoundError
						? { status: "missing" }
						: { status: "error", error: errorMessage(e) },
				)
			},
		)
		return () => abort.abort()
	}, [data, key, attempt])

	// the dock goes compact while this transmission's audio is the playing one
	const host = open.origin.host
	const visible = useDrawerVisible(host)
	const audioId =
		state.status === "ready" ? (state.t.artefacts[0]?.id ?? null) : null
	useEffect(() => {
		playback.setExpanded(host, audioId, visible)
	}, [playback, host, audioId, visible])
	useEffect(() => () => playback.setExpanded(host, null), [playback, host])

	const onKeyDown = (e: ReactKeyboardEvent<HTMLElement>) => {
		if (e.key !== "Escape") return
		const target = e.target as HTMLElement
		if (target.tagName === "INPUT" || target.closest("[role=menu]")) return
		e.preventDefault()
		e.stopPropagation()
		onBack()
	}

	return (
		<section
			className="wkt-view"
			aria-label="Transmission"
			onKeyDown={onKeyDown}
		>
			<div className="wkt-bar">
				<Button
					ref={back}
					variant="ghost"
					size="sm"
					onClick={onBack}
					title={`Back to ${open.origin.label === "Back" ? "where you were" : open.origin.label}  Esc`}
				>
					‹ {open.origin.label}
				</Button>
				<span className="wkt-gap" />
				{audioId !== null && state.status === "ready" && (
					<KeepButton id={audioId} title={transmissionHeading(state.t)} />
				)}
			</div>
			<div className="wkt-body wk-scroll">
				{state.status === "loading" && (
					<p className="wkt-note" role="status">
						Loading this transmission…
					</p>
				)}
				{state.status === "missing" && (
					<p className="wkt-note" role="status">
						This transmission is no longer kept.
					</p>
				)}
				{state.status === "error" && (
					<p className="wkt-note" data-tone="warn" role="status">
						Could not load this transmission: {state.error}{" "}
						<button
							type="button"
							className="wkt-link"
							onClick={() => setAttempt(n => n + 1)}
						>
							Try again
						</button>
					</p>
				)}
				{state.status === "ready" && <Ready t={state.t} host={host} />}
			</div>
		</section>
	)
}

function Ready({
	t,
	host,
}: {
	t: TransmissionDto
	host: "recordings" | "activity"
}) {
	const services = useServices()
	const title = transmissionHeading(t)
	const audio = t.artefacts.find(a => a.kind === "audio") ?? null
	const queue = useMemo(
		() => conversationQueue(t, host, title),
		[t, host, title],
	)
	const own = useMemo<QueueRef | null>(
		() =>
			audio === null
				? null
				: {
						source: host,
						list: "transmission",
						ids: [audio.id],
						titles: { [audio.id]: title },
					},
		[audio, host, title],
	)
	const playQueue = () =>
		queue !== null && audio !== null && queue.ids.includes(audio.id)
			? queue
			: (own ?? { source: host, ids: [] })
	const sub = [
		t.channel.hz !== null && savedNameAt(t.channel.hz) !== null
			? transmissionWhat(t)
			: null,
		channelText(t.channel.hz),
	]
		.filter((x): x is string => x !== null)
		.join(" · ")
	const rows = knownRows(t)
	const noAudio =
		audio === null
			? (wordsFor(NO_AUDIO_WORDS, t.noAudioReason) ?? "Not recorded")
			: null
	return (
		<>
			<header className="wkt-head">
				<span className="wk-tile" data-tone="accent" aria-hidden="true" />
				<span className="wkt-head-main">
					<span className="wkt-head-line">
						<h3 className="wkt-title">{title}</h3>
						<span className="wkt-gap" />
						<time className="wkt-time" dateTime={t.startedAt}>
							{startText(t.startedAt)}
						</time>
					</span>
					<span className="wkt-head-line wkt-sub">
						<span>{sub}</span>
						<span className="wkt-gap" />
						<span>{durationWords(t.durationMs) ?? ""}</span>
					</span>
				</span>
			</header>

			<section className="wkt-listen" aria-label="Listen">
				{audio !== null ? (
					<div className="wkt-listen-row">
						<PlayDisc
							id={audio.id}
							title={title}
							durationMs={audio.durationMs}
							queue={playQueue}
						/>
						<div className="wkt-wave">
							<WaveView
								id={audio.id}
								title={title}
								durationMs={audio.durationMs}
								queue={playQueue}
							/>
						</div>
					</div>
				) : (
					<p className="wkt-note">{noAudio}</p>
				)}
			</section>

			{rows.length > 0 && (
				<section aria-label="What we know">
					<Label>What we know</Label>
					<dl className="wkt-known">
						{rows.map(r => (
							<div key={r.term} className="wkt-known-row">
								<dt>{r.term}</dt>
								<dd>
									{r.value}
									{r.hint !== null && (
										<span className="wkt-hint">{r.hint}</span>
									)}
								</dd>
							</div>
						))}
					</dl>
				</section>
			)}

			{t.group !== null && (
				<Conversation t={t} queue={queue} self={audio?.id ?? null} />
			)}

			<ChannelDoors t={t} />

			<Details
				t={t}
				fileUrl={
					audio
						? services.data.recordings.fileUrl(audio.inventoryId ?? audio.id)
						: null
				}
			/>
		</>
	)
}

function Conversation({
	t,
	queue,
	self,
}: {
	t: TransmissionDto
	queue: QueueRef | null
	self: string | null
}) {
	const { playback } = useServices()
	const members = t.group?.members ?? []
	const first = members[0]
	const last = members[members.length - 1]
	const span =
		first && last
			? Date.parse(last.startedAt) +
				(last.durationMs ?? 0) -
				Date.parse(first.startedAt)
			: 0
	const heading = t.group?.heuristic
		? `Around this time on this channel · ${members.length}`
		: `Conversation · ${members.length} transmissions over ${durationWords(span) ?? ""}`
	const isSelf = (m: TransmissionMember) =>
		m.ref === refText({ recording: self ?? "" }) ||
		t.refs.recordingKeys.some(k => m.ref === refText({ recording: k }))
	return (
		<section aria-label="Conversation" className="wkt-conv">
			<div className="wkt-conv-head">
				<Label>{heading}</Label>
				<span className="wkt-gap" />
				{queue !== null && queue.ids[0] !== undefined && (
					<Button
						variant="tonal"
						size="sm"
						title="Play them in the order they were heard"
						onClick={() =>
							playback.play(
								queue.ids[0]!,
								queue,
								0,
								queue.titles?.[queue.ids[0]!],
							)
						}
					>
						▶ Play all
					</Button>
				)}
			</div>
			{t.group?.heuristic && (
				<p className="wkt-hint">
					Recordings of this channel close in time; not known to be one
					exchange.
				</p>
			)}
			<ol className="wkt-conv-list">
				{members.map(m => {
					const current = isSelf(m)
					const ref = parseRef(m.ref)
					return (
						<li key={m.ref}>
							<button
								type="button"
								className="wk-row wkt-conv-row"
								data-size="dense"
								aria-current={current || undefined}
								disabled={current || ref === null}
								onClick={() => {
									if (ref !== null) replaceTransmission(ref)
								}}
							>
								<time dateTime={m.startedAt}>{startText(m.startedAt)}</time>
								<span>{durationWords(m.durationMs) ?? ""}</span>
								{current && <span className="wkt-this">this one</span>}
							</button>
						</li>
					)
				})}
			</ol>
		</section>
	)
}

function ChannelDoors({ t }: { t: TransmissionDto }) {
	const services = useServices()
	const hz = t.channel.hz
	const discovery = t.refs.ownerDiscoveryId ?? t.refs.discoveryId
	const summary = t.channelSummary
	const line = summary
		? [
				summary.timesHeard !== null
					? `Heard ${summary.timesHeard} times${summary.since ? ` since ${startText(summary.since).split(",")[0] ?? ""}` : ""}`
					: null,
				summary.usualCtcssHz !== null
					? `usually ${ctcssText(summary.usualCtcssHz)}`
					: null,
			]
				.filter((x): x is string => x !== null)
				.join(" · ")
		: ""
	if (hz === null && discovery === null) return null
	return (
		<section aria-label="On this channel" className="wkt-doors">
			<Label>On this channel</Label>
			{line !== "" && <p className="wkt-line">{line}</p>}
			<div className="wkt-door-row">
				{hz !== null && (
					<Button
						variant="tonal"
						size="sm"
						title="Everything heard on this channel, in Activity"
						onClick={() => showChannel(services.activity, hz, stepAt(hz))}
					>
						{historyLabel(hz)}
					</Button>
				)}
				{discovery !== null && (
					<Button
						variant="tonal"
						size="sm"
						title="This channel's discovery in the Scanner"
						onClick={() => void openInScanner(discovery, services.data.scanner)}
					>
						Open in Scanner
					</Button>
				)}
				{hz !== null && (
					<Button
						variant="tonal"
						size="sm"
						title="Tune the receiver to this channel"
						onClick={() => void services.tuning.tune(rasterHz(hz))}
					>
						Tune
					</Button>
				)}
			</div>
		</section>
	)
}

function Details({
	t,
	fileUrl,
}: {
	t: TransmissionDto
	fileUrl: string | null
}) {
	const [open, setOpen] = useState(readDetailsOpen)
	const ids: [string, string | null][] = [
		["Transmission", t.id],
		...t.refs.recordingKeys.map((k): [string, string] => ["Recording", k]),
		["Observation", t.refs.observationId],
		["Discovery", t.refs.discoveryId],
		[
			"Owner discovery",
			t.refs.ownerDiscoveryId !== t.refs.discoveryId
				? t.refs.ownerDiscoveryId
				: null,
		],
		...t.refs.eventIds.map((k): [string, string] => ["Activity event", k]),
		["Operation", t.refs.operationId],
		["Receiver", t.sourceId],
	]
	const audio = t.artefacts.find(a => a.kind === "audio") ?? null
	const facts: [string, string | null][] = [
		[
			"Measured",
			t.channel.measuredHz !== null
				? measuredText(
						t.channel.measuredHz,
						t.channel.hz !== null ? rasterHz(t.channel.hz) : null,
					)
				: null,
		],
		[
			"Channel Hz",
			t.channel.hz !== null ? String(Math.round(t.channel.hz)) : null,
		],
		["Start (UTC)", t.startedAt],
		["End (UTC)", t.endedAt],
		["Duration ms", t.durationMs !== null ? String(t.durationMs) : null],
		["Part", t.part ? `${t.part.index} of ${t.part.of}` : null],
		["Close code", t.close?.reason ?? null],
		["Cut code", t.verdict.itemCut],
		["Kept by code", t.verdict.keptBy],
		["Speech", t.verdict.speech],
		["Tone source", t.tone?.from ?? null],
		["Tone state", t.tone?.state ?? null],
		["SNR dB", t.signal?.snrDb != null ? String(t.signal.snrDb) : null],
		[
			"Peak dBFS",
			t.signal?.peakDbfs != null ? String(t.signal.peakDbfs) : null,
		],
		[
			"Flags",
			t.signal && t.signal.flags.length > 0 ? t.signal.flags.join(", ") : null,
		],
		[
			"File",
			audio
				? `${audio.bytes > 0 ? formatBytes(audio.bytes) : "size unknown"} · WAV`
				: null,
		],
		["Missing", t.gone.length > 0 ? t.gone.join(", ") : null],
	]
	const admission = t.admission
		? (Object.entries(t.admission) as [string, unknown][]).filter(
				([, v]) => v !== undefined,
			)
		: []
	const copy = (value: string) => {
		navigator.clipboard.writeText(value).then(
			() => showAppToast("Copied"),
			() => showAppToast("Could not copy", { tone: "warn" }),
		)
	}
	return (
		<details
			className="wkt-details"
			open={open}
			onToggle={e => {
				const next = e.currentTarget.open
				setOpen(next)
				writeDetailsOpen(next)
			}}
		>
			<summary>Details</summary>
			<dl className="wkt-ids">
				{ids
					.filter((x): x is [string, string] => x[1] !== null && x[1] !== "")
					.map(([term, value]) => (
						<div key={`${term}:${value}`} className="wkt-id-row">
							<dt>{term}</dt>
							<dd>
								<code>{value}</code>
								<button
									type="button"
									className="wkt-link"
									aria-label={`Copy ${term.toLowerCase()} id`}
									onClick={() => copy(value)}
								>
									Copy
								</button>
							</dd>
						</div>
					))}
				{facts
					.filter((x): x is [string, string] => x[1] !== null)
					.map(([term, value]) => (
						<div key={term} className="wkt-id-row">
							<dt>{term}</dt>
							<dd>{value}</dd>
						</div>
					))}
			</dl>
			{admission.length > 0 && (
				<table className="wkt-admission">
					<caption>Recording admission</caption>
					<tbody>
						{admission.map(([k, v]) => (
							<tr key={k}>
								<th scope="row">{k}</th>
								<td>{v === null ? "none" : String(v)}</td>
							</tr>
						))}
					</tbody>
				</table>
			)}
			{fileUrl !== null && (
				<a className="wkt-link" href={fileUrl} download>
					Download WAV
				</a>
			)}
			{open && (
				<JsonView
					data={JSON.parse(JSON.stringify(t.raw)) as JsonValue}
					maxHeight={240}
				/>
			)}
		</details>
	)
}
