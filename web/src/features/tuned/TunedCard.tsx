// The tuned card (docs/web/canvas/Tuned.dc.html, TunedGallery, Identify; DESIGN.md "Tuned card reworked"):
// header (type tile that drags the card, what it is: the protocol heard, else the decoder whose band holds the frequency
// (GET /api/decoders/summary?hz=), what Identify named, the band; state, the frequency once, signal bars, minimise) → the "now" block
// (what was last heard on the channel, by kind: call, transmission, count, message, audio; or band and channel when
// nothing was, or Identify while it runs) → up to two earlier rows → the table of decoders whose band holds the
// frequency, with the core's verdict and at most one action each (BandDecoders.tsx) → actions (Map, Activity, Save, ⋯ with Identify,
// Decode as…, Pin, Copy). A message opens in full as the decoded message card (Decode board) inside the card, in a
// scrolling well; Decode as… is Identify cut to one protocol. Identify never moves the receiver. While a sweep moves the receiver the card hides (the Tuner's hold
// row says where it is); on a hit it is that signal's card, "Held by the scan". A pinned card keeps its frequency.
// Identified, the card becomes that signal's card (a banner, what was heard, Save and Open in Scanner) and keeps its
// name (this session's answer, else what any browser identified there: WG12 nearHz); a transmission on a frequency nothing decodes is identified on its own (auto-identify.ts).
import { WaveKitIcon } from "@wavekit/brand/react"
import type { ScannerProtocol } from "@wavekit/api-types"
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react"

import { useReadOnly, useServices } from "../../app/context.ts"
import {
	bandAt,
	channelAt,
	inputOf,
	isIdentifyFinal,
	knownAt,
	useStore,
} from "../../data/index.ts"
import { CardHandle } from "../../shell/CardHandle.tsx"
import { useDevicePrefs } from "../../shell/hooks.ts"
import { shellStore } from "../../shell/store.ts"
import { showAppToast } from "../../shell/toast.ts"
import { Button } from "../../ui/Button.tsx"
import { Icon, type IconName } from "../../ui/Icon.tsx"
import { IconButton } from "../../ui/IconButton.tsx"
import { Island } from "../../ui/Island.tsx"
import { Label } from "../../ui/Label.tsx"
import { Switch } from "../../ui/Switch.tsx"
import { ActionMenu, type ActionMenuItem } from "../ActionMenu.tsx"
import { formatDb, formatMHz, formatWidth } from "../format.ts"
import { useLiveStatus, useNow, useSettledHz } from "../hooks.ts"
import { showOnMap } from "../map/focus.ts"
import { messageView } from "../messages/card.ts"
import { useActivityRecord } from "../messages/record.ts"
import { groupName } from "../tuner/band.ts"
import { modeSpec, modulationOf } from "../tuner/modes.ts"
import { defaultGroup, defaultSaveName, saveInput } from "../tuner/saved.ts"
import { sweepMoving } from "../tuner/scan-hold.ts"
import { useHeld, useSweep } from "../tuner/ScanHoldRow.tsx"
import { BandDecoders } from "./BandDecoders.tsx"
import { planRangesOf } from "./band-decoders.ts"
import {
	bandStateLine,
	bandTable,
	cardIdentity,
	DATA_BAND_LINE,
	decodersLine,
	skipLine,
} from "./band-table.ts"
import { decodersHere, decodersOnChannel } from "./decoders.ts"
import {
	DECODE_AS,
	discoveryCard,
	identifiedCard,
	identifyView,
	type IdentifiedCard,
	type IdentifyView,
} from "./identify-view.ts"
import { clockText, useDisplay } from "../display.ts"
import { openDiscovery } from "../scanner/ui-store.ts"
import { AUTO_IDENTIFY_DELAY_MS, shouldAutoIdentify } from "./auto-identify.ts"
import { nowView, type NowView } from "./now.ts"
import { tunedCardStore } from "./place.ts"
import { signalBars, signalPresent } from "./signal.ts"
import { DecoderVerdictsFeed, itemsFor, pendingFor } from "./verdicts.ts"

/** The header reads states only: no action context. */
const NO_ACTIONS = { scanJobId: null, budget: null } as const

// the card's own chunk stays small: the full card (and its JSON viewer) loads when a message is first opened
const MessageCard = lazy(() =>
	import("../messages/MessageCard.tsx").then(m => ({ default: m.MessageCard })),
)

