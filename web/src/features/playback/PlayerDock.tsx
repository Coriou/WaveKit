import "./playback.css"

// The one transport for recordings (`data-wk-transport`): Prev, Play/Pause, Next, the title and "n of m",
// the position, speed, Auto-next (per browser), Keep and close. The title opens the playing transmission's view.
// Shown while a recording is in the player, wherever it was started from, in full: an open row's disc and
// waveform are thin controls of this same player and never shrink it. Only when the shell layout has no height
// for the full transport (`data-forced`: the first step of DESIGN.md's "Insufficient height") it is one compact
// line, which still names what plays and can close it: play/pause, the title, the progress, the time, close.
import { useServices } from "../../app/context.ts"
import { useStore } from "../../data/index.ts"
import { playerCompactForced } from "../../shell/layout/stores.ts"
import { Switch } from "../../ui/Switch.tsx"
import { useDisplay } from "../display.ts"
import { PlayGlyph, RecIcon } from "../recordings/icons.tsx"
import { formatDuration } from "../recordings/model.ts"
import {
	activityLists,
	hostHere,
	openTransmission,
	playingTransmission,
} from "../transmission/nav.ts"
import { KeepButton } from "./PlaybackUi.tsx"
import type { PlaybackState } from "./service.ts"
import { canPrev, heldOf, queuePosition, queueStep } from "./service.ts"

/** The dock's title for the recording in the player. */
export function dockTitle(s: PlaybackState): string {
	if (s.id === null) return ""
	return s.queue?.titles?.[s.id] ?? s.title ?? "Recording"
}

/** The line under the title: the error, else where it is in its list and whether live audio waits. */
export function dockSub(s: PlaybackState, liveWanted: boolean): string {
	if (s.error !== null) return s.error
	return [
		queuePosition(s),
		liveWanted && (s.phase === "playing" || s.phase === "loading")
			? "live audio muted"
			: null,
	]
		.filter(Boolean)
		.join(" · ")
}

export function PlayerDock() {
	useDisplay()
	const { playback, listen, activity } = useServices()
	const id = useStore(playback, s => s.id)
	const phase = useStore(playback, s => s.phase)
	const wantPlay = useStore(playback, s => s.wantPlay)
	const pos = useStore(playback, s => Math.floor(s.pos * 4) / 4)
	const duration = useStore(playback, s => s.duration)
	const speed = useStore(playback, s => s.speed)
	const autoNext = useStore(playback, s => s.autoNext)
	const compact = useStore(playerCompactForced)
	const title = useStore(playback, dockTitle)
	const liveWanted = useStore(listen, s => s.wanted)
	// what live audio does while this plays (read by ui-check): muted, or on
	const live = useStore(playback, s =>
		liveWanted ? (heldOf(s) ? "muted" : "on") : undefined,
	)
	const sub = useStore(playback, s => dockSub(s, liveWanted))
	const hasError = useStore(playback, s => s.error !== null)
	// the same rule as prev(): enabled exactly when it restarts or steps back
	const hasPrev = useStore(playback, canPrev)
	const hasNext = useStore(playback, s => queueStep(s.queue, s.id, 1) !== null)
	if (id === null) return null
	// the playing transmission's view: on its Activity row when it was played from one, else on its recording
	const openPlaying = () => {
		const playing = playingTransmission(playback.get(), activityLists(activity))
		if (playing !== null)
			openTransmission(playing.ref, hostHere(), playing.summary)
	}
	const titleButton = (
		<button
			type="button"
			className="wkp-dock-name wkp-dock-open"
			title="This transmission's details"
			onClick={openPlaying}
		>
			{title}
		</button>
	)
	const closeButton = (
		<button
			type="button"
			className="wk-icon-btn"
			data-size="sm"
			aria-label="Close player and unmute live audio"
			title="Close player and unmute live audio"
			onClick={() => playback.stop()}
		>
			<RecIcon name="close" size={15} />
		</button>
	)
	const d = duration ?? 0
	const playing = phase === "playing" || (phase === "loading" && wantPlay)
	const pct = d > 0 ? Math.min(100, (pos / d) * 100) : 0
	const playButton = (
		<button
			type="button"
			className="wkp-dock-play"
			aria-label={playing ? "Pause" : "Play"}
			onClick={() => playback.toggle()}
		>
			{phase === "loading" && wantPlay ? (
				<span className="wk-spinner" aria-hidden="true" />
			) : (
				<PlayGlyph playing={playing} size={13} />
			)}
		</button>
	)
	if (compact)
		return (
			<div
				className="wk-island wkp-dock"
				data-compact=""
				data-forced=""
				data-wk-transport=""
				data-phase={phase}
				data-live={live}
				role="region"
				aria-label={`Player: ${title}`}
			>
				{playButton}
				<span className="wkp-dock-cline">
					{titleButton}
					<span className="wkp-dock-line" aria-hidden="true">
						<span style={{ width: `${pct}%` }} />
					</span>
				</span>
				<span className="wkp-dock-time">
					{formatDuration(pos)} / {formatDuration(d)}
				</span>
				{closeButton}
			</div>
		)
	return (
		<div
			className="wk-island wkp-dock"
			data-wk-transport=""
			data-phase={phase}
			data-live={live}
			role="region"
			aria-label="Player"
		>
			<div className="wkp-dock-row">
				<button
					type="button"
					className="wk-icon-btn"
					data-size="sm"
					aria-label="Previous"
					disabled={!hasPrev}
					onClick={() => playback.prev()}
				>
					<RecIcon name="prev" size={14} />
				</button>
				{playButton}
				<button
					type="button"
					className="wk-icon-btn"
					data-size="sm"
					aria-label="Next"
					disabled={!hasNext}
					onClick={() => playback.next()}
				>
					<RecIcon name="next" size={14} />
				</button>
				<span className="wkp-dock-title">
					{titleButton}
					<span
						className="wkp-dock-sub"
						data-tone={hasError ? "warn" : undefined}
					>
						{sub}
					</span>
				</span>
				<span className="wkp-dock-time">
					{formatDuration(pos)} / {formatDuration(d)}
				</span>
				<button
					type="button"
					className="wk-chip"
					data-size="sm"
					title="Playback speed"
					onClick={() => playback.cycleSpeed()}
				>
					{speed}×
				</button>
				<label
					className="wkp-dock-auto"
					title="Play the next one when this ends"
				>
					<span>Auto-next</span>
					<Switch
						checked={autoNext}
						onChange={on => playback.setAutoNext(on)}
						aria-label="Auto-next"
					/>
				</label>
				<KeepButton id={id} title={title} compact />
				{closeButton}
			</div>
			<input
				type="range"
				className="wkp-dock-seek"
				aria-label="Position"
				min={0}
				max={Math.max(1, Math.round(d * 10))}
				value={Math.round(pos * 10)}
				onChange={e => playback.seek(Number(e.target.value) / 10)}
			/>
		</div>
	)
}
