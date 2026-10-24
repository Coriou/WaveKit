// The Listen island (docs/web/canvas/Listen.dc.html): listen button, level meter with the squelch line,
// and the Audio options panel (squelch, volume). <AudioOutput/> holds the page's one <audio> element.
import { useEffect, useState, type CSSProperties } from "react"
import type { LiveAudioStatus } from "@wavekit/api-types"

import { useReadOnly, useServices } from "../../app/context.ts"
import { proofKind, useStore } from "../../data/index.ts"
import type { IslandContext, IslandSlot } from "../../shell/ShellIsland.tsx"
import { Button } from "../../ui/Button.tsx"
import { Chip } from "../../ui/Chip.tsx"
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
	noiseSquelchFits,
	squelchSetting,
	squelchThreshold,
	voiceSource,
} from "./audio.ts"
import type { ListenPhase } from "./controller.ts"
import { recordClock, recordFileName } from "./recorder.ts"
import {
	agcOf,
	autoRouteNow,
	autoSquelchNow,
	coreRouteHint,
	coreRoutes,
	deemphOf,
	evidenceText,
	deemphPatch,
	hearHint,
	liveTone,
	LOW_CUT_HZ,
	lowCutSub,
	noiseReductionSub,
	offeredTone,
	playsDigital,
	routeProtocol,
	toneGateOn,
	toneSquelchFits,
	toneSquelchPatch,
	toneText,
	transmissionKind,
	voiceRoute,
	type TransmissionKind,
	type AgcChoice,
	type DeemphChoice,
	type HearChoice,
	type VoiceRoute,
} from "./sound.ts"

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

/**
 * Analog or digital for the transmission on the air (What you hear: Auto): a decoded call or a live tone
 * now, else the channel's last proven transmission (WG12). Null on older cores until a call or tone says.
 */
export function useTransmissionKind(
	route: VoiceRoute | null,
): TransmissionKind | null {
	const { data } = useServices()
	const status = useLiveStatus()
	const hz = useSettledHz()
	const { open } = useLevel()
	const last = useStore(data.nearDiscovery, s =>
		hz !== null && s.hz === hz ? proofKind(s.lastProof) : null,
	)
	return transmissionKind({
		route,
		open,
		tone: status?.tone,
		last,
		now: Date.now(),
	})
}

/**
 * Auto on a core that serves `/auto`: the core picks analog or decoded voice, and `now` says which
 * plays (level events, status as fallback). Null when this browser picks the stream itself.
 */
export function useCoreRoute() {
	const { data, listen } = useServices()
	const status = useLiveStatus()
	const hear = useStore(listen, s => s.hear)
	const level = useStore(data.liveAudio, s => s.level)
	if (!coreRoutes(hear, status)) return null
	return {
		now: autoRouteNow(status, level),
		digitalAvailable: status?.autoRoute?.digitalAvailable === true,
	}
}

/** The page's audio output, bound to the listen controller; reattaches when the stream itself changes. */
export function AudioOutput() {
	const { data, listen } = useServices()
	const status = useLiveStatus()
	const base =
		typeof location === "undefined" ? "http://localhost/" : location.href
	const access = useStore(data.access, s => s.access)
	const credentials = access?.mode === "protected"
	const hear = useStore(listen, s => s.hear)
	const wanted = useStore(listen, s => s.wanted)
	const route = useVoiceRoute()
	const kind = useTransmissionKind(route)
	// Auto on a core with /auto: the core switches between analog and decoded voice in one stream
	const core = coreRoutes(hear, status)
	const digital = !core && playsDigital(hear, route, kind)
	const voiceRunning = useStore(data.digitalVoice, s => s.status?.running)
	// analog plays until the decoded voice stream is up; both need live audio running (Listen drives the
	// squelch meter, and a null source would end listening)
	const source = core
		? autoRouteSource(status, base, credentials)
		: digital && route && voiceRunning && status?.running
			? voiceSource(route, base, credentials)
			: audioSource(status, base, credentials)
	// the decoded voice stream starts on demand, like live audio does on Listen; /auto needs the
	// digital voice service running to route a call, and plays analog meanwhile
	const needsVoice = digital || (core && route !== null)
	useEffect(() => {
		if (!wanted || !needsVoice || voiceRunning) return
		data.digitalVoice.ensureRunning().catch((error: unknown) => {
			showAppToast(
				`Decoded voice could not start: ${error instanceof Error ? error.message : "the core refused"}`,
				{ tone: "warn" },
			)
			listen.setHear("analog")
		})
	}, [data, listen, wanted, needsVoice, voiceRunning])
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
	const threshold = squelchThreshold(
		setting,
		running ? (level?.thresholdDbfs ?? null) : null,
	)
	// stage 1: the carrier opened the squelch; on NFM auto the evidence gate may still hold the audio
	const carrier = running
		? (level?.squelchOpen ?? status.squelchOpen ?? true)
		: false
	const gate = autoSquelchNow(status, level)
	const open = carrier && gate?.state !== "waiting"
	return {
		power,
		threshold,
		/** Audio passes: the carrier is up and no evidence gate holds it. */
		open,
		carrier,
		/** The evidence squelch (NFM auto), null when the core does not report it. */
		gate,
		setting,
		floor: level?.noiseFloorDbfs ?? null,
	}
}

