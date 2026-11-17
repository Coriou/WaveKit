// The Listen island (docs/web/canvas/Listen.dc.html): listen button, level meter with the squelch line,
// and the Audio options panel (squelch, Voice only, Source, volume, sound). <AudioOutput/> holds the page's
// one <audio> element. Squelch, Voice only and Source are core settings shared by every client: a change
// is a config PATCH and never reattaches the stream, which is always the core's `/auto`.
import { useEffect, useState, type CSSProperties } from "react"
import type { LiveAudioStatus } from "@wavekit/api-types"

import { useReadOnly, useServices } from "../../app/context.ts"
import { useStore } from "../../data/index.ts"
import type { IslandContext, IslandSlot } from "../../shell/ShellIsland.tsx"
import { Button } from "../../ui/Button.tsx"
import { Icon } from "../../ui/Icon.tsx"
import { IconButton } from "../../ui/IconButton.tsx"
import { IslandHead } from "../../ui/Island.tsx"
import { Label } from "../../ui/Label.tsx"
import { Seg, type SegOption } from "../../ui/Seg.tsx"
import { Switch } from "../../ui/Switch.tsx"
import { shellStore } from "../../shell/store.ts"
import { showAppToast } from "../../shell/toast.ts"
import { focusSetting } from "../settings/registry.ts"
import { formatDb, formatMHz, formatRate } from "../format.ts"
import { useLiveStatus, useSettledHz } from "../hooks.ts"
import { modeSpec } from "../tuner/modes.ts"
import { useHeld, useSweep } from "../tuner/ScanHoldRow.tsx"
import { followingText, sweepLive } from "../tuner/scan-hold.ts"
import {
	audioAttachKey,
	audioSource,
	autoRouteSource,
	LEVEL_MAX_DBFS,
	LEVEL_MIN_DBFS,
	levelFraction,
	listenContract,
	manualStart,
	meterThreshold,
	squelchPatch,
	squelchSetting,
	voiceOnlyFits,
	type SquelchKind,
} from "./audio.ts"
import {
	audioHealthText,
	audioHealthTitle,
	breakingUpText,
} from "./audio-health.ts"
import type { ListenPhase } from "./controller.ts"
import "./listen.css"
import { recordClock, recordFileName } from "./recorder.ts"
import { openSquelch, playAnyway } from "./squelch-actions.ts"
import {
	agcOf,
	autoRouteNow,
	autoSquelchNow,
	deemphOf,
	evidenceText,
	deemphPatch,
	heldCall,
	heldCallLine,
	listenHeadline,
	listenModeOf,
	liveTone,
	LOW_CUT_HZ,
	lowCutSub,
	dropHearKey,
	noiseReductionSub,
	offeredTone,
	routeProtocol,
	sourceHint,
	toneGateOn,
	toneSquelchFits,
	toneSquelchPatch,
	toneText,
	voiceCallLine,
	voiceRoute,
	type AgcChoice,
	type DeemphChoice,
	type ListenSource,
	type VoiceRoute,
} from "./sound.ts"
import { syncVoiceStart } from "./voice-start.ts"

/** The decoded-voice stream for the tuned channel (a dsd-fme decoder on it), or null. */
export function useVoiceRoute(): VoiceRoute | null {
	const { data, decoders } = useServices()
	const voice = useStore(data.digitalVoice, s => s.status)
	const list = useStore(decoders, s => s.decoders)
	const status = useLiveStatus()
	const hz = useSettledHz()
	const tolerance = Math.max((status?.config.bandwidth || 12_500) / 2, 3000)
	return voiceRoute(list, voice, hz, tolerance)
}

/** What the core's `/auto` plays now (level events, status as fallback); null on cores without it. */
function useRouteNow() {
	const { data } = useServices()
	const status = useLiveStatus()
	const level = useStore(data.liveAudio, s => s.level)
	return autoRouteNow(status, level)
}

/**
 * The page's audio output, bound to the listen controller. It always plays the core's `/auto` (a core
 * without it: `/stream`), so a Source or squelch change keeps the stream: it reattaches only when the
 * stream itself changes (URL, format, rate).
 */
