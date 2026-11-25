import "./transmission.css"

// The Transmission view: one transmission, pushed into the drawer the user is in, in the order a listener asks
// about it: Listen; What we know (Who, Tone, Signal, Ended, Kept); its copies (Copy of / Also heard on); the Conversation, oldest first with Play all;
// the channel's doors (History, Open in Scanner, Tune); and, collapsed, the expert Details: the facts in words
// and rounded units, the important first, then, collapsed again, the Identifiers, each with a copy button. It renders only the Transmission DTO (loadTransmission); Back and Esc return to the origin in one step.
import type { JsonValue } from "@wavekit/api-types"
import { Fragment, useEffect, useMemo, useRef, useState } from "react"
import { z } from "zod"

import { useServices } from "../../app/context.ts"
import { errorMessage } from "../../data/index.ts"
import { showAppToast } from "../../shell/toast.ts"
import { Button } from "../../ui/Button.tsx"
import { Icon } from "../../ui/Icon.tsx"
import { IconButton } from "../../ui/IconButton.tsx"
import { Label } from "../../ui/Label.tsx"
import {
	SavingDisc,
	SavingWave,
	useRecordingSaving,
} from "../activity/ActivityPlayback.tsx"
import { useDisplay } from "../display.ts"
import { JsonView } from "../messages/JsonView.tsx"
import {
	historyLabel,
	protocolSpelling,
	rasterHz,
	savedNameAt,
	useSavedNames,
} from "../naming.ts"
import { KeepButton, PlayDisc, WaveView } from "../playback/PlaybackUi.tsx"
import type { QueueRef } from "../playback/service.ts"
import { RecIcon } from "../recordings/icons.tsx"
import type { RecordingIcon } from "../recordings/model.ts"
import { formatBytes, recordingIconOf } from "../recordings/model.ts"
import type { TransmissionDto, TransmissionMember } from "./contract.ts"
import { parseRef, refText } from "./contract.ts"
import { loadTransmission, TransmissionNotFoundError } from "./load.ts"
import type { OpenTransmission } from "./nav.ts"
import {
	activityLists,
	escapeGoesBack,
	followsPlayer,
	openChannelHistory,
	openInScanner,
	playingTransmission,
	replaceTransmission,
} from "./nav.ts"
import {
	admissionRows,
	alsoHeardText,
	channelText,
	codeText,
	copyOfText,
	moreCopiesText,
	CLOSE_WORDS,
	ctcssText,
	dateTimeText,
	dbfsText,
	dbText,
	durationWords,
	FINISH_CUT_WORDS,
	FLAG_WORDS,
	GONE_WORDS,
	idSegments,
	ITEM_CUT_WORDS,
	KEPT_BY_WORDS,
	measuredText,
	NO_AUDIO_WORDS,
	signalText,
	SPEECH_WORDS,
	startText,
	TONE_FROM_WORDS,
	toneRow,
	TRANSMISSION_STARTED,
	utcText,
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

/** The part of the Clipboard API Copy uses (absent on plain HTTP and in some embedded browsers). */
export interface ClipboardLike {
	writeText(text: string): Promise<void>
}

/** Copies `value` and says so in a toast either way; resolves to whether it was copied. */
export async function copyValue(
	value: string,
	clipboard: ClipboardLike | undefined = globalThis.navigator?.clipboard,
	toast: typeof showAppToast = showAppToast,
): Promise<boolean> {
	if (!clipboard) {
		toast("Could not copy: this browser blocks the clipboard here", {
			tone: "warn",
		})
		return false
	}
	try {
		await clipboard.writeText(value)
		toast("Copied")
		return true
	} catch {
		toast("Could not copy", { tone: "warn" })
		return false
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

/**
 * The header tile's icon, the one the Recordings rows use for its recording's kind (a call's voice, a scanner file's
 * scan); a digital call known only from Activity is voice. Null (no tile) when no recording kind fits: a live
 * transmission, which is no recording.
 */
export function transmissionIcon(t: TransmissionDto): RecordingIcon | null {
	if (t.recordingKind !== null) return recordingIconOf(t.recordingKind)
	if (t.kind === "voice-digital" && t.artefacts.length > 0) return "voice"
	return null
}

const KeptRecordTimes = z.object({
	kind: z.literal("recording-change"),
	payload: z.object({
		observationStartedAt: z.string().nullable(),
		finalizedAt: z.string(),
	}),
})

/**
 * The times a kept file known only from its Activity record carries (no recording read, so no start of its own):
 * its transmission's start and its keep. Null for any other transmission.
 */
export function keptRecordTimes(
	t: TransmissionDto,
): { transmissionStartedAt: string | null; keptAt: string } | null {
	if (t.startedAt !== null || t.raw.recording !== null) return null
	const r = KeptRecordTimes.safeParse(t.raw.activity)
	if (!r.success) return null
	return {
		transmissionStartedAt: r.data.payload.observationStartedAt,
		keptAt: r.data.payload.finalizedAt,
	}
}

/**
 * "What we know": at most six short rows in a fixed order; Tone always for analog FM. A kept file known only from
 * its record leads with "Transmission started" (its transmission's start, never passed off as the file's) and
 * "Kept at".
 */
export function knownRows(
	t: TransmissionDto,
): { term: string; value: string; hint: string | null }[] {
	const rows: { term: string; value: string; hint: string | null }[] = []
	const times = keptRecordTimes(t)
	if (times !== null) {
		const began = startText(times.transmissionStartedAt)
		if (began !== "")
			rows.push({ term: TRANSMISSION_STARTED, value: began, hint: null })
		const kept = startText(times.keptAt)
		if (kept !== "") rows.push({ term: "Kept at", value: kept, hint: null })
	}
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

/** Play all's queue: the Conversation's, each part playing on into the next whatever Auto-next says. */
export function playAllQueue(queue: QueueRef): QueueRef {
	return { ...queue, playAll: true }
}

/**
 * Whether a load may answer from the cache: only when the view follows the player, and not after a Retry until a
 * load succeeds (then the player's later steps use the cache again).
 */
export function retryGate(): {
	cached: (follow: boolean | undefined) => boolean
	retry: () => void
	loaded: () => void
} {
	let fresh = false
	return {
		cached: follow => follow === true && !fresh,
		retry: () => {
			fresh = true
		},
		loaded: () => {
			fresh = false
		},
	}
}

type LoadState =
	| { status: "loading" }
	| { status: "ready"; t: TransmissionDto }
	| { status: "missing"; reason: string }
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
	const gate = useRef(retryGate()).current
	const back = useRef<HTMLButtonElement>(null)
	const view = useRef<HTMLElement>(null)
	const key = refText(open.ref)
	// the ref's text is its identity; the summary only seeds the first read
	const opened = useRef(open)
	opened.current = open
	const onBackRef = useRef(onBack)
	onBackRef.current = onBack

	// focus on Back when it opens, never when the player moves it on (focus stays where the user has it); a clicked
	// Conversation row gives it to Back itself (that row turns disabled as the current one)
	useEffect(() => back.current?.focus({ preventScroll: true }), [])
	const focusBack = () => back.current?.focus({ preventScroll: true })

	// Esc anywhere in the drawer (or on the drawer box, or the page after a lost focus) goes Back, before the
	// shell's Esc closes the drawer: a capture-phase hook, not the section's own handler
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			const el = view.current
			if (
				!escapeGoesBack({
					key: e.key,
					defaultPrevented: e.defaultPrevented,
					target: e.target instanceof Node ? e.target : null,
					view: el,
					host: el?.closest(".wk-drawer") ?? null,
				})
			)
				return
			e.preventDefault()
			e.stopPropagation()
			onBackRef.current()
		}
		window.addEventListener("keydown", onKey, true)
		return () => window.removeEventListener("keydown", onKey, true)
	}, [])

	useEffect(() => {
		const abort = new AbortController()
		setState({ status: "loading" })
		loadTransmission(opened.current.ref, {
			api: data.api,
			recordings: () => data.recordings.get().items,
			summary: opened.current.summary,
			signal: abort.signal,
			cached: gate.cached(opened.current.follow),
		}).then(
			t => {
				if (abort.signal.aborted) return
				gate.loaded()
				setState({ status: "ready", t })
			},
			(e: unknown) => {
				if (abort.signal.aborted) return
				setState(
					e instanceof TransmissionNotFoundError
						? { status: "missing", reason: e.reason }
						: { status: "error", error: errorMessage(e) },
				)
			},
		)
		return () => abort.abort()
	}, [data, key, attempt])

	const host = open.origin.host
	const audioId =
		state.status === "ready" ? (state.t.artefacts[0]?.id ?? null) : null

	// the player's Next, Prev, Auto-next or Play all moved on from the recording shown here: the view follows
	// (its content replaced, its origin kept)
	const shown = useRef(audioId)
	shown.current = audioId
	useEffect(() => {
		let before = playback.get().id
		return playback.subscribe(s => {
			const was = before
			before = s.id
			if (!followsPlayer(shown.current, was, s.id)) return
			const next = playingTransmission(s, activityLists(services.activity))
			if (next !== null) replaceTransmission(next.ref, next.summary, true)
		})
	}, [playback, services.activity])

	return (
		<section ref={view} className="wkt-view" aria-label="Transmission">
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
					<KeepButton
						id={audioId}
						title={transmissionHeading(state.t)}
						kept={state.t.artefacts[0]?.kept ?? null}
					/>
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
						Not found: {state.reason}.
					</p>
				)}
				{state.status === "error" && (
					<p className="wkt-note" data-tone="warn" role="status">
						Could not load this transmission: {state.error}{" "}
						<button
							type="button"
							className="wkt-link"
							onClick={() => {
								gate.retry()
								setAttempt(n => n + 1)
							}}
						>
							Retry
						</button>
					</p>
				)}
				{state.status === "ready" && (
					<Ready t={state.t} host={host} onPicked={focusBack} />
				)}
			</div>
		</section>
	)
}

