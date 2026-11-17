import "./playback.css"

// The one transport for recordings (`data-wk-transport`): Prev, Play/Pause, Next, the title and "n of m",
// the position, speed, Auto-next (per browser), Keep and close. Shown while a recording is in the player,
// wherever it was started from; a thin progress line with play/pause while its row is open in the visible
// panel (that row's waveform is the seek view then).
import { useServices } from "../../app/context.ts"
import { useStore } from "../../data/index.ts"
import { Switch } from "../../ui/Switch.tsx"
import { useDisplay } from "../display.ts"
import { PlayGlyph, RecIcon } from "../recordings/icons.tsx"
import { formatDuration } from "../recordings/model.ts"
import { KeepButton } from "./PlaybackUi.tsx"
import type { PlaybackState } from "./service.ts"
import {
	canPrev,
	compactOf,
	heldOf,
	queuePosition,
	queueStep,
} from "./service.ts"

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
	const { playback, listen } = useServices()
	const id = useStore(playback, s => s.id)
	const phase = useStore(playback, s => s.phase)
	const wantPlay = useStore(playback, s => s.wantPlay)
	const pos = useStore(playback, s => Math.floor(s.pos * 4) / 4)
	const duration = useStore(playback, s => s.duration)
	const speed = useStore(playback, s => s.speed)
	const autoNext = useStore(playback, s => s.autoNext)
	const compact = useStore(playback, compactOf)
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
				data-wk-transport=""
				data-phase={phase}
				data-live={live}
				role="region"
				aria-label={`Player: ${title}`}
			>
				{playButton}
				<span className="wkp-dock-line" aria-hidden="true">
					<span style={{ width: `${pct}%` }} />
				</span>
				<span className="wkp-dock-time">
					{formatDuration(pos)} / {formatDuration(d)}
				</span>
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
					<span className="wkp-dock-name">{title}</span>
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