export function AudioOutput() {
	const { data, listen } = useServices()
	const status = useLiveStatus()
	const base =
		typeof location === "undefined" ? "http://localhost/" : location.href
	const access = useStore(data.access, s => s.access)
	const credentials = access?.mode === "protected"
	const wanted = useStore(listen, s => s.wanted)
	const route = useVoiceRoute()
	const source =
		autoRouteSource(status, base, credentials) ??
		audioSource(status, base, credentials)
	const voiceRunning = useStore(data.digitalVoice, s => s.status?.running)
	// `/auto` routes a decoded call only while the digital voice service runs: start it on demand, like
	// live audio on Listen, unless Source is Analog or the squelch is Open (both play analog only)
	const analogOnly =
		listenModeOf(status?.config) === "analog" ||
		squelchSetting(status).kind === "open"
	const needsVoice = route !== null && !analogOnly
	// a failed start is the `voice-start` condition: one toast until a start succeeds or listening stops
	useEffect(
		() =>
			syncVoiceStart(
				{ wanted, voiceRunning: voiceRunning === true, needsVoice },
				() => data.digitalVoice.ensureRunning(),
			),
		[data, wanted, needsVoice, voiceRunning],
	)
	// the per-browser "What you hear" of earlier versions: dropped, never sent (Source is shared)
	useEffect(() => dropHearKey(globalThis.localStorage), [])
	const key = audioAttachKey(source)
	// the source object is rebuilt every render; the key says when it really changed
	useEffect(() => listen.setSource(key, source), [listen, key])
	return (
		<audio
			ref={listen.bind}
			preload="none"
			className="wkf-audio"
			data-wk-live-audio=""
		/>
	)
}

const TITLE: Readonly<Record<ListenPhase, string>> = {
	off: "Not listening",
	connecting: "Connecting…",
	playing: "Listening",
	blocked: "Tap to play",
	error: "No audio",
}

function useLevel() {
	const { data } = useServices()
	const level = useStore(data.liveAudio, s => s.level)
	const status = useLiveStatus()
	const running = status?.running === true
	const setting = squelchSetting(status)
	const power = running
		? (level?.channelPowerDbfs ?? status.channelPowerDbfs ?? null)
		: null
	const threshold = meterThreshold(
		setting,
		running ? (level?.thresholdDbfs ?? null) : null,
	)
	// stage 1: the carrier opened the squelch; on NFM auto the voice check may still hold the audio
	const carrier = running
		? (level?.squelchOpen ?? status.squelchOpen ?? true)
		: false
	const gate = autoSquelchNow(status, level)
	// Open plays everything; otherwise the carrier is up and no voice check holds it
	const open =
		running &&
		(setting.kind === "open" || (carrier && gate?.state !== "waiting"))
	return {
		power,
		threshold,
		/** Audio passes: Open, or the carrier is up and no voice check holds it. */
		open,
		carrier,
		/** The voice check (NFM auto), null when the core does not report it. */
		gate,
		setting,
		liveThreshold: running ? (level?.thresholdDbfs ?? null) : null,
		floor: level?.noiseFloorDbfs ?? null,
	}
}

/**
 * What the head says, shared with the panel's squelch tag so both agree: the headline, and the decoded
 * call `/auto` holds (encryption still being checked, or encrypted), read from the call itself since the
 * core never routes it.
 */
function useHeadline(level: ReturnType<typeof useLevel>) {
	const status = useLiveStatus()
	const route = useVoiceRoute()
	const now = useRouteNow()
	const { setting, carrier, gate } = level
	// a tone gate set on another channel stays on the core: say so while it holds the audio
	const toneGate =
		status?.config.toneSquelch && status.config.toneSquelch.kind !== "none"
			? status.config.toneSquelch
			: null
	const toneWaiting =
		setting.kind !== "open" &&
		toneGate !== null &&
		status?.toneSquelch?.state === "waiting"
	const source = listenModeOf(status?.config)
	const headline = listenHeadline({
		squelch: setting.kind,
		carrier,
		gate,
		toneWaiting,
		now,
		source,
	})
	const heldVoice =
		now?.active === "digital"
			? null
			: heldCall({ route, source, squelch: setting.kind })
	return { headline, heldVoice, route, now, toneGate, toneWaiting }
}