function IdentifyBlock({
	view,
	onClose,
	untilSignal,
	onUntilSignal,
	readOnly,
}: {
	view: IdentifyView
	onClose: () => void
	untilSignal: boolean
	onUntilSignal: (on: boolean) => void
	readOnly: boolean
}) {
	const closeLabel = view.running ? "Stop identifying" : "Close"
	return (
		<div className="wkf-id">
			<div className="wkf-id-eyebrow">
				<Label className="wkf-grow">{view.eyebrow}</Label>
				<IconButton
					size="xs"
					label={closeLabel}
					title={closeLabel}
					className="wkf-quiet-btn"
					onClick={onClose}
				>
					<Icon name="close" size={13} />
				</IconButton>
			</div>
			<div className="wkf-id-titlerow">
				<p
					role="status"
					aria-live="polite"
					className="wkf-id-title"
					data-big={view.big || undefined}
					data-phase={view.phase}
				>
					<span>{view.title}</span>
					{view.secs && (
						<span aria-hidden="true" className="wkf-id-secs">
							{view.secs}
						</span>
					)}
				</p>
				{view.reason && (
					<span className="wk-tag" data-size="md" data-variant="outline">
						{view.reason}
					</span>
				)}
			</div>
			{view.bar && (
				<div
					role="progressbar"
					aria-label="Time left to listen"
					aria-valuemin={0}
					aria-valuemax={view.bar.windowS}
					aria-valuenow={view.bar.leftS}
					aria-valuetext={`${view.bar.leftS} seconds left`}
					className="wkf-id-bar"
				>
					<div style={{ transform: `scaleX(${view.bar.fraction})` }} />
				</div>
			)}
			{view.line && <span className="wkf-id-line">{view.line}</span>}
			{view.untilSignal && (
				<label
					className="wkf-id-wait"
					title="The receiver waits for the next transmission and tries it. If none comes, it keeps waiting until you stop."
				>
					<span className="wkf-grow">Wait until a transmission</span>
					<Switch
						checked={untilSignal}
						disabled={readOnly}
						aria-label="Wait until a transmission"
						onChange={onUntilSignal}
					/>
				</label>
			)}
			{view.trials.length > 0 && (
				<ol aria-label="Decoders tried" className="wkf-id-trials">
					{view.trials.map(r => (
						<li key={r.key} title={r.title} data-tone={r.tone}>
							<span className="wkf-id-ic" aria-hidden="true" />
							<b>{r.protocol}</b>
							<span className="wkf-id-dec">· {r.decoder}</span>
							{r.tag ? (
								<span className="wk-tag" data-variant="outline">
									{r.word}
								</span>
							) : (
								<span className="wkf-id-word">{r.word}</span>
							)}
						</li>
					))}
				</ol>
			)}
			{view.measured && (
				<span className="wkf-id-measured">
					<span className="wkf-quiet">Measured</span> {view.measured}
				</span>
			)}
			{view.note && <span className="wkf-id-note">{view.note}</span>}
		</div>
	)
}

/** Identified (Tuned.dc.html): a banner over what the signal is, the trials folded away. */
function IdentifiedBlock({
	found,
	line,
	onClose,
}: {
	found: IdentifiedCard
	line: string
	onClose: () => void
}) {
	return (
		<>
			<div role="status" aria-live="polite" className="wkf-id-banner">
				<Icon name="check" size={14} />
				<span className="wkf-grow wkf-ellipsis">{found.banner}</span>
				<IconButton
					size="xs"
					label="Dismiss"
					title="Dismiss"
					className="wkf-quiet-btn"
					onClick={onClose}
				>
					<Icon name="close" size={13} />
				</IconButton>
			</div>
			{found.big !== null && (
				<div className="wkf-big-row">
					<span className="wkf-big">{found.big}</span>
				</div>
			)}
			{found.line && <span className="wkf-line">{found.line}</span>}
			<span className="wkf-line">{line}</span>
			{found.measured && (
				<span className="wkf-id-measured">
					<span className="wkf-quiet">Measured</span> {found.measured}
				</span>
			)}
		</>
	)
}

function NowBlock({ now }: { now: NowView }) {
	const msg = now.kind === "msg"
	return (
		<>
			{now.eyebrow && <Label>{now.eyebrow}</Label>}
			{msg && now.title && <span className="wkf-now-title">{now.title}</span>}
			{now.big !== null && (
				<div className="wkf-big-row">
					{now.locked && (
						<Icon
							name="lock"
							size={18}
							className="wkf-lock"
							role="img"
							aria-hidden={undefined}
							aria-label="Encrypted"
						/>
					)}
					<span
						className="wkf-big"
						data-count={now.kind === "count" || undefined}
					>
						{now.big}
					</span>
					{now.bigUnit && <span className="wkf-big-unit">{now.bigUnit}</span>}
				</div>
			)}
			{now.line && <span className="wkf-line">{now.line}</span>}
			{now.body && (
				<p
					className="wkf-now-body"
					data-msg={msg || undefined}
					data-mono={now.mono || undefined}
					data-quote={now.quote || undefined}
				>
					{now.body}
				</p>
			)}
			{now.chips.length > 0 && (
				<div className="wkf-now-chips">
					{now.chips.map(c => (
						<span key={`${c.k}:${c.v}`} className="wkf-now-chip">
							{c.k && <span className="wkf-quiet">{c.k}</span>} {c.v}
						</span>
					))}
				</div>
			)}
			{now.rateBars && (
				<div className="wkf-rate">
					<div className="wkf-rate-bars" aria-hidden="true">
						{now.rateBars.map((h, i) => (
							<span
								key={i}
								style={{ height: `${Math.max(8, Math.round(h * 100))}%` }}
								data-last={i === now.rateBars!.length - 1 || undefined}
							/>
						))}
					</div>
					<span className="wkf-rate-text">{now.rate}</span>
				</div>
			)}
		</>
	)
}

