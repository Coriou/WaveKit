// The Receiver island (docs/web/canvas/Receiver.dc.html): the source, then its tuner settings as
// controls: sample rate (confirmed inline, the core restarts the stream), gain on the tuner's own gain
// table or auto (with the core-confirmed band gain and the scanner's overload hint under it), RTL AGC,
// bias-T, offset tuning, frequency correction and, under Advanced, direct sampling. Values are the
// core's (TunerState); a control shows its target only while its write is in flight. When the tuner
// cannot be changed (read-only access, an external client has it, offline) the panel says why and
// disables the controls instead of failing on click. Pause stops the receiver feed (feed.ts): the panel then says
// "Receiver paused" with Resume (no tuning written: SDR++ may have retuned the dongle meanwhile) and, when the
// core knows the pre-pause centre, "Resume at <MHz>" (writes the pre-pause tuning back); a failed resume reads
// as an alert with Retry (the same kind of resume), and the tuner controls wait.
import { useEffect, useId, useState, type CSSProperties } from "react"
import type { TunerState } from "@wavekit/api-types"

import { useReadOnly, useServices } from "../../app/context.ts"
import { useStore } from "../../data/index.ts"
import type {
	DataLayer,
	ControlStatus,
	ReceiverCaps,
	ReceiverSettingKey,
} from "../../data/index.ts"
import type { IslandSlot } from "../../shell/ShellIsland.tsx"
import { Button } from "../../ui/Button.tsx"
import { Chip } from "../../ui/Chip.tsx"
import { Icon } from "../../ui/Icon.tsx"
import { Label } from "../../ui/Label.tsx"
import { Seg } from "../../ui/Seg.tsx"
import { Switch } from "../../ui/Switch.tsx"
import { formatDb, formatMHz, formatRate } from "../format.ts"
import { useReceiverSourceId } from "../hooks.ts"
import {
	capsNote,
	controlAvailability,
	controlErrorText,
	controlNote,
	isUnknownField,
	rateLabel,
	rateWarning,
	receiverLock,
	sampleRateOptions,
	tunerName,
	type ReceiverControlId,
} from "./controls.ts"
import {
	bandGainText,
	gainAt,
	gainDb,
	gainHint,
	gainSteps,
	nearestGainIndex,
	overloadHintText,
} from "./gain.ts"
import {
	FEED_UNSAVED_TEXT,
	feedControllerFor,
	feedLabel,
	feedOf,
	isPaused,
	pausedDecoders,
	restoreCentreHz,
	restoreLabel,
	sinceText,
	unsavedOp,
} from "./feed.ts"
import { receiverSummary, sourceTitle } from "./summary.ts"
import { ratePolicyNote } from "./notices.ts"
import "./receiver.css"

/** The value to show: the in-flight target, else the core's. */
function shown<T>(status: ControlStatus | undefined, core: T): T {
	return status?.pending && status.target !== null ? (status.target as T) : core
}

function useReceiver() {
	const { data } = useServices()
	// the source the plot shows (one rule with the palette and the P key)
	const sourceId = useReceiverSourceId()
	const tuner = useStore(data.tuner, s =>
		sourceId === null ? undefined : s.bySource[sourceId],
	)
	const source = useStore(data.sources, s =>
		sourceId === null ? undefined : s.sources.find(x => x.id === sourceId),
	)
	const capsEntry = useStore(data.receiver, s =>
		sourceId === null ? undefined : s.caps[sourceId],
	)
	const controls = useStore(data.receiver, s =>
		sourceId === null ? undefined : s.controls[sourceId],
	)
	const relay = useStore(data.receiver, s => s.relay)
	const feeds = feedControllerFor(data)
	const feedEntry = useStore(feeds, s =>
		source ? s.bySource[source.id] : undefined,
	)
	const feed = feedOf(source, feedEntry)
	return {
		data,
		tuner,
		sourceId,
		source,
		capsEntry,
		caps: capsEntry?.caps ?? null,
		controls,
		relay,
		feeds,
		feedEntry,
		feed,
		paused: isPaused(feed),
	}
}

/**
 * The plot's "Receiver paused" label over the frozen waterfall (rendered by the plot for its source); nothing
 * while the feed is live.
 */