function ListenHead({ ctx }: { ctx: IslandContext }) {
	const { data, listen } = useServices()
	const readOnly = useReadOnly()
	const state = useStore(listen)
	const status = useLiveStatus()
	const hz = useSettledHz()
	const level = useLevel()
	const { power, threshold, open, setting } = level
	const on = state.wanted
	const mode = status ? modeSpec(status.config.modulation).label : null
	const { headline, heldVoice, route, now, toneGate, toneWaiting } =
		useHeadline(level)
	const digital = on && now?.active === "digital"
	const heardTone = on && open ? liveTone(status?.tone) : null
	// Play anyway turns Voice only off: only where the switch exists and this browser may write; never
	// while a held DMR call keys the carrier (it would play its buzz, not the call)
	const canPlayAnyway =
		headline.kind === "waiting" &&
		heldVoice === null &&
		!readOnly &&
		voiceOnlyFits(status?.config) &&
		setting.kind === "auto"
	const sub = digital
		? voiceCallLine(
				routeProtocol(now, route),
				route,
				hz === null ? null : formatMHz(hz),
			)
		: on && heldVoice !== null
			? heldCallLine(
					heldVoice,
					routeProtocol(now, route),
					route,
					headline.kind === "listening",
				)
			: on && toneWaiting && toneGate
				? `Waiting for ${toneText(toneGate)}`
				: [
						mode,
						hz === null ? null : formatMHz(hz),
						// the tone of the transmission on the air (WG12)
						heardTone ? toneText(heardTone) : null,
					]
						.filter(Boolean)
						.join(" · ")
	// a recording playing here pauses instead of Listen turning off (ListenController.toggle)
	const toggle = () => void listen.toggle()
	const disabled = !status || (!on && readOnly && !status.running)
	const sweep = useSweep()
	const { heldHz, held } = useHeld(sweep)
	// live audio follows a running sweep: say so instead of the mode and frequency
	const follow =
		on && sweep && sweepLive(sweep.state)
			? followingText(sweep, heldHz, held)
			: null
	const audible =
		state.phase === "playing" &&
		open &&
		!toneWaiting &&
		headline.kind !== "quiet"
	const breaking = audible ? breakingUpText(state.audio) : null
	const title = state.phase === "playing" ? headline.title : TITLE[state.phase]
	return (
		<IslandHead className="wk-shell-listen-head">
			<button
				type="button"
				className="wk-shell-listen-btn"
				aria-pressed={on}
				aria-label={
					on
						? state.phase === "blocked"
							? "Play audio"
							: "Stop listening"
						: "Listen"
				}
				disabled={disabled}
				title={!status ? "Live audio is not available on this core" : undefined}
				onClick={toggle}
			>
				<Icon name="headphones" size={22} />
			</button>
			<div className="wk-shell-listen-text">
				<div
					className="wk-shell-listen-title"
					data-wk-listen-head={headline.kind}
				>
					<b>{title}</b>
					{state.phase === "playing" && canPlayAnyway ? (
						<Button
							variant="tonal"
							size="sm"
							className="wkf-play-anyway"
							title="Turns Voice only off: every carrier plays"
							onClick={() => void playAnyway(data.liveAudio)}
						>
							Play anyway
						</Button>
					) : breaking ? (
						<span
							className="wk-shell-sub"
							data-breaking=""
							title="Part of the audio is not arriving, usually because the core is busy. Audio options has the detail."
						>
							{breaking}
						</span>
					) : follow ? (
						<span className="wk-shell-sub wkf-following" title={follow.title}>
							<Icon name="scanner" size={13} />
							<span>{follow.text}</span>
						</span>
					) : (
						<span className="wk-shell-sub">{sub}</span>
					)}
				</div>
				<div className="wk-meter wkf-meter" aria-hidden="true">
					<div
						className="wk-meter-fill"
						data-open={open || undefined}
						style={
							{
								"--wk-level": String(on ? levelFraction(power) : 0),
							} as CSSProperties
						}
					/>
					{threshold !== null && (
						<div
							className="wkf-sq-line"
							style={{ left: `${levelFraction(threshold) * 100}%` }}
						/>
					)}
				</div>
			</div>
			<IconButton {...ctx.trigger} size="lg" label="Audio options">
				<Icon
					name="chevron-up"
					className="wk-shell-chev"
					data-open={ctx.open || undefined}
				/>
			</IconButton>
		</IslandHead>
	)
}