function Ready({
	t,
	host,
	onPicked,
}: {
	t: TransmissionDto
	host: "recordings" | "activity"
	/** A Conversation row was picked: focus goes to Back (that row turns disabled). */
	onPicked: () => void
}) {
	const services = useServices()
	const title = transmissionHeading(t)
	const audio = t.artefacts.find(a => a.kind === "audio") ?? null
	const saving = useRecordingSaving(audio?.id ?? null)
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
	const icon = transmissionIcon(t)
	return (
		<>
			<header className="wkt-head">
				{icon !== null && (
					<span className="wk-tile" data-tone="accent" aria-hidden="true">
						<RecIcon name={icon} />
					</span>
				)}
				<span className="wkt-head-main">
					<span className="wkt-head-line">
						<h3 className="wkt-title">{title}</h3>
						<span className="wkt-gap" />
						{startText(t.startedAt) !== "" && (
							<time className="wkt-time" dateTime={t.startedAt ?? undefined}>
								{startText(t.startedAt)}
							</time>
						)}
					</span>
					<span className="wkt-head-line wkt-sub">
						<span>{sub}</span>
						<span className="wkt-gap" />
						<span>{durationWords(t.durationMs) ?? ""}</span>
					</span>
				</span>
			</header>

			<section className="wkt-listen" aria-label="Listen">
				{audio !== null && saving ? (
					<div className="wkt-listen-row">
						<SavingDisc />
						{/* the waveform's height, held: the swap to Play moves nothing */}
						<SavingWave />
					</div>
				) : audio !== null ? (
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

			{t.copy != null && <Copies copy={t.copy} onPicked={onPicked} />}

			{t.group !== null && (
				<Conversation
					t={t}
					queue={queue}
					self={audio?.id ?? null}
					onPicked={onPicked}
				/>
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
	onPicked,
}: {
	t: TransmissionDto
	queue: QueueRef | null
	self: string | null
	onPicked: () => void
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
								playAllQueue(queue),
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
									if (ref === null) return
									replaceTransmission(ref)
									onPicked()
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

/**
 * Copies (ghosts: the same audio heard again on another frequency, kept on disk): a copy links to its original
 * ("Copy of 156.8 MHz"), an original lists its copies ("Also heard on 156.9137 MHz (copy)"). Each opens that
 * recording's view in place; Back still goes to the origin.
 */
export function Copies({
	copy,
	onPicked,
}: {
	copy: NonNullable<TransmissionDto["copy"]>
	onPicked: () => void
}) {
	const open = (key: string) => {
		replaceTransmission({ recording: key })
		onPicked()
	}
	const more = moreCopiesText(copy.copiesTotal, copy.copies.length)
	const of = copy.of
	return (
		<section aria-label="Copies" className="wkt-copies">
			{of !== null && (
				<p className="wkt-line">
					<button
						type="button"
						className="wkt-link"
						title="The same audio, heard first on another frequency: open it"
						onClick={() => open(of.recordingKey)}
					>
						{copyOfText(of.hz)}
					</button>
				</p>
			)}
			{copy.copies.length > 0 && (
				<ul className="wkt-copy-list">
					{copy.copies.map(c => (
						<li key={c.recordingKey}>
							<button
								type="button"
								className="wkt-link"
								title="The same audio heard again there (a receiver ghost): open it"
								onClick={() => open(c.recordingKey)}
							>
								{alsoHeardText(c.hz)}
							</button>
						</li>
					))}
				</ul>
			)}
			{more !== null && <p className="wkt-hint">{more}</p>}
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
						onClick={() => openChannelHistory(services.activity, hz)}
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

/** One fact of Details: its value, and (for a time) the same instant in UTC under it and in its tooltip. */
export interface DetailFact {
	term: string
	value: string
	hint: string | null
	/** A time's ISO instant (the <time> element's dateTime). */
	iso: string | null
}

function timeFact(term: string, iso: string | null): DetailFact | null {
	const value = dateTimeText(iso)
	if (value === "" || iso === null) return null
	const utc = utcText(iso)
	// on the UTC clock (Settings › Display) the value already is UTC: no second line
	return { term, value, hint: value.endsWith("Z") ? null : utc, iso }
}

function fact(
	term: string,
	value: string | null,
	hint: string | null = null,
): DetailFact | null {
	return value === null || value === ""
		? null
		: { term, value, hint, iso: null }
}

/**
 * Details' facts, the important first (when, where, how long, speech, tone, why kept, copy of), then how it
 * ended, the signal and the file: every code as words (its readable form when no sentence is known), dB to one
 * decimal, frequencies in MHz, times local with UTC under them. Ids are not here: detailIds.
 */
export function detailFacts(
	t: TransmissionDto,
	fileBytes: number | null = null,
): DetailFact[] {
	const hz = t.channel.hz
	const ended = codeText(t.close?.reason, FINISH_CUT_WORDS, CLOSE_WORDS)
	const cut = codeText(t.verdict.itemCut, ITEM_CUT_WORDS)
	const tone = t.tone !== null ? toneRow(t.tone) : null
	const copies = t.copy?.copiesTotal ?? 0
	const facts: (DetailFact | null)[] = [
		timeFact("Started", t.startedAt),
		timeFact("Ended", t.endedAt),
		fact("Channel", channelText(hz)),
		fact(
			"Measured",
			t.channel.measuredHz !== null
				? measuredText(t.channel.measuredHz, hz !== null ? rasterHz(hz) : null)
				: null,
			t.channel.measuredHz !== null && hz !== null
				? "offset from the channel"
				: null,
		),
		fact(
			"Duration",
			durationWords(t.durationMs),
			t.part ? `Part ${t.part.index} of ${t.part.of}` : null,
		),
		fact("Speech", codeText(t.verdict.speech, SPEECH_WORDS)),
		tone === null
			? null
			: fact(
					"Tone",
					tone.value,
					tone.hint ?? wordsFor(TONE_FROM_WORDS, t.tone?.from),
				),
		fact("Why kept", codeText(t.verdict.keptBy, KEPT_BY_WORDS)),
		fact("Copy of", t.copy?.of ? copyOfText(t.copy.of.hz) : null),
		fact(
			"Copies",
			copies > 0
				? `${copies} on other ${copies === 1 ? "frequency" : "frequencies"}`
				: null,
		),
		fact("How it ended", ended ?? cut),
		fact("Cut", ended !== null && cut !== null && cut !== ended ? cut : null),
		fact(
			"Signal",
			dbText(t.signal?.snrDb),
			t.signal?.snrDb != null ? "over the noise" : null,
		),
		fact("Peak level", dbfsText(t.signal?.peakDbfs)),
		fact(
			"Flags",
			t.signal && t.signal.flags.length > 0
				? t.signal.flags.map(f => codeText(f, FLAG_WORDS)).join(" · ")
				: null,
		),
		fact(
			"File",
			fileBytes !== null
				? `${fileBytes > 0 ? formatBytes(fileBytes) : "size unknown"} · WAV`
				: null,
		),
		fact(
			"No longer readable",
			t.gone.length > 0
				? t.gone.map(g => codeText(g, GONE_WORDS)).join(", ")
				: null,
		),
	]
	return facts.filter((f): f is DetailFact => f !== null)
}

/** Details' identifiers, in a fixed order: every id the transmission is known by, for copying. */
export function detailIds(
	t: TransmissionDto,
): { term: string; value: string }[] {
	const ids: [string, string | null][] = [
		["Transmission", t.id],
		...t.refs.recordingKeys.map((k): [string, string] => ["Recording key", k]),
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
	return ids
		.filter((x): x is [string, string] => x[1] !== null && x[1] !== "")
		.map(([term, value]) => ({ term, value }))
}

/** An id that wraps only between its tokens (idSegments). */
function IdText({ value }: { value: string }) {
	const parts = idSegments(value)
	return (
		<code className="wkt-id">
			{parts.map((p, i) => (
				<Fragment key={i}>
					{p}
					{i < parts.length - 1 && <wbr />}
				</Fragment>
			))}
		</code>
	)
}

/** The expert Details: facts in words, then the collapsed Identifiers, the file and the stored JSON. */
export function Details({
	t,
	fileUrl,
}: {
	t: TransmissionDto
	fileUrl: string | null
}) {
	const [open, setOpen] = useState(readDetailsOpen)
	const audio = t.artefacts.find(a => a.kind === "audio") ?? null
	const facts = detailFacts(t, audio ? audio.bytes : null)
	const ids = detailIds(t)
	const admission = admissionRows(
		t.admission as Readonly<Record<string, unknown>> | null,
	)
	const copy = (value: string) => void copyValue(value)
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
			<dl className="wkt-facts">
				{facts.map(f => (
					<div key={f.term} className="wkt-fact-row">
						<dt>{f.term}</dt>
						<dd>
							{f.iso !== null ? (
								<time dateTime={f.iso} title={utcText(f.iso)}>
									{f.value}
								</time>
							) : (
								<span>{f.value}</span>
							)}
							{f.hint !== null && <span className="wkt-hint">{f.hint}</span>}
						</dd>
					</div>
				))}
			</dl>
			{admission.length > 0 && (
				<section aria-label="How the recorder decided">
					<p className="wkt-sublabel">How the recorder decided</p>
					<dl className="wkt-facts">
						{admission.map(r => (
							<div key={r.term} className="wkt-fact-row">
								<dt>{r.term}</dt>
								<dd>
									<span>{r.value}</span>
								</dd>
							</div>
						))}
					</dl>
				</section>
			)}
			{ids.length > 0 && (
				<details className="wkt-idents">
					<summary>Identifiers · {ids.length}</summary>
					<dl className="wkt-ids">
						{ids.map(({ term, value }) => (
							<div key={`${term}:${value}`} className="wkt-id-row">
								<dt>{term}</dt>
								<dd>
									<IdText value={value} />
								</dd>
								<IconButton
									label={`Copy ${term.toLowerCase()}`}
									title="Copy"
									size="xs"
									className="wkt-copy"
									onClick={() => copy(value)}
								>
									<Icon name="copy" />
								</IconButton>
							</div>
						))}
					</dl>
				</details>
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