export function ReceiverPausedBadge({
	data,
	sourceId,
}: {
	data: Pick<DataLayer, "api" | "sources">
	sourceId: string | null
}) {
	const source = useStore(data.sources, s =>
		sourceId === null ? undefined : s.sources.find(x => x.id === sourceId),
	)
	const entry = useStore(feedControllerFor(data), s =>
		sourceId === null ? undefined : s.bySource[sourceId],
	)
	const feed = feedOf(source, entry)
	if (!isPaused(feed)) return null
	const since = sinceText(feed)
	return (
		<div className="wkf-rx-frozen" role="status" data-state={feed?.state}>
			<b>
				{feed?.state === "resuming"
					? "Resuming the receiver…"
					: "Receiver paused"}
			</b>
			<span>
				{feed?.state === "error"
					? "Resume failed · the waterfall is frozen"
					: `The waterfall is frozen${since ? ` since ${since}` : ""}`}
			</span>
		</div>
	)
}

/** Pause / resume of the receiver feed: one quiet button while live, the paused block with Resume otherwise. */
function FeedControl() {
	const { decoders } = useServices()
	const { source, feeds, feedEntry, feed, paused } = useReceiver()
	const readOnly = useReadOnly()
	const list = useStore(decoders, s => s.decoders)
	if (!source || feed === null) return null
	const id = source.id
	const pending = feedEntry?.pending ?? null
	const busy = pending !== null || feed.state === "resuming"
	const waiting = pausedDecoders(list, id).length
	const since = sinceText(feed)
	const failure = feedEntry?.error ?? null
	// a change the core holds but could not save: Retry repeats the call, which retries the write
	const unsaved = unsavedOp(feedEntry, feed)
	const note = (
		<>
			{unsaved && (
				<span
					className="wkf-warn wkf-rx-error"
					role="alert"
					data-unsaved={unsaved}
				>
					<span className="wkf-grow">{FEED_UNSAVED_TEXT[unsaved]}</span>
					<Button
						size="sm"
						variant="outline"
						disabled={readOnly || pending !== null}
						onClick={() =>
							void (unsaved === "pause" ? feeds.pause(id) : feeds.resume(id))
						}
					>
						{pending === unsaved ? "Saving…" : "Retry"}
					</Button>
				</span>
			)}
			{failure && (
				<span className="wkf-warn wkf-rx-error" role="alert">
					<span className="wkf-grow">{failure}</span>
					<button
						type="button"
						className="wkf-rx-dismiss"
						aria-label="Dismiss"
						onClick={() => feeds.dismiss(id)}
					>
						<Icon name="close" size={14} />
					</button>
				</span>
			)}
		</>
	)
	if (!paused)
		return (
			<>
				<div className="wkf-rx-feed">
					<span className="wkf-grow wkf-rx-toggle-text">
						<span className="wkf-strong">Receiver feed</span>
						<span className="wkf-quiet wkf-small">
							{readOnly
								? "Read-only: sign in to this core to pause the receiver."
								: "Pause stops the IQ stream: the waterfall freezes and decoders wait."}
						</span>
					</span>
					<Button
						size="sm"
						variant="outline"
						disabled={readOnly || busy}
						aria-keyshortcuts="P"
						onClick={() => void feeds.pause(id)}
					>
						{pending === "pause" ? "Pausing…" : "Pause"}
					</Button>
				</div>
				{note}
			</>
		)
	const failed = feed.state === "error"
	const kind = feedEntry?.resumeKind ?? null
	const restoreHz = restoreCentreHz(feed)
	// Retry already repeats a failed restore resume: no second button for the same call
	const offerRestore = restoreHz !== null && !(failed && kind === "restore")
	const resumingKind =
		pending === "resume" || feed.state === "resuming" ? (kind ?? "plain") : null
	const detail = [
		since ? `since ${since}` : null,
		"waterfall frozen",
		waiting > 0
			? `${waiting} decoder${waiting === 1 ? "" : "s"} waiting`
			: "decoders wait",
	]
		.filter(Boolean)
		.join(" · ")
	return (
		<>
			<div
				className="wkf-rx-paused"
				role={failed ? "alert" : "status"}
				data-state={feed.state}
			>
				<span className="wkf-grow wkf-rx-toggle-text">
					<span className="wkf-strong">
						{feed.state === "resuming" || pending === "resume"
							? "Resuming the receiver…"
							: failed
								? "Resume failed"
								: "Receiver paused"}
					</span>
					<span className="wkf-small">
						{failed
							? (feed.error ?? "The receiver could not be reached")
							: detail}
					</span>
				</span>
				<span className="wkf-rx-resume">
					<Button
						size="sm"
						variant={failed ? "amber" : "primary"}
						disabled={readOnly || busy}
						aria-keyshortcuts={failed && kind === "restore" ? undefined : "P"}
						title={
							failed
								? undefined
								: "Reconnect without changing the receiver's tuning"
						}
						onClick={() =>
							void (failed ? feeds.retryResume(id) : feeds.resume(id))
						}
					>
						<Icon name="play" size={14} />
						{busy && (resumingKind !== "restore" || !offerRestore)
							? "Resuming…"
							: failed
								? "Retry"
								: "Resume"}
					</Button>
					{offerRestore && (
						<Button
							size="sm"
							variant="outline"
							disabled={readOnly || busy}
							title="Reconnect and write back the centre, rate and gain from before the pause"
							onClick={() => void feeds.resume(id, { restoreTuning: true })}
						>
							{busy && resumingKind === "restore"
								? "Resuming…"
								: restoreLabel(restoreHz)}
						</Button>
					)}
				</span>
			</div>
			{note}
		</>
	)
}