const SQUELCH_OPTIONS: ReadonlyArray<SegOption<SquelchKind>> = [
	{ value: "auto", label: "Auto" },
	{ value: "manual", label: "Manual" },
	{ value: "open", label: "Open" },
]

/** The Voice only switch's line, as the design words it. */
export const VOICE_ONLY_SUB =
	"Skips carriers, data and pagers. Voice starts about 1 s late, nothing is cut."

const SQUELCH_HELP: Readonly<Record<SquelchKind, string>> = {
	auto: "Opens on a carrier above the noise floor and follows conditions. Drag the line to set it by hand.",
	manual: "Everything above the line plays. Drag it just above the noise.",
	open: "Everything plays, noise included. Transmissions are still logged. Q goes back.",
}

function ListenPanel() {
	const { data, listen } = useServices()
	const readOnly = useReadOnly()
	const status = useLiveStatus()
	const volume = useStore(listen, s => s.volume)
	const listenError = useStore(listen, s => s.error)
	const audioError = useStore(data.liveAudio, s => s.error)
	const level = useLevel()
	const {
		power,
		threshold,
		open,
		carrier,
		gate,
		setting,
		floor,
		liveThreshold,
	} = level
	// the tag agrees with the head: Quiet there (Source Digital between calls, a tone gate waiting) is Quiet here
	const quiet = useHeadline(level).headline.kind === "quiet"
	const passing = open && !quiet
	const [drag, setDrag] = useState<number | null>(null)
	const running = status?.running === true
	const config = status?.config
	// dragging the line selects Manual at once, before the core answers
	const shown: SquelchKind = drag !== null ? "manual" : setting.kind
	const sq =
		drag ??
		threshold ??
		(setting.kind === "manual" ? setting.thresholdDbfs : LEVEL_MIN_DBFS)
	const noLine = shown === "open"
	const sqPct = noLine ? 0 : levelFraction(sq) * 100
	const sqText =
		shown === "open"
			? "Open · everything plays"
			: shown === "auto"
				? threshold === null
					? "Auto"
					: `Auto · Threshold ${formatDb(sq, 0)} dBFS`
				: `Threshold ${formatDb(sq, 0)} dBFS`
	const apply = (patch: Parameters<typeof data.liveAudio.setConfig>[0]) =>
		void data.liveAudio.setConfig(patch).catch(() => undefined)
	const canEdit = !readOnly && status !== null
	const choose = (kind: SquelchKind) => {
		if (kind === "open") return void openSquelch(data.liveAudio, listen)
		if (kind === "auto") return apply(squelchPatch(config, { kind: "auto" }))
		apply(
			squelchPatch(config, {
				kind: "manual",
				dbfs: manualStart(config, liveThreshold),
			}),
		)
	}
	const commit = () => {
		if (drag !== null)
			apply(squelchPatch(config, { kind: "manual", dbfs: drag }))
		setDrag(null)
	}
	const voiceOnly = setting.kind === "auto" && setting.voiceOnly
	return (
		<>
			<div className="wkf-field">
				<div className="wkf-sq-head">
					<Label>Squelch</Label>
					{running && (
						<span
							className="wk-tag"
							data-size="md"
							data-variant={passing ? "accent" : undefined}
							data-wk-squelch-state=""
						>
							{setting.kind === "open"
								? "Open"
								: passing
									? (evidenceText(gate) ?? "Passing")
									: !quiet && carrier && gate?.state === "waiting"
										? "Waiting for voice"
										: "Quiet"}
						</span>
					)}
				</div>
				<Seg
					label="Squelch"
					wide
					options={SQUELCH_OPTIONS.map(o => ({ ...o, disabled: !canEdit }))}
					value={shown}
					onChange={choose}
				/>
				<div className="wkf-sq-bar">
					<div
						className="wk-meter-fill"
						data-open={open || undefined}
						style={
							{ "--wk-level": String(levelFraction(power)) } as CSSProperties
						}
					/>
					<div className="wkf-sq-hatch" style={{ width: `${sqPct}%` }} />
					<div className="wkf-sq-mark" style={{ left: `${sqPct}%` }} />
					<div className="wkf-sq-knob" style={{ left: `${sqPct}%` }} />
					<input
						type="range"
						min={LEVEL_MIN_DBFS}
						max={LEVEL_MAX_DBFS}
						step={1}
						value={Math.round(sq)}
						disabled={!canEdit}
						aria-label="Squelch threshold"
						aria-valuetext={sqText}
						onChange={e => setDrag(Number(e.target.value))}
						onPointerUp={commit}
						onKeyUp={commit}
						onBlur={() => setDrag(null)}
					/>
				</div>
				<div className="wkf-sq-foot">
					<span>{sqText}</span>
					<span>
						Signal {power === null ? "—" : `${formatDb(power, 0)} dBFS`}
						{floor !== null && running ? ` · floor ${formatDb(floor, 0)}` : ""}
					</span>
				</div>
				<span className="wkf-quiet wkf-small">{SQUELCH_HELP[shown]}</span>
				{shown === "auto" && voiceOnlyFits(config) && (
					<SoundSwitch
						label="Voice only"
						sub={VOICE_ONLY_SUB}
						checked={voiceOnly}
						disabled={!canEdit}
						onChange={v =>
							apply(squelchPatch(config, { kind: "auto", voiceOnly: v }))
						}
					/>
				)}
				{status && <ToneSquelch status={status} canEdit={canEdit} />}
			</div>

			<div className="wkf-field">
				<div className="wkf-field-head">
					<Label>Volume</Label>
					<b className="wkf-num">{Math.round(volume * 100)}%</b>
				</div>
				<div
					className="wk-slider wkf-slider"
					style={{ "--wk-value": String(volume) } as CSSProperties}
				>
					<div className="wk-slider-track">
						<div className="wk-slider-fill" />
					</div>
					<div className="wk-slider-knob" />
					<input
						type="range"
						min={0}
						max={100}
						step={1}
						value={Math.round(volume * 100)}
						aria-label="Volume"
						onChange={e => listen.setVolume(Number(e.target.value) / 100)}
					/>
				</div>
				<span className="wkf-quiet wkf-small">This browser only.</span>
			</div>

			{status && listenContract(status.config) && (
				<ListenSourceField status={status} canEdit={canEdit} />
			)}
			{status && <Sound status={status} canEdit={canEdit} />}

			{status && (
				<span className="wkf-quiet wkf-small">
					{running
						? `${formatRate(status.effectiveSampleRate)} audio · ${status.clientCount} listening · ${status.pipelineHealth}`
						: "Live audio is stopped on the core. Listen starts it."}
				</span>
			)}
			{!status && (
				<span className="wkf-quiet wkf-small">
					Live audio is not available on this core.
				</span>
			)}
			{(listenError ?? audioError ?? status?.lastError) && (
				<span className="wkf-warn" role="status">
					{listenError ?? audioError ?? status?.lastError}
				</span>
			)}
			<RecordRow />
			<Button
				variant="ghost"
				className="wkf-listen-more"
				onClick={() => {
					focusSetting("au.squelch")
					shellStore.openDrawer("settings")
				}}
			>
				All audio settings
				<Icon name="chevron-right" size={16} />
			</Button>
		</>
	)
}