function ListenHead({ ctx }: { ctx: IslandContext }) {
	const { listen } = useServices()
	const readOnly = useReadOnly()
	const state = useStore(listen)
	const status = useLiveStatus()
	const hz = useSettledHz()
	const { power, threshold, open, carrier, gate: evidence } = useLevel()
	const on = state.wanted
	const mode = status ? modeSpec(status.config.modulation).label : null
	const route = useVoiceRoute()
	const kind = useTransmissionKind(route)
	const core = useCoreRoute()
	const digital = core
		? on && core.now?.active === "digital"
		: on && playsDigital(state.hear, route, kind) && route !== null
	const heardTone = on && open ? liveTone(status?.tone) : null
	// a tone gate set on another channel stays on the core: say so while it holds the audio
	const gate =
		status?.config.toneSquelch && status.config.toneSquelch.kind !== "none"
			? status.config.toneSquelch
			: null
	const sub = digital
		? [
				`${routeProtocol(core?.now ?? null, route) ?? "Digital"} voice`,
				route?.call ?? (hz === null ? null : formatMHz(hz)),
			]
				.filter(Boolean)
				.join(" · ")
		: on && gate && status?.toneSquelch?.state === "waiting"
			? `Waiting for ${toneText(gate)}`
			: on && carrier && evidence?.state === "waiting"
				? // NFM auto squelch: a carrier is up, its audio waits for voice or a tone
					"Waiting for voice or a tone"
				: [
						mode,
						hz === null ? null : formatMHz(hz),
						// the tone of the transmission on the air (WG12)
						heardTone ? toneText(heardTone) : null,
					]
						.filter(Boolean)
						.join(" · ")
	const toggle = () => {
		if (state.phase === "blocked") return listen.resume()
		void (on ? listen.stop() : listen.start())
	}
	const disabled = !status || (!on && readOnly && !status.running)
	const sweep = useSweep()
	const { heldHz, held } = useHeld(sweep)
	// live audio follows a running sweep: say so instead of the mode and frequency
	const follow =
		on && sweep && sweepLive(sweep.state)
			? followingText(sweep, heldHz, held)
			: null
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
				<div className="wk-shell-listen-title">
					<b>
						{state.phase === "playing" &&
						(!open || status?.toneSquelch?.state === "waiting")
							? "Squelched"
							: TITLE[state.phase]}
					</b>
					{follow ? (
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

function ListenPanel() {
	const { data, listen } = useServices()
	const readOnly = useReadOnly()
	const status = useLiveStatus()
	const volume = useStore(listen, s => s.volume)
	const listenError = useStore(listen, s => s.error)
	const audioError = useStore(data.liveAudio, s => s.error)
	const { power, threshold, open, carrier, gate, setting, floor } = useLevel()
	const [drag, setDrag] = useState<number | null>(null)
	const running = status?.running === true
	const sq =
		drag ??
		threshold ??
		(setting.kind === "manual" ? setting.thresholdDbfs : LEVEL_MIN_DBFS)
	// off and noise squelch draw no power threshold
	const noLine =
		(setting.kind === "off" || setting.kind === "noise") && drag === null
	const sqPct = noLine ? 0 : levelFraction(sq) * 100
	const sqText =
		setting.kind === "noise" && drag === null
			? `Noise squelch · opens ${formatDb(setting.quietingDb, 0)} dB below the noise`
			: setting.kind === "off" && drag === null
				? "Squelch off"
				: `${setting.kind === "auto" && drag === null ? "Auto · " : ""}Threshold ${formatDb(sq, 0)} dBFS`
	const noiseFits = status ? noiseSquelchFits(status.config.modulation) : false
	const apply = (patch: Parameters<typeof data.liveAudio.setConfig>[0]) =>
		void data.liveAudio.setConfig(patch).catch(() => undefined)
	const canEdit = !readOnly && status !== null
	return (
		<>
			<div className="wkf-field">
				<div className="wkf-sq-head">
					<Label>Squelch</Label>
					{running && (
						<span
							className="wk-tag"
							data-size="md"
							data-variant={open ? "accent" : undefined}
						>
							{setting.kind === "off"
								? "Off"
								: open
									? (evidenceText(gate) ?? "Open")
									: carrier && gate?.state === "waiting"
										? "Waiting for voice"
										: "Closed"}
						</span>
					)}
					<span className="wkf-gap" />
					<Chip
						size="sm"
						pressed={setting.kind === "auto"}
						disabled={!canEdit}
						onClick={() => apply({ squelchMode: "auto", autoMarginDb: 6 })}
					>
						Auto
					</Chip>
					<Chip
						size="sm"
						pressed={setting.kind === "noise"}
						disabled={!canEdit || !noiseFits}
						title={
							noiseFits
								? "Opens on FM quieting: works on a carrier already up when tuned"
								: "FM only (NFM, WFM)"
						}
						onClick={() => apply({ squelchMode: "noise" })}
					>
						Noise
					</Chip>
					<Button
						variant="outline"
						size="sm"
						disabled={!canEdit}
						onClick={() => apply({ squelchMode: "manual", squelch: 0 })}
					>
						Off
					</Button>
				</div>
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
						onPointerUp={() => {
							if (drag !== null) apply({ squelchMode: "manual", squelch: drag })
							setDrag(null)
						}}
						onKeyUp={() => {
							if (drag !== null) apply({ squelchMode: "manual", squelch: drag })
							setDrag(null)
						}}
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
				<span className="wkf-quiet wkf-small">
					Drag the line just above the noise to silence it. Auto keeps it 6 dB
					over the noise floor as conditions change. Noise (FM) opens when a
					carrier quiets the receiver noise.
				</span>
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

			{status && <WhatYouHear status={status} />}
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

const HEAR_OPTIONS: ReadonlyArray<SegOption<HearChoice>> = [
	{ value: "auto", label: "Auto" },
	{ value: "analog", label: "Analog" },
	{
		value: "digital",
		// "Decoded" alone where the island is narrow (phone)
		label: (
			<>
				Decoded<span className="wkf-hear-long"> voice</span>
			</>
		),
		ariaLabel: "Decoded voice",
	},
]

/** What you hear: the analog audio or the decoded voice of a dsd-fme decoder on the channel. */
function WhatYouHear({ status }: { status: LiveAudioStatus }) {
	const { listen } = useServices()
	const hear = useStore(listen, s => s.hear)
	const route = useVoiceRoute()
	const kind = useTransmissionKind(route)
	const core = useCoreRoute()
	const mode = modeSpec(status.config.modulation).label
	return (
		<div className="wkf-field">
			<Label>What you hear</Label>
			<Seg
				label="Audio source"
				wide
				options={HEAR_OPTIONS}
				value={hear}
				onChange={v => listen.setHear(v)}
			/>
			<div className="wkf-hear-hint">
				<span className="wkf-hear-dot" aria-hidden="true" />
				<span>
					{core
						? coreRouteHint({ ...core, route, modeLabel: mode })
						: hearHint(hear, route, mode, kind)}
				</span>
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
			{latency !== null && (
				<span
					className="wkf-quiet wkf-small wkf-num"
					title="Buffered in this browser plus the audio device; the core's pipeline adds to it"
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