function ReceiverHead({ open, trigger }: Parameters<IslandSlot["head"]>[0]) {
	const { tuner, source, feed, paused } = useReceiver()
	const connected = (source?.connected ?? false) && !paused
	const state = feedLabel(feed)
	return (
		<button
			{...trigger}
			type="button"
			className="wk-island wk-island-head wk-shell-rx-head"
		>
			<span
				className="wk-shell-dot wkf-rx-dot"
				data-off={!connected || undefined}
				aria-hidden="true"
			/>
			<b>{sourceTitle(source, tuner)}</b>
			<span className="wk-shell-sub" data-paused={paused || undefined}>
				{state ?? receiverSummary(tuner, source)}
			</span>
			<span className="wk-sr">
				{paused ? "paused" : connected ? "connected" : "not connected"}
			</span>
			<Icon
				name="chevron-down"
				size={16}
				className="wk-shell-chev"
				data-open={open || undefined}
			/>
		</button>
	)
}

function ControlError({
	status,
	onDismiss,
}: {
	status: ControlStatus | undefined
	onDismiss: () => void
}) {
	if (!status?.error) return null
	return (
		<span className="wkf-warn wkf-rx-error" role="alert">
			<span className="wkf-grow">{controlErrorText(status.error)}</span>
			<button
				type="button"
				className="wkf-rx-dismiss"
				aria-label="Dismiss"
				onClick={onDismiss}
			>
				<Icon name="close" size={14} />
			</button>
		</span>
	)
}

interface SectionProps {
	tuner: TunerState
	caps: ReceiverCaps | null
	locked: boolean
	status: (key: ReceiverSettingKey) => ControlStatus | undefined
	dismiss: (key: ReceiverSettingKey) => void
}