/** Tone squelch: offered for the tone heard on the channel (or already set), NFM only. */
function ToneSquelch({
	status,
	canEdit,
}: {
	status: LiveAudioStatus
	canEdit: boolean
}) {
	const { data, tuned } = useServices()
	const hz = useSettledHz()
	const span = useStore(tuned.span)
	const items = useStore(tuned.feed, s => s.items)
	const fresh = span !== null && span.hz === hz
	const config = status.config
	const tone = offeredTone(config.toneSquelch, fresh ? items : [], status.tone)
	if (!tone || !toneSquelchFits(config.modulation)) return null
	const on = toneGateOn(config)
	const text = toneText(tone)
	const state = status.toneSquelch?.state
	const heard = config.toneSquelch === undefined || !on
	return (
		<button
			type="button"
			className="wkf-tone-row"
			aria-pressed={on}
			disabled={!canEdit}
			onClick={() =>
				void data.liveAudio
					.setConfig(toneSquelchPatch(!on, tone))
					.catch(() => undefined)
			}
		>
			<span className="wkf-tone-text">
				<b>
					Tone squelch{" "}
					<span className="wkf-tone-tone">
						· {text}
						{heard ? " detected" : state === "open" ? " heard" : ""}
					</span>
				</b>
				<span className="wkf-quiet wkf-small">
					{on
						? state === "waiting"
							? `Waiting for ${text}. Other users on this channel stay silent.`
							: `Opens only for ${text}. Other users on this channel stay silent.`
						: "Open only for this tone, ignore other users sharing the channel."}
				</span>
			</span>
			<span className="wk-switch" aria-checked={on} aria-hidden="true" />
		</button>
	)
}

