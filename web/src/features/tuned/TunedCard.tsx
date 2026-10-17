// The tuned card (docs/web/canvas/Tuned.dc.html, TunedGallery, Identify; DESIGN.md "Tuned card reworked"):
// header (type tile, protocol + band, state, frequency, signal bars) → the "now" block (band, channel and
// what decodes here, or Identify while it runs) → actions. Identify never moves the receiver.
import { useEffect } from "react"

import { useReadOnly, useServices } from "../../app/context.ts"
import {
	bandAt,
	channelAt,
	isIdentifyFinal,
	useStore,
} from "../../data/index.ts"
import { shellStore } from "../../shell/store.ts"
import { Button } from "../../ui/Button.tsx"
import { Icon, type IconName } from "../../ui/Icon.tsx"
import { IconButton } from "../../ui/IconButton.tsx"
import { Island } from "../../ui/Island.tsx"
import { Label } from "../../ui/Label.tsx"
import { formatDb, formatMHz, formatWidth } from "../format.ts"
import { useLiveStatus, useNow, useSettledHz } from "../hooks.ts"
import { groupName } from "../tuner/band.ts"
import { modeSpec, modulationOf } from "../tuner/modes.ts"
import { decodersAt } from "./decoders.ts"
import { identifyView, type IdentifyView } from "./identify-view.ts"
import { decoderLabel, signalBars, signalPresent } from "./signal.ts"

function IdentifyBlock({
	view,
	onClose,
}: {
	view: IdentifyView
	onClose: () => void
}) {
	const closeLabel = view.running ? "Stop identifying" : "Close"
	return (
		<div className="wkf-id">
			<div className="wkf-id-eyebrow">
				<Label className="wkf-grow">Identify</Label>
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

export function TunedCard() {
	const { data, decoders: feed, activity } = useServices()
	const readOnly = useReadOnly()
	const hz = useSettledHz()
	const status = useLiveStatus()
	const view = useStore(data.bandplan, s => s.view)
	const level = useStore(data.liveAudio, s => s.level)
	const decoders = useStore(feed, s => s.decoders)
	const id = useStore(data.identify)
	const running =
		id.starting || (id.job !== null && !isIdentifyFinal(id.event?.state))
	const now = useNow(running, 250)

	const bw = status?.config.bandwidth || 12_500
	const tolerance = Math.max(bw / 2, 3000)
	const band = hz === null ? null : bandAt(view, hz)
	const channel = hz === null ? null : channelAt(band, hz)
	const here = hz === null ? [] : decodersAt(decoders, hz, tolerance)
	const active = here.filter(d => d.running && !d.suspended)
	const idView = identifyView(id, now)
	const idHere =
		idView.phase !== "idle" &&
		(id.targetHz === null ||
			hz === null ||
			Math.abs(id.targetHz - hz) <= tolerance)

	const startIdentify = () => {
		if (hz === null || readOnly) return
		const opts =
			status && status.config.bandwidth > 0
				? { bandwidthHz: status.config.bandwidth }
				: {}
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

	const mode = status ? modeSpec(status.config.modulation) : null
	const bandMode = modulationOf(band?.band.mode)
	const proto = active[0]
		? decoderLabel(active[0].type)
		: here[0]
			? decoderLabel(here[0].type)
			: mode
				? `${mode.label}`
				: "Unknown"
	const protoSub = [band?.band.name, channel?.name].filter(Boolean).join(" · ")
	const live = status?.running === true && level !== null
	const present = live ? signalPresent(level) : false
	const squelchOpen = present === true
	const snr =
		live && level.channelPowerDbfs !== null && level.noiseFloorDbfs !== null
			? level.channelPowerDbfs - level.noiseFloorDbfs
			: null
	const bars = signalBars(snr)
	const levelTitle = live
		? `Signal ${level.channelPowerDbfs === null ? "unknown" : `${formatDb(level.channelPowerDbfs)} dBFS`}${snr === null ? "" : ` · SNR ${Math.round(snr)} dB`}`
		: "Signal level shows while listening"
	const stateText =
		idHere && idView.running
			? "Identifying"
			: active.length
				? `Decoding · ${active.map(d => d.type).join(", ")}`
				: here.length
					? `${here[0]?.type ?? "Decoder"} paused${here[0]?.suspended ? " · off band" : ""}`
					: squelchOpen
						? "Signal present"
						: live
							? present === null
								? "Squelch off"
								: "Quiet"
							: "Not decoded here"
	const stateTone =
		idHere && idView.running
			? "accent"
			: active.length || squelchOpen
				? "accent"
				: "quiet"
	const tile: IconName = active.length
		? "activity"
		: status?.running
			? "headphones"
			: "scanner"

	return (
		<Island
			className="wk-shell-card wkf-card"
			role="region"
			aria-label="Tuned signal"
		>
			<div className="wkf-card-head">
				<span
					className="wkf-tile"
					data-live={active.length > 0 || squelchOpen || undefined}
					aria-hidden="true"
				>
					<Icon name={tile} size={18} />
				</span>
				<div className="wkf-card-title">
					<div className="wkf-card-proto">
						<span className="wkf-proto">{proto}</span>
						{protoSub && <span className="wkf-proto-sub">{protoSub}</span>}
					</div>
					<div className="wkf-state" data-tone={stateTone}>
						<span className="wkf-dot" aria-hidden="true" />
						<span className="wkf-ellipsis" title={stateText}>
							{stateText}
						</span>
					</div>
				</div>
				<div className="wkf-card-freq" title={levelTitle}>
					<span className="wkf-num wkf-strong">{formatMHz(hz)}</span>
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
			</div>

			<div className="wkf-well">
				{idHere ? (
					<IdentifyBlock view={idView} onClose={closeIdentify} />
				) : (
					<>
						<Label>
							{band
								? `${groupName(band.band.group)} · ${band.band.name}`
								: "No band plan entry"}
						</Label>
						<div className="wkf-big-row">
							<span className="wkf-big">
								{channel ? channel.name : formatMHz(hz)}
							</span>
							{!channel && <span className="wkf-big-unit">MHz</span>}
						</div>
						<span className="wkf-line">
							{active.length
								? `Decoded here by ${active.map(d => d.type).join(", ")}`
								: here.length
									? `${here.map(d => d.type).join(", ")} listens here but is not running`
									: bandMode && mode && bandMode !== status?.config.modulation
										? `Nothing decodes this frequency. The band plan says ${modeSpec(bandMode).label}.`
										: "Nothing decodes this frequency. Identify finds out what it is."}
						</span>
						{status && (
							<span className="wkf-line wkf-quiet wkf-small">
								{mode?.label ?? status.config.modulation} ·{" "}
								{formatWidth(status.config.bandwidth)} channel
							</span>
						)}
					</>
				)}
			</div>

			<div className="wkf-actions">
				{idHere && idView.running ? (
					<Button variant="tonal" className="wkf-grow" onClick={closeIdentify}>
						Stop
					</Button>
				) : (
					<Button
						variant="primary"
						className="wkf-grow"
						disabled={readOnly}
						title="Identify this signal  I"
						onClick={startIdentify}
					>
						<Icon name="scanner" size={15} />
						{idHere ? "Identify again" : "Identify"}
					</Button>
				)}
				<Button
					variant="tonal"
					title="What was heard on this channel"
					onClick={() =>
						hz === null
							? shellStore.openDrawer("activity")
							: activity.showFrequency(hz, bw)
					}
				>
					<Icon name="activity" size={15} />
					Activity
				</Button>
			</div>
		</Island>
	)
}
