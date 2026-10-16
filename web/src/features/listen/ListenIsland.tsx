// The Listen island (docs/web/canvas/Listen.dc.html): listen button, level meter with the squelch line,
// and the Audio options panel (squelch, volume). <AudioOutput/> holds the page's one <audio> element.
import { useEffect, useState, type CSSProperties } from "react"

import { useReadOnly, useServices } from "../../app/context.ts"
import { useStore } from "../../data/index.ts"
import type { IslandContext, IslandSlot } from "../../shell/ShellIsland.tsx"
import { Button } from "../../ui/Button.tsx"
import { Chip } from "../../ui/Chip.tsx"
import { Icon } from "../../ui/Icon.tsx"
import { IconButton } from "../../ui/IconButton.tsx"
import { IslandHead } from "../../ui/Island.tsx"
import { Label } from "../../ui/Label.tsx"
import { formatDb, formatMHz, formatRate } from "../format.ts"
import { useLiveStatus, useSettledHz } from "../hooks.ts"
import { modeSpec } from "../tuner/modes.ts"
import {
	audioAttachKey,
	LEVEL_MAX_DBFS,
	LEVEL_MIN_DBFS,
	levelFraction,
	squelchSetting,
	squelchThreshold,
	streamUrl,
} from "./audio.ts"
import type { ListenPhase } from "./controller.ts"

/** The page's audio element, bound to the listen controller; reattaches as the stream or tuning changes. */
export function AudioOutput() {
	const { listen } = useServices()
	const status = useLiveStatus()
	const hz = useSettledHz()
	const base =
		typeof location === "undefined" ? "http://localhost/" : location.href
	const key = audioAttachKey(status, hz, base)
	const url = streamUrl(status, base)
	useEffect(() => listen.setSource(key, url), [listen, key, url])
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
	const open = running
		? (level?.squelchOpen ?? status.squelchOpen ?? true)
		: false
	return {
		power,
		threshold,
		open,
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
	const { power, threshold, open } = useLevel()
	const on = state.wanted
	const mode = status ? modeSpec(status.config.modulation).label : null
	const sub = [mode, hz === null ? null : formatMHz(hz)]
		.filter(Boolean)
		.join(" · ")
	const toggle = () => {
		if (state.phase === "blocked") return listen.resume()
		void (on ? listen.stop() : listen.start())
	}
	const disabled = !status || (!on && readOnly && !status.running)
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
				<div>
					<b>{TITLE[state.phase]}</b>{" "}
					<span className="wk-shell-sub">{sub}</span>
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
	const { power, threshold, open, setting, floor } = useLevel()
	const [drag, setDrag] = useState<number | null>(null)
	const running = status?.running === true
	const sq =
		drag ??
		threshold ??
		(setting.kind === "manual" ? setting.thresholdDbfs : LEVEL_MIN_DBFS)
	const sqPct =
		setting.kind === "off" && drag === null ? 0 : levelFraction(sq) * 100
	const sqText =
		setting.kind === "off" && drag === null
			? "Squelch off"
			: `${setting.kind === "auto" && drag === null ? "Auto · " : ""}Threshold ${formatDb(sq, 0)} dBFS`
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
							{setting.kind === "off" ? "Off" : open ? "Open" : "Closed"}
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
					over the noise floor as conditions change.
				</span>
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
		</>
	)
}

export const listenSlot: IslandSlot = {
	panelLabel: "Audio options",
	head: ctx => <ListenHead ctx={ctx} />,
	panel: () => <ListenPanel />,
}