const SOURCE_OPTIONS: ReadonlyArray<SegOption<ListenSource>> = [
	{ value: "auto", label: "Auto" },
	{ value: "analog", label: "Analog" },
	{ value: "digital", label: "Digital" },
]

/** Source: what the core's `/auto` plays, shared by every client (the core's `listenMode`). */
function ListenSourceField({
	status,
	canEdit,
}: {
	status: LiveAudioStatus
	canEdit: boolean
}) {
	const { data } = useServices()
	const route = useVoiceRoute()
	const now = useRouteNow()
	const mode = listenModeOf(status.config)
	const label = modeSpec(status.config.modulation).label
	const apply = (listenMode: ListenSource) =>
		void data.liveAudio.setConfig({ listenMode }).catch(() => undefined)
	const noDecoder = now?.reason === "no-decoder"
	return (
		<div className="wkf-field">
			<Label>Source</Label>
			<Seg
				label="Source"
				wide
				options={SOURCE_OPTIONS.map(o => ({ ...o, disabled: !canEdit }))}
				value={mode}
				onChange={apply}
			/>
			<div className="wkf-hear-hint" data-wk-source-hint="">
				<span className="wkf-hear-dot" aria-hidden="true" />
				<span>{sourceHint({ mode, now, route, modeLabel: label })}</span>
				{noDecoder && canEdit && (
					<>
						<span className="wkf-gap" />
						<Button variant="outline" size="sm" onClick={() => apply("auto")}>
							Use Auto
						</Button>
					</>
				)}
			</div>
		</div>
	)
}

const AGC_OPTIONS: ReadonlyArray<{ value: AgcChoice; label: string }> = [
	{ value: "off", label: "Off" },
	{ value: "slow", label: "Slow" },
	{ value: "fast", label: "Fast" },
]
const DEEMPH_OPTIONS: ReadonlyArray<{ value: DeemphChoice; label: string }> = [
	{ value: "off", label: "Off" },
	{ value: "50", label: "50 µs" },
	{ value: "75", label: "75 µs" },
]