function SampleRate({ tuner, caps, locked, status, dismiss }: SectionProps) {
	const { data } = useServices()
	const [confirmHz, setConfirmHz] = useState<number | null>(null)
	const rate = status("sampleRate")
	const avail = controlAvailability("sampleRate", caps)
	const current = shown(rate, tuner.sampleRate)
	const options = sampleRateOptions(caps, tuner.sampleRate)
	const disabled = locked || !avail.enabled || rate?.pending === true
	// a stale confirmation goes once the panel locks or the rate moved elsewhere
	const asking = confirmHz !== null && !disabled && confirmHz !== current
	const declaredOnly = tuner.declaredOnlyFields?.includes("sampleRate") ?? false
	const warn = rateWarning(confirmHz ?? current)
	const policy = ratePolicyNote(tuner)
	return (
		<div className="wkf-field">
			<Label>Sample rate</Label>
			{options.length > 0 ? (
				<Seg
					label="Sample rate"
					columns={3}
					value={String(asking ? confirmHz : current)}
					options={options.map(hz => ({
						value: String(hz),
						label: rateLabel(hz),
						ariaLabel: formatRate(hz),
						disabled,
					}))}
					onChange={value => {
						const hz = Number(value)
						setConfirmHz(hz === current ? null : hz)
					}}
				/>
			) : (
				<span className="wkf-quiet wkf-small">{formatRate(current)}</span>
			)}
			{!avail.enabled && avail.reason && (
				<span className="wkf-quiet wkf-small">{avail.reason}</span>
			)}
			{asking && (
				<div
					className="wkf-rx-confirm"
					role="group"
					aria-label="Confirm sample rate"
				>
					<span className="wkf-grow">
						Switch to {formatRate(confirmHz)}? The core restarts the stream: the
						spectrum starts over and decoders resync.
					</span>
					<Button size="sm" variant="ghost" onClick={() => setConfirmHz(null)}>
						Cancel
					</Button>
					<Button
						size="sm"
						variant="primary"
						onClick={() => {
							const hz = confirmHz
							setConfirmHz(null)
							void data.receiver.write(tuner.sourceId, {
								key: "sampleRate",
								value: hz,
							})
						}}
					>
						Switch
					</Button>
				</div>
			)}
			{rate?.pending && (
				<span className="wkf-quiet wkf-small" role="status">
					Restarting the stream at {formatRate(current)}…
				</span>
			)}
			{policy && !rate?.pending && (
				<span className="wkf-quiet wkf-small">{policy}</span>
			)}
			{declaredOnly && !rate?.pending && (
				<span className="wkf-quiet wkf-small">
					From the configuration: WaveKit has not set it since the receiver
					connected.
				</span>
			)}
			{warn && <span className="wkf-warn wkf-small">{warn}</span>}
			<ControlError status={rate} onDismiss={() => dismiss("sampleRate")} />
		</div>
	)
}

function Gain({ tuner, caps, locked, status, dismiss }: SectionProps) {
	const { data } = useServices()
	const gain = status("gain")
	const mode = status("gainMode")
	const avail = controlAvailability("gain", caps)
	const steps = gainSteps(caps)
	const auto = shown(mode, tuner.gainMode) === "agc"
	const modeUnknown = isUnknownField(tuner, "gainMode") && !mode?.pending
	const gainUnknown = isUnknownField(tuner, "gain") && !gain?.pending
	const value = shown(gain, tuner.gain)
	const index = nearestGainIndex(steps, value)
	const last = Math.max(1, steps.valuesTenthsDb.length - 1)
	const disabled = locked || !avail.enabled
	const text = modeUnknown
		? "Unknown"
		: auto
			? "Auto"
			: gainUnknown
				? "Unknown"
				: gainDb(value)
	const pending = gain?.pending === true || mode?.pending === true
	const major = steps.source === "table" ? 7 : 10
	const setGain = (tenthsDb: number) =>
		void data.receiver.setManualGain(tuner.sourceId, tenthsDb)
	const engines = useStore(data.scanner, s => s.status?.engines)
	// Only the core's confirmed band gain (it is absent whenever the tuner may not have it).
	const inBand = auto ? undefined : tuner.bandGain
	const overload = auto ? null : overloadHintText(engines ?? [], tuner.sourceId)
	return (
		<div className="wkf-field">
			<div className="wkf-rx-row">
				<Label className="wkf-grow">Gain</Label>
				<span
					className="wkf-strong wkf-num"
					data-quiet={auto || modeUnknown || gainUnknown || undefined}
					aria-live="polite"
				>
					{text}
					{pending && <span className="wk-sr"> (applying)</span>}
				</span>
				<Chip
					size="sm"
					pressed={auto && !modeUnknown}
					disabled={disabled}
					onClick={() => {
						if (auto && !modeUnknown) setGain(gainAt(steps, index))
						else
							void data.receiver.write(tuner.sourceId, {
								key: "gainMode",
								value: "agc",
							})
					}}
				>
					Auto
				</Chip>
			</div>
			<div
				className="wk-slider wkf-rx-gain"
				data-dim={auto || undefined}
				data-pending={pending || undefined}
				style={{ "--wk-value": String(index / last) } as CSSProperties}
			>
				<div className="wk-slider-track">
					<div className="wk-slider-fill" />
				</div>
				<div className="wkf-rx-ticks" aria-hidden="true">
					{steps.valuesTenthsDb.map((v, i) => (
						<span
							key={v}
							data-major={i % major === 0 || undefined}
							data-on={(i <= index && !auto) || undefined}
						/>
					))}
				</div>
				<div className="wk-slider-knob" />
				<input
					type="range"
					min={0}
					max={steps.valuesTenthsDb.length - 1}
					step={1}
					value={index}
					disabled={disabled}
					aria-label="Tuner gain"
					aria-valuetext={
						auto ? `Auto, last manual ${gainDb(value)}` : gainDb(value)
					}
					onChange={e => setGain(gainAt(steps, Number(e.target.value)))}
				/>
			</div>
			<span className="wkf-quiet wkf-small">
				{avail.enabled ? gainHint(steps) : avail.reason}
			</span>
			{inBand && (
				<span className="wkf-quiet wkf-small" data-band-gain="">
					{bandGainText(inBand)}
				</span>
			)}
			{overload && (
				<span className="wkf-quiet wkf-small" data-overload="" role="status">
					{overload}
				</span>
			)}
			<ControlError
				status={mode?.error ? mode : gain}
				onDismiss={() => {
					dismiss("gainMode")
					dismiss("gain")
				}}
			/>
		</div>
	)
}