/** The fleet a card shows a count for, from the decoders on its channel. */
function fleetHere(types: readonly string[]): "aircraft" | "vessels" | null {
	if (types.some(t => t === "readsb" || t === "dump1090")) return "aircraft"
	if (types.includes("ais-catcher")) return "vessels"
	return null
}

export function TunedCard() {
	useDisplay() // times and units follow Settings › Display
	const services = useServices()
	const { data, decoders: feed, activity, tuning, tuned } = services
	const readOnly = useReadOnly()
	const device = useDevicePrefs()
	const settledHz = useSettledHz()
	const sweep = useSweep()
	const sweepState = sweep?.state
	// on a hit, the card is that signal's card (live audio follows the scan there)
	const { heldHz, held } = useHeld(sweep)
	const tunedNow =
		sweepState === "holding"
			? (heldHz ?? held?.frequencyHz ?? settledHz)
			: settledHz
	const card = useStore(tunedCardStore)
	const pinned = card.pinnedHz
	// a pinned card keeps its frequency when you tune away
	const hz = pinned ?? tunedNow
	const onIt = pinned === null || pinned === tunedNow
	const status = useLiveStatus()
	const view = useStore(data.bandplan, s => s.view)
	// the core's band plans: which decoders without a band of their own cover the frequency while statuses stand in
	const plans = useStore(data.scanner, s => s.bandplans)
	const planRanges = useMemo(() => planRangesOf(plans), [plans])
	const level = useStore(data.liveAudio, s => s.level)
	const decoders = useStore(feed, s => s.decoders)
	const savedState = useStore(data.savedFrequencies)
	const id = useStore(data.identify)
	const running =
		id.starting || (id.job !== null && !isIdentifyFinal(id.event?.state))
	const tick = useNow(running, 250)
	const clock = useNow(true, 1000)
	const [menu, setMenu] = useState<false | "more" | "decode">(false)
	// the message opened in full (its event id): closes when another message arrives or the card retunes
	const [fullId, setFullId] = useState<string | null>(null)
	const moreRef = useRef<HTMLButtonElement>(null)
	const lineRef = useRef<HTMLButtonElement>(null)
	const chevRef = useRef<HTMLButtonElement>(null)
	const focusAfterMin = useRef<boolean | null>(null)
	// the frequency the card last identified on its own; cleared when the receiver leaves it
	const autoTried = useRef<number | null>(null)

	const bw = status?.config.bandwidth || 12_500
	const tolerance = Math.max(bw / 2, 3000)
	// the core's verdicts for this frequency: which decoders' bands hold it (header and "On this band")
	const verdictFeed = useMemo(() => new DecoderVerdictsFeed(data), [data])
	useEffect(() => verdictFeed.attach(), [verdictFeed])
	useEffect(() => verdictFeed.follow(hz), [verdictFeed, hz])
	const verdictState = useStore(verdictFeed)
	const summaryItems = hz === null ? [] : itemsFor(verdictState, hz)
	// the read for a new frequency is on its way: nothing is claimed about its decoders yet
	const pending = hz !== null && pendingFor(verdictState, hz)
	useEffect(() => {
		void data.scanner.loadBandplans()
	}, [data])
	const bandRows =
		hz === null
			? []
			: bandTable(summaryItems, decoders, hz, NO_ACTIONS, clock, planRanges)
	// the decoders whose band holds the frequency (never one whose channel only follows the tuner)
	const here =
		hz === null
			? []
			: decodersHere(decoders, new Set(bandRows.map(r => r.id)), hz)
	// of those, the ones on the tuned channel itself (a fixed target within the channel): what decodes this signal
	const onChannel = hz === null ? [] : decodersOnChannel(here, hz, tolerance)
	const types = here.map(d => d.type)
	const fleet = fleetHere(types)

	// the channel's Activity, once the frequency settles
	useEffect(() => {
		tuned.follow(hz === null ? null : { hz, toleranceHz: tolerance })
	}, [tuned, hz, tolerance])
	// what any browser identified here before (WG12 nearHz); older cores answer nothing
	const nearStore = data.nearDiscovery
	useEffect(() => {
		nearStore.follow(hz, tolerance)
	}, [nearStore, hz, tolerance])
	const near = useStore(nearStore, s => (s.hz === hz ? s.discovery : null))
	const span = useStore(tuned.span)
	const items = useStore(tuned.feed, s => s.items)
	const fresh = span !== null && span.hz === hz
	// the opened message stays while the channel's list still holds it
	const fullItem =
		fullId !== null && fresh
			? (items.find(i => i.eventId === fullId) ?? null)
			: null
	const fullRecord = useActivityRecord(fullItem ? fullItem.eventId : null)
	useEffect(() => setFullId(null), [hz])

	// vessels or aircraft in range: the fleet store attaches only while the card counts them
	const fleetStore =
		fleet === "aircraft"
			? data.fleets.aircraft
			: fleet === "vessels"
				? data.fleets.vessels
				: null
	useEffect(() => fleetStore?.attach(), [fleetStore])
	const aircraftN = useStore(data.fleets.aircraft, s => s.entries.size)
	const vesselsN = useStore(data.fleets.vessels, s => s.entries.size)
	const fleetN =
		fleet === "aircraft" ? aircraftN : fleet === "vessels" ? vesselsN : null

	// keep focus on the control after the header swaps between the line and the chevron
	useEffect(() => {
		const want = focusAfterMin.current
		if (want === null || want !== card.minimised) return
		focusAfterMin.current = null
		;(want ? lineRef : chevRef).current?.focus({ preventScroll: true })
	}, [card.minimised])

	const startIdentify = (
		protocols: readonly ScannerProtocol[] = [],
		auto = false,
	) => {
		if (hz === null || readOnly) return
		if (!onIt) void tuning.tune(hz)
		const opts = {
			...(status && status.config.bandwidth > 0
				? { bandwidthHz: status.config.bandwidth }
				: {}),
			...(protocols.length > 0 ? { protocols: [...protocols] } : {}),
			...(auto ? { auto: true } : {}),
		}
		setFullId(null)
		data.identify.start(hz, opts).catch(() => undefined)
	}
	const closeIdentify = () => data.identify.reset()

	// `I` identifies the tuned signal (DESIGN.md: identify from the card, a right-click, ⌘K or I)
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return
			if (e.key !== "i" && e.key !== "I") return
			const t = e.target
			if (
				t instanceof HTMLElement &&
				(t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))
			)
				return
			e.preventDefault()
			startIdentify()
		}
		document.addEventListener("keydown", onKey)
		return () => document.removeEventListener("keydown", onKey)
	})

	// a transmission on a frequency nothing decodes: identify it on its own, once per visit
	const heldByScan = sweepState === "holding" && onIt
	const live = onIt && status?.running === true && level !== null
	const present = live ? signalPresent(level) : false
	const squelchOpen = present === true
	const session = hz === null ? null : knownAt(id.known, hz, tolerance)
	const nearCard = near ? discoveryCard(near) : null
	// this session's answer first, else the core's proven discovery
	const known = session
		? { card: identifiedCard(session.result), at: session.at }
		: near && nearCard
			? { card: nearCard, at: near.proof?.at ?? near.lastSeenAt }
			: null
	if (autoTried.current !== null && autoTried.current !== hz)
		autoTried.current = null
	const autoNow =
		hz !== null &&
		!sweepMoving(sweepState) &&
		shouldAutoIdentify({
			enabled: device.autoIdentify,
			readOnly,
			onIt,
			heldByScan,
			transmitting: squelchOpen,
			// channel-level: a band that only spans the frequency does not say what this carrier is;
			// while the core's answer for this frequency is on its way, it may yet name a decoder
			decodersHere: pending ? Math.max(1, onChannel.length) : onChannel.length,
			identifyShown: id.targetHz !== null,
			known: known !== null,
			triedHz: autoTried.current,
			hz,
		})
	useEffect(() => {
		if (!autoNow || hz === null) return
		const t = setTimeout(() => {
			autoTried.current = hz
			startIdentify([], true)
		}, AUTO_IDENTIFY_DELAY_MS)
		return () => clearTimeout(t)
		// startIdentify reads this render's state; the timer restarts only when the decision or frequency changes
	}, [autoNow, hz])

	if (sweepMoving(sweepState) && pinned === null) return null

	if (hz === null)
		return (
			<Island
				className="wk-shell-card wkf-card"
				role="region"
				aria-label="Tuned signal"
			>
				<Label>Tuned</Label>
				<span className="wkf-quiet">Waiting for the receiver…</span>
			</Island>
		)

	const band = bandAt(view, hz)
	const channel = channelAt(band, hz)
	const active = here.filter(d => d.running && !d.suspended)
	const idView = identifyView(id, tick)
	const idHere =
		idView.phase !== "idle" &&
		(id.targetHz === null || Math.abs(id.targetHz - hz) <= tolerance)
	const found = idHere ? idView.found : null
	// what Identify named here this session: the card keeps that name after the banner is dismissed
	const named = found ?? known?.card ?? null
	// proven but not named ("Digital, not decoded (tried DMR, dPMR)", "Carrier only")
	const heardBefore = !named && near?.proof ? near.proof.summary : null

	const now = nowView({
		items: fresh ? items : [],
		decoderTypes: types,
		modulation: onIt ? (status?.config.modulation ?? null) : null,
		channelName: channel?.name ?? null,
		bandMode: modulationOf(band?.band.mode),
		hz,
		count: fleet && fleetN !== null ? { fleet, n: fleetN } : null,
		live: squelchOpen,
		now: clock,
	})
	const voice = now.kind === "call" || now.kind === "tx"

	const mode = status ? modeSpec(status.config.modulation) : null
	const bandMode = modulationOf(band?.band.mode)
	// a data band (the plan's mode is RAW: decoders only) or a RAW receiver has no audio to be quiet or loud
	const noAudio =
		bandMode === "raw" || (onIt && status?.config.modulation === "raw")
	const bandSays =
		bandMode !== null && mode !== null && bandMode !== status?.config.modulation
	const notLive =
		here.length === 0 && !pending
			? "No decoder runs on this frequency, so nothing here is decoded live."
			: ""
	// "Decoded here by" names only decoders on this channel; one whose band merely spans it decodes elsewhere
	const coverLine = decodersLine(bandRows, new Set(onChannel.map(d => d.id)))
	// a data band the plan leaves to another decoder (ADS-B: "Decoded elsewhere · readsb") says so
	const skipReason = skipLine(bandMode, band?.band.skip)
	const plainLine =
		coverLine ??
		(pending
			? "Checking which decoders cover this frequency…"
			: named && known
				? `Identified as ${named.proto} at ${clockText(known.at)}. ${notLive}`
				: heardBefore
					? `Heard before: ${heardBefore}. ${notLive}`
					: (skipReason ??
						(bandSays && !noAudio
							? `Nothing decodes this frequency. The band plan says ${modeSpec(bandMode).label}.`
							: "Nothing decodes this frequency. Identify finds out what it is.")))
	const { proto, sub: protoSub } = cardIdentity({
		heard: now.protocol,
		named: named ? { proto: named.proto, sub: named.sub } : null,
		rows: bandRows,
		band: band?.band.name ?? null,
		channel: channel?.name ?? null,
		modeLabel: mode?.label ?? null,
	})
	const snr =
		live && level.channelPowerDbfs !== null && level.noiseFloorDbfs !== null
			? level.channelPowerDbfs - level.noiseFloorDbfs
			: null
	const bars = signalBars(snr)
	const levelTitle = live
		? `Signal ${level.channelPowerDbfs === null ? "unknown" : `${formatDb(level.channelPowerDbfs)} dBFS`}${snr === null ? "" : ` · SNR ${Math.round(snr)} dB`}`
		: onIt
			? "Signal level shows while listening"
			: "Pinned. Tune to it for the signal level."
	const idRunning = idHere && idView.running
	// on after "Nothing heard": listen again straight away, this time until a transmission comes
	const setUntilSignal = (on: boolean) => {
		data.identify.setUntilSignal(on)
		if (on && !idRunning && idHere) startIdentify(id.protocols)
	}
	const stateText = idRunning
		? "Identifying"
		: heldByScan
			? "Held by the scan"
			: !onIt
				? (now.quiet ?? "Pinned · not tuned")
				: squelchOpen && voice
					? now.kind === "call"
						? "Call in progress"
						: "Transmitting"
					: now.quiet && !(squelchOpen && now.kind === "plain")
						? now.quiet
						: (bandStateLine(bandRows) ??
							(noAudio
								? DATA_BAND_LINE
								: squelchOpen
									? "Signal present"
									: live
										? present === null
											? "Squelch off"
											: "Quiet"
										: "Not decoded here"))
	const liveState = idRunning || heldByScan || (onIt && squelchOpen)
	const stateTone = liveState
		? "accent"
		: now.locked
			? "amber"
			: active.length && onIt
				? "accent"
				: "quiet"
	const icon = now.latest ? messageView(now.latest).icon : null
	const tileLive = onIt && (active.length > 0 || squelchOpen)
	const tileIcon: IconName = active.length
		? "activity"
		: status?.running
			? "headphones"
			: "scanner"
	const tile = (
		<span
			className="wkf-tile"
			data-live={tileLive || undefined}
			aria-hidden="true"
		>
			{icon ? (
				<WaveKitIcon name={icon} size={18} />
			) : (
				<Icon name={tileIcon} size={18} />
			)}
		</span>
	)

	// ---- actions (Tuned.dc.html: the card's own row; Identify and Pin in ⋯ except for unknown signals)
	const savedHere =
		savedState.items.find(f => Math.abs(f.frequencyHz - hz) < 1) ?? null
	const canSave = savedState.status === "ready" && !readOnly
	const toggleSave = () => {
		if (!canSave) return
		if (savedHere) {
			const back = inputOf(savedHere)
			data.savedFrequencies.remove(savedHere.id).then(
				() =>
					showAppToast(`Removed ${savedHere.name}`, {
						undo: () =>
							void data.savedFrequencies.create(back).catch(() => undefined),
					}),
				() => undefined,
			)
			return
		}
		const input = saveInput(
			{
				hz,
				config: onIt ? (status?.config ?? null) : null,
				bandMode,
			},
			defaultSaveName(hz, channel?.name, band?.band.name),
			defaultGroup(band?.band.group),
		)
		data.savedFrequencies.create(input).then(
			created =>
				showAppToast(`Saved ${created.name}`, {
					undo: () =>
						void data.savedFrequencies
							.remove(created.id)
							.catch(() => undefined),
				}),
			() => undefined,
		)
	}
	const saveTitle = !canSave
		? savedState.status === "unavailable"
			? "Saved frequencies need the core's operator data (protected mode)"
			: readOnly
				? "Read-only access"
				: "Saved frequencies are loading"
		: savedHere
			? `Saved as ${savedHere.name}. Click to remove.`
			: "Save this frequency"
	const openMap = () => {
		if (now.mapId) showOnMap(now.mapId)
		else shellStore.setView("map")
	}
	const openActivity = () => activity.showFrequency(hz, bw)
	const togglePin = () => tunedCardStore.pin(pinned === null ? hz : null)
	const copyFreq = () => {
		try {
			void navigator.clipboard?.writeText(formatMHz(hz)).then(
				() => showAppToast(`Copied ${formatMHz(hz)}`),
				() => undefined,
			)
		} catch {
			// clipboard blocked
		}
	}
	const unknown = now.kind === "plain" && here.length === 0 && named === null
	// a message reads in full as its decoded message card (calls and transmissions stay in Activity, with audio)
	const openable =
		now.latest !== null && (now.kind === "msg" || now.kind === "count")
	const latestId = now.latest?.eventId ?? null
	const openFull = () => setFullId(latestId)
	const closeFull = () => setFullId(null)
	const full = fullItem !== null && !idHere

	const decodeItems: ActionMenuItem[] = [
		{
			label: "Back",
			icon: "chevron-left",
			stay: true,
			pick: () => setMenu("more"),
		},
		...DECODE_AS.map(p => ({
			label: p.label,
			icon: "scanner" as const,
			hint: p.by,
			pick: () => startIdentify([p.id]),
		})),
	]
	const menuItems: ActionMenuItem[] = []
	if (!onIt)
		menuItems.push({
			label: `Tune to ${formatMHz(hz)}`,
			icon: "tune",
			pick: () => void tuning.tune(hz),
		})
	if (openable && !idHere)
		menuItems.push(
			full
				? { label: "Show less", icon: "chevron-up", pick: closeFull }
				: { label: "Open message", icon: "activity", pick: openFull },
		)
	if (found && now.kind !== "audio")
		menuItems.push({
			label: "Activity",
			icon: "activity",
			pick: openActivity,
		})
	if (!unknown && !idRunning)
		menuItems.push({
			label: found ? "Identify again" : "Identify",
			icon: "scanner",
			key: "I",
			pick: () => startIdentify(),
		})
	if (!idRunning && !readOnly)
		menuItems.push({
			label: "Decode as…",
			icon: "scanner",
			stay: true,
			pick: () => setMenu("decode"),
		})
	if (idRunning && !unknown)
		menuItems.push({
			label: "Stop identifying",
			icon: "close",
			pick: closeIdentify,
		})
	if (!unknown)
		menuItems.push({
			label: pinned === null ? "Pin this card" : "Unpin card",
			icon: "pin",
			pick: togglePin,
		})
	menuItems.push({ label: "Copy frequency", icon: "copy", pick: copyFreq })

	const minimised = card.minimised
	const toggleMin = () => {
		focusAfterMin.current = !minimised
		setMenu(false)
		tunedCardStore.setMinimised(!minimised)
	}
	const shortId = idRunning
		? `${proto} · Identifying`
		: now.shortId || (unknown ? "Unidentified" : proto)
	const lineState = idRunning
		? "Identifying"
		: heldByScan
			? "Held"
			: liveState
				? "Live"
				: ""

	return (
		<Island
			className="wk-shell-card wkf-card"
			role="region"
			aria-label="Tuned signal"
			data-min={minimised || undefined}
		>
			<div className="wkf-card-head">
				<CardHandle>{tile}</CardHandle>
				{minimised ? (
					<button
						ref={lineRef}
						type="button"
						className="wkf-card-line"
						aria-expanded="false"
						aria-label="Expand card"
						aria-describedby="wkf-card-line-text"
						title={`${formatMHz(hz)} MHz · ${shortId} · ${stateText} · click to expand`}
						onClick={toggleMin}
					>
						<span id="wkf-card-line-text" className="wkf-card-line-text">
							<span className="wkf-num wkf-strong">{formatMHz(hz)}</span>
							<span className="wkf-card-line-id">{shortId}</span>
							{lineState && (
								<span className="wkf-state" data-tone="accent">
									<span className="wkf-dot" aria-hidden="true" />
									<span aria-hidden="true">{lineState}</span>
									<span className="wk-sr">{stateText}</span>
								</span>
							)}
						</span>
						<Icon name="chevron-up" size={16} className="wkf-quiet" />
					</button>
				) : (
					<>
						<div className="wkf-card-title">
							<div className="wkf-card-proto">
								<span className="wkf-proto">{proto}</span>
								{protoSub && <span className="wkf-proto-sub">{protoSub}</span>}
							</div>
							<div className="wkf-state" data-tone={stateTone}>
								<span
									className="wkf-dot"
									aria-hidden="true"
									data-pulse={liveState || undefined}
								/>
								<span className="wkf-ellipsis" title={stateText}>
									{stateText}
								</span>
							</div>
						</div>
						<div className="wkf-card-freq" title={levelTitle}>
							<span className="wkf-card-freq-row">
								{pinned !== null && (
									<Icon
										name="pin"
										size={12}
										className="wkf-pin-mark"
										role="img"
										aria-hidden={undefined}
										aria-label="Pinned"
									/>
								)}
								<span className="wkf-num wkf-strong">{formatMHz(hz)}</span>
							</span>
							<span className="wkf-bars" role="img" aria-label={levelTitle}>
								{[2, 4, 6, 8, 10].map((h, i) => (
									<span
										key={h}
										style={{ height: h }}
										data-on={i < bars || undefined}
									/>
								))}
							</span>
						</div>
						<IconButton
							ref={chevRef}
							size="sm"
							label="Minimise card"
							title="Minimise card"
							aria-expanded="true"
							className="wkf-quiet-btn wkf-card-chev"
							onClick={toggleMin}
						>
							<Icon name="chevron-down" size={16} />
						</IconButton>
					</>
				)}
			</div>

			{!minimised && (
				<>
					<div className="wkf-well" data-full={full || undefined}>
						{found ? (
							<IdentifiedBlock
								found={found}
								line={notLive}
								onClose={closeIdentify}
							/>
						) : idHere ? (
							<IdentifyBlock
								view={idView}
								onClose={closeIdentify}
								untilSignal={id.untilSignal}
								onUntilSignal={setUntilSignal}
								readOnly={readOnly}
							/>
						) : full ? (
							<Suspense fallback={<NowBlock now={now} />}>
								<div className="wkf-full-head">
									<Label className="wkf-grow">Message</Label>
									<IconButton
										size="xs"
										label="Show less"
										title="Show less"
										className="wkf-quiet-btn"
										onClick={closeFull}
									>
										<Icon name="chevron-up" size={13} />
									</IconButton>
								</div>
								<MessageCard
									item={fullItem}
									record={fullRecord}
									flat
									readOnly={readOnly}
									jsonMaxHeight={220}
									className="wkf-full-card"
								/>
							</Suspense>
						) : now.kind !== "plain" ? (
							<>
								<NowBlock now={now} />
								{openable && (
									<button
										type="button"
										className="wkf-open-msg"
										onClick={openFull}
									>
										Open message
										<Icon name="chevron-down" size={13} />
									</button>
								)}
							</>
						) : (
							<>
								<Label>
									{band
										? `${groupName(band.band.group)} · ${band.band.name}`
										: bandRows[0]
											? `${bandRows[0].name} band`
											: "No band plan entry"}
								</Label>
								{channel && (
									<div className="wkf-big-row">
										<span className="wkf-big">{channel.name}</span>
									</div>
								)}
								<span className="wkf-line">{plainLine}</span>
								{noAudio ? (
									<span className="wkf-line wkf-quiet wkf-small">
										{DATA_BAND_LINE}
									</span>
								) : (
									status && (
										<span className="wkf-line wkf-quiet wkf-small">
											{mode?.label ?? status.config.modulation} ·{" "}
											{formatWidth(status.config.bandwidth)} channel
										</span>
									)
								)}
							</>
						)}
					</div>

					{!idHere && !full && now.earlier.length > 0 && (
						<section
							aria-label="Recent on this frequency"
							className="wkf-earlier"
						>
							<h3 className="wk-label">
								{voice ? "Earlier on this frequency" : "Earlier"}
							</h3>
							{now.earlier.map(r => (
								<button
									key={r.id}
									type="button"
									className="wk-row wkf-earlier-row"
									data-size="dense"
									title="Open in Activity"
									onClick={() => {
										activity.open(r.item)
										shellStore.openDrawer("activity")
									}}
								>
									<span className="wkf-earlier-t">{r.time}</span>
									<span className="wkf-earlier-a">{r.a}</span>
									{r.b && <span className="wkf-earlier-b">{r.b}</span>}
								</button>
							))}
						</section>
					)}

					{!idHere && !full && (
						<BandDecoders
							hz={hz}
							decoders={decoders}
							items={summaryItems}
							planRanges={planRanges}
							feed={verdictFeed}
							now={clock}
							readOnly={readOnly}
						/>
					)}

					<div className="wkf-actions">
						{menu && (
							<ActionMenu
								items={menu === "decode" ? decodeItems : menuItems}
								label={menu === "decode" ? "Decode as" : "More actions"}
								onClose={refocus => {
									setMenu(false)
									if (refocus) moreRef.current?.focus()
								}}
							/>
						)}
						{found ? (
							<>
								<Button
									variant={savedHere ? "tonal" : "primary"}
									className="wkf-grow"
									title={saveTitle}
									aria-pressed={savedHere !== null}
									disabled={!canSave}
									onClick={toggleSave}
								>
									<Icon name="bookmark" size={15} />
									{savedHere ? "Saved" : "Save"}
								</Button>
								{found.discoveryId !== null && (
									<Button
										variant="tonal"
										className="wkf-grow"
										title="This signal's discovery in the Scanner"
										onClick={() => {
											openDiscovery(found.discoveryId)
											shellStore.openDrawer("scanner")
										}}
									>
										<Icon name="scanner" size={15} />
										Open in Scanner
									</Button>
								)}
							</>
						) : idRunning ? (
							<Button
								variant="tonal"
								className="wkf-grow"
								onClick={closeIdentify}
							>
								Stop
							</Button>
						) : unknown || idHere ? (
							<Button
								variant="primary"
								className="wkf-grow"
								disabled={readOnly}
								title={
									idHere && id.protocols.length > 0
										? "Try the same protocol again"
										: "Identify this signal  I"
								}
								onClick={() => startIdentify(idHere ? id.protocols : [])}
							>
								<Icon name="scanner" size={15} />
								{idHere
									? id.protocols.length > 0
										? "Try again"
										: "Identify again"
									: "Identify"}
							</Button>
						) : null}
						{now.map && !idRunning && !found && (
							<Button variant="tonal" className="wkf-grow" onClick={openMap}>
								<Icon name="map" size={15} />
								Map
							</Button>
						)}
						{!unknown && !found && now.kind !== "audio" && (
							<Button
								variant="tonal"
								className="wkf-grow"
								title="What was heard on this channel"
								onClick={openActivity}
							>
								<Icon name="activity" size={15} />
								Activity
							</Button>
						)}
						{!found && (
							<IconButton
								className="wkf-act-icon"
								label={savedHere ? "Saved" : "Save"}
								title={saveTitle}
								pressed={savedHere !== null}
								disabled={!canSave}
								onClick={toggleSave}
							>
								<Icon name="bookmark" size={15} />
							</IconButton>
						)}
						{unknown && (
							<IconButton
								className="wkf-act-icon"
								label={pinned === null ? "Pin" : "Unpin"}
								title={
									pinned === null
										? "Pin this card. It keeps showing this frequency when you tune away."
										: "Unpin card"
								}
								pressed={pinned !== null}
								onClick={togglePin}
							>
								<Icon name="pin" size={15} />
							</IconButton>
						)}
						<IconButton
							ref={moreRef}
							className="wkf-act-icon"
							label="More actions"
							title="More actions"
							aria-haspopup="menu"
							aria-expanded={menu !== false}
							onClick={() => setMenu(m => (m ? false : "more"))}
						>
							<Icon name="dots" size={15} />
						</IconButton>
					</div>
				</>
			)}
		</Island>
	)
}