/** Sound: the core's level control, de-emphasis, low-cut and noise reduction (Settings › Audio has the rest). */
function Sound({
	status,
	canEdit,
}: {
	status: LiveAudioStatus
	canEdit: boolean
}) {
	const { data } = useServices()
	const c = status.config
	const apply = (patch: Parameters<typeof data.liveAudio.setConfig>[0]) =>
		void data.liveAudio.setConfig(patch).catch(() => undefined)
	const lock = <T extends string>(
		o: ReadonlyArray<{ value: T; label: string }>,
	) => o.map(x => ({ ...x, disabled: !canEdit }))
	return (
		<div className="wkf-field">
			<Label>Sound</Label>
			<div className="wkf-sound-row">
				<b>Level control</b>
				<Seg
					label="Level control"
					options={lock(AGC_OPTIONS)}
					value={agcOf(status)}
					onChange={v => apply({ agc: v })}
				/>
			</div>
			<div className="wkf-sound-row">
				<b>De-emphasis</b>
				<Seg
					label="De-emphasis"
					options={lock(DEEMPH_OPTIONS)}
					value={deemphOf(c)}
					onChange={v => apply(deemphPatch(v))}
				/>
			</div>
			<SoundSwitch
				label="Cut low rumble"
				sub={lowCutSub(c)}
				checked={c.highPass > 0}
				disabled={!canEdit}
				onChange={on => apply({ highPass: on ? LOW_CUT_HZ : 0 })}
			/>
			<SoundSwitch
				label="Noise reduction"
				sub={noiseReductionSub(c)}
				checked={c.noiseReduction !== "off"}
				disabled={!canEdit}
				onChange={on => apply({ noiseReduction: on ? "voice" : "off" })}
			/>
		</div>
	)
}

function SoundSwitch({
	label,
	sub,
	checked,
	disabled,
	onChange,
}: {
	label: string
	sub: string
	checked: boolean
	disabled: boolean
	onChange: (on: boolean) => void
}) {
	return (
		<label className="wkf-sound-switch" data-disabled={disabled || undefined}>
			<span className="wkf-tone-text">
				<b>{label}</b>
				<span className="wkf-quiet wkf-small">{sub}</span>
			</span>
			<Switch
				size="row"
				checked={checked}
				disabled={disabled}
				aria-label={label}
				onChange={onChange}
			/>
		</label>
	)
}

/** Saves the file the browser way: a temporary link to the blob. */
function download(blob: Blob, name: string): void {
	const url = URL.createObjectURL(blob)
	const a = document.createElement("a")
	a.href = url
	a.download = name
	document.body.appendChild(a)
	a.click()
	a.remove()
	setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/** Record audio: keeps what plays here and saves it as a WAV in the browser's downloads. */
function RecordRow() {
	const { listen } = useServices()
	const recording = useStore(listen, s => s.recording)
	const wanted = useStore(listen, s => s.wanted)
	const latency = useStore(listen, s => s.latencyMs)
	const audio = useStore(listen, s => s.audio)
	const audioText = audioHealthText(audio)
	const hz = useSettledHz()
	const save = (wav: Blob, startedAt: number) => {
		const name = recordFileName(hz, startedAt)
		download(wav, name)
		showAppToast(`Saved ${name}`)
	}
	const toggle = () => {
		if (recording) {
			const wav = listen.stopRecording()
			if (wav) save(wav, recording.startedAt)
			return
		}
		listen.startRecording(save)
	}
	const can = listen.canRecord && wanted
	return (
		<div className="wkf-rec-row">
			<Button
				variant="outline"
				size="lg"
				className="wkf-rec-btn"
				aria-pressed={recording !== null}
				disabled={!can && recording === null}
				title={
					!listen.canRecord
						? "This browser cannot record live audio"
						: !wanted
							? "Listen first: recording keeps what plays here"
							: "Saved as a WAV file in this browser's downloads"
				}
				onClick={toggle}
			>
				<span className="wkf-rec-dot" aria-hidden="true" />
				{recording
					? `Recording · ${recordClock(recording.seconds)}`
					: "Record audio"}
			</Button>
			<span className="wkf-gap" />
			{wanted && audioText !== null && (
				<span
					className="wkf-quiet wkf-small wkf-num"
					title={audioHealthTitle(audio)}
				>
					{audioText}
				</span>
			)}
			{latency !== null && (
				<span
					className="wkf-quiet wkf-small wkf-num"
					title="Waiting in the core, buffered in this browser, and the audio device"
				>
					Latency ≈ {latency} ms
				</span>
			)}
		</div>
	)
}

export const listenSlot: IslandSlot = {
	panelLabel: "Audio options",
	head: ctx => <ListenHead ctx={ctx} />,
	panel: () => <ListenPanel />,
}