function ToggleRow({
	id,
	label,
	sub,
	tuner,
	caps,
	locked,
	status,
	dismiss,
}: SectionProps & {
	id: Extract<ReceiverControlId, "agcMode" | "biasTee" | "offsetTuning">
	label: string
	sub: string
}) {
	const { data } = useServices()
	const labelId = useId()
	const st = status(id)
	const avail = controlAvailability(id, caps)
	const on = shown(st, tuner[id])
	const unknown = isUnknownField(tuner, id) && !st?.pending
	const note = st?.pending
		? "Applying…"
		: unknown
			? "Unknown: not set since the receiver connected"
			: avail.reason
	return (
		<div className="wkf-rx-toggle">
			<div className="wkf-rx-row">
				<span className="wkf-grow wkf-rx-toggle-text">
					<span className="wkf-strong" id={labelId}>
						{label}
					</span>
					<span className="wkf-quiet wkf-small">{sub}</span>
					{note && (
						<span
							className="wkf-quiet wkf-small"
							data-warn={(!avail.enabled && !st?.pending) || undefined}
						>
							{note}
						</span>
					)}
				</span>
				<Switch
					size="row"
					checked={on}
					aria-labelledby={labelId}
					aria-busy={st?.pending || undefined}
					disabled={locked || !avail.enabled || st?.pending === true}
					onChange={next =>
						void data.receiver.write(tuner.sourceId, { key: id, value: next })
					}
				/>
			</div>
			<ControlError status={st} onDismiss={() => dismiss(id)} />
		</div>
	)
}

function Ppm({ tuner, caps, locked, status, dismiss }: SectionProps) {
	const { data } = useServices()
	const st = status("ppm")
	const avail = controlAvailability("ppm", caps)
	const rule = caps?.controls.find(c => c.id === "ppm")?.command.validation.rule
	const range =
		rule?.kind === "integer-range"
			? { min: rule.min, max: rule.max }
			: { min: -500, max: 500 }
	const value = shown(st, tuner.ppm)
	const unknown = isUnknownField(tuner, "ppm") && !st?.pending
	const disabled = locked || !avail.enabled
	const step = (delta: number) => {
		const next = Math.min(range.max, Math.max(range.min, value + delta))
		if (next !== value)
			void data.receiver.write(tuner.sourceId, { key: "ppm", value: next })
	}
	return (
		<div className="wkf-rx-toggle">
			<div className="wkf-rx-row">
				<span className="wkf-grow wkf-rx-toggle-text">
					<span className="wkf-strong">Frequency correction</span>
					<span className="wkf-quiet wkf-small">
						{unknown
							? "Unknown: not set since the receiver connected"
							: (avail.reason ?? "Crystal error in parts per million")}
					</span>
				</span>
				<div
					className="wkf-rx-stepper"
					role="group"
					aria-label="Frequency correction"
					data-pending={st?.pending || undefined}
				>
					<button
						type="button"
						aria-label="Decrease correction"
						disabled={disabled || value <= range.min}
						onClick={() => step(-1)}
					>
						−
					</button>
					<span className="wkf-num wkf-strong" aria-live="polite">
						{unknown ? "?" : `${value > 0 ? "+" : ""}${formatDb(value, 0)}`}
						<span className="wk-sr"> ppm</span>
					</span>
					<button
						type="button"
						aria-label="Increase correction"
						disabled={disabled || value >= range.max}
						onClick={() => step(1)}
					>
						+
					</button>
				</div>
			</div>
			<ControlError status={st} onDismiss={() => dismiss("ppm")} />
		</div>
	)
}

function Advanced(props: SectionProps) {
	const { tuner, caps, locked, status, dismiss } = props
	const { data } = useServices()
	const [open, setOpen] = useState(false)
	const regionId = useId()
	const st = status("directSampling")
	const avail = controlAvailability("directSampling", caps)
	const value = shown(st, tuner.directSampling)
	const unknown = isUnknownField(tuner, "directSampling") && !st?.pending
	const disabled = locked || !avail.enabled || st?.pending === true
	return (
		<div className="wkf-rx-adv">
			<button
				type="button"
				className="wkf-rx-adv-btn"
				aria-expanded={open}
				aria-controls={regionId}
				onClick={() => setOpen(!open)}
			>
				<Icon
					name="chevron-down"
					size={14}
					className="wkf-rx-adv-chev"
					data-open={open || undefined}
				/>
				Advanced
			</button>
			{open && (
				<div id={regionId} className="wkf-rx-adv-body">
					<div className="wkf-rx-row">
						<span className="wkf-grow wkf-rx-toggle-text">
							<span className="wkf-strong">Direct sampling</span>
							<span className="wkf-quiet wkf-small">
								{st?.pending
									? "Applying…"
									: unknown
										? "Unknown: not set since the receiver connected"
										: avail.reason}
							</span>
						</span>
						<Seg
							label="Direct sampling"
							value={unknown ? "" : value}
							options={[
								{ value: "off", label: "Off", disabled },
								{ value: "i", label: "I", ariaLabel: "I branch", disabled },
								{ value: "q", label: "Q", ariaLabel: "Q branch", disabled },
							]}
							onChange={mode => {
								if (mode === "off" || mode === "i" || mode === "q")
									void data.receiver.write(tuner.sourceId, {
										key: "directSampling",
										value: mode,
									})
							}}
						/>
					</div>
					<ControlError
						status={st}
						onDismiss={() => dismiss("directSampling")}
					/>
				</div>
			)}
		</div>
	)
}

function throughput(kibPerSecond: number | undefined): string {
	if (kibPerSecond === undefined) return "—"
	return `${((kibPerSecond * 1024) / 1e6).toFixed(1)} MB/s`
}

function ReceiverPanel() {
	const {
		data,
		tuner,
		sourceId,
		source,
		capsEntry,
		caps,
		controls,
		relay,
		feed,
		paused,
	} = useReceiver()
	const readOnly = useReadOnly()
	const tunerError = useStore(data.tuner, s => s.error)
	useEffect(() => {
		void data.receiver.loadRelay()
		if (sourceId !== null) void data.receiver.loadCaps(sourceId)
	}, [data, sourceId])
	const lock = receiverLock({ tuner, source, readOnly, relay, paused })
	const name = tunerName(caps)
	const status = (key: ReceiverSettingKey) => controls?.[key]
	const dismiss = (key: ReceiverSettingKey) => {
		if (sourceId !== null) data.receiver.dismiss(sourceId, key)
	}
	const reclaim = controls?.controlMode
	const stats: { k: string; v: string }[] = [
		{ k: "Throughput", v: throughput(source?.dataRate) },
		{
			k: "Level",
			v:
				source?.signalLevelDbfs === undefined
					? "—"
					: `${formatDb(source.signalLevelDbfs)} dBFS`,
		},
		{ k: "Centre", v: tuner ? `${formatMHz(tuner.frequency)} MHz` : "—" },
	]
	const note = capsNote(capsEntry)
	const owner = controlNote(tuner, relay)
	return (
		<>
			<div className="wkf-rx-title">
				<div className="wkf-grow">
					<div className="wkf-rx-name">
						{name ? `RTL-SDR · ${name}` : sourceTitle(source, tuner)}
					</div>
					<div className="wkf-quiet">
						{[
							name ? sourceTitle(source, tuner) : null,
							source?.type,
							source?.url,
						]
							.filter(Boolean)
							.join(" · ") || "Unknown source"}
					</div>
				</div>
				<span
					className="wk-tag"
					data-size="md"
					data-variant={source?.connected && !paused ? "accent" : "amber"}
				>
					{paused
						? feed?.state === "resuming"
							? "Resuming"
							: "Paused"
						: source?.connected
							? source.activity?.state === "streaming"
								? "Streaming"
								: "Connected"
							: "Offline"}
				</span>
			</div>
			<FeedControl />
			<dl className="wkf-rx-stats">
				{stats.map(s => (
					<div key={s.k}>
						<dt>{s.k}</dt>
						<dd>{s.v}</dd>
					</div>
				))}
			</dl>
			{lock.locked && lock.reason && (
				<div className="wkf-rx-lock" role="status">
					<span className="wkf-grow">{lock.reason}</span>
					{lock.canReclaim && tuner && !readOnly && (
						<Button
							size="sm"
							variant="tonal"
							disabled={reclaim?.pending === true}
							onClick={() =>
								void data.receiver.write(tuner.sourceId, {
									key: "controlMode",
									value: "internal",
								})
							}
						>
							Take control
						</Button>
					)}
				</div>
			)}
			<ControlError status={reclaim} onDismiss={() => dismiss("controlMode")} />
			{source?.lastError && !paused && (
				<span className="wkf-warn">{source.lastError}</span>
			)}
			{tuner?.lastError && (
				<span className="wkf-warn">
					Last tuner command failed: {tuner.lastError}
				</span>
			)}
			{tunerError && <span className="wkf-warn">{tunerError}</span>}
			{note && <span className="wkf-quiet wkf-small">{note}</span>}
			{tuner ? (
				<>
					<SampleRate
						tuner={tuner}
						caps={caps}
						locked={lock.locked}
						status={status}
						dismiss={dismiss}
					/>
					<Gain
						tuner={tuner}
						caps={caps}
						locked={lock.locked}
						status={status}
						dismiss={dismiss}
					/>
					<div className="wkf-rx-toggles">
						<ToggleRow
							id="agcMode"
							label="RTL AGC"
							sub="Digital gain inside the RTL2832"
							tuner={tuner}
							caps={caps}
							locked={lock.locked}
							status={status}
							dismiss={dismiss}
						/>
						<ToggleRow
							id="biasTee"
							label="Bias‑T"
							sub="Powers an LNA through the antenna port"
							tuner={tuner}
							caps={caps}
							locked={lock.locked}
							status={status}
							dismiss={dismiss}
						/>
						<ToggleRow
							id="offsetTuning"
							label="Offset tuning"
							sub="Moves the DC spike out of the band (E4000)"
							tuner={tuner}
							caps={caps}
							locked={lock.locked}
							status={status}
							dismiss={dismiss}
						/>
						<Ppm
							tuner={tuner}
							caps={caps}
							locked={lock.locked}
							status={status}
							dismiss={dismiss}
						/>
					</div>
					<Advanced
						tuner={tuner}
						caps={caps}
						locked={lock.locked}
						status={status}
						dismiss={dismiss}
					/>
				</>
			) : (
				<span className="wkf-quiet">No tuner-controlled source.</span>
			)}
			{owner && (
				<div className="wkf-rx-owner">
					<span className="wkf-grow">{owner}</span>
				</div>
			)}
		</>
	)
}

export const receiverSlot: IslandSlot = {
	panelLabel: "Receiver",
	head: ctx => <ReceiverHead {...ctx} />,
	panel: () => <ReceiverPanel />,
}
