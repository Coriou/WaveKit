import "./playback.css"

// What the lists show of the one player: the play disc on a row that has audio (a toggle, not a transport),
// the waveform of an open row (a seek view), Keep, and the one marking selector every surface uses.
import { useEffect } from "react"
import type { PointerEvent as ReactPointerEvent } from "react"

import { useReadOnly, useServices } from "../../app/context.ts"
import { errorMessage, useStore } from "../../data/index.ts"
import { showAppToast } from "../../shell/toast.ts"
import { PlayGlyph, RecIcon } from "../recordings/icons.tsx"
import { formatDuration } from "../recordings/model.ts"
import { keepTarget, keptHere, setKept } from "./keep.ts"
import type { PlaybackPhase, QueueRef } from "./service.ts"
import { markOf, WAVE_BARS } from "./service.ts"

/** The phase of `id` when it is the recording in the player, else null (identical in every surface). */
export function usePlaybackMark(id: string): PlaybackPhase | null {
	return useStore(useServices().playback, markOf(id))
}

/** The disc's state attribute: what the row shows of the player. */
export function markState(
	phase: PlaybackPhase | null,
): "playing" | "current" | undefined {
	if (phase === "playing" || phase === "loading") return "playing"
	return phase !== null ? "current" : undefined
}

export interface PlayDiscProps {
	/** The recording's playback id (its stable key). */
	id: string
	title: string
	durationMs: number | null
	/** The list it is played from, read at the click (a snapshot). */
	queue: () => QueueRef
	className?: string
	/** One line (glyph, then the duration) for dense rows and card footers. */
	inline?: boolean
}

/** Play or pause this row's recording; the duration under it. */
export function PlayDisc({
	id,
	title,
	durationMs,
	queue,
	className,
	inline = false,
}: PlayDiscProps) {
	const { playback } = useServices()
	const phase = usePlaybackMark(id)
	const playing = phase === "playing"
	const state = markState(phase)
	return (
		<button
			type="button"
			className={className ? `wkp-disc ${className}` : "wkp-disc"}
			data-state={state}
			data-inline={inline || undefined}
			data-playback={phase ?? undefined}
			data-playback-id={id}
			aria-label={`${playing ? "Pause" : "Play"} ${title}`}
			title={playing ? "Pause" : "Play"}
			onClick={e => {
				e.stopPropagation()
				if (phase !== null) playback.toggle()
				else playback.play(id, queue(), 0, title)
			}}
		>
			<span className="wkp-disc-face">
				{phase === "loading" ? (
					<span className="wk-spinner" aria-hidden="true" />
				) : (
					<PlayGlyph playing={playing} />
				)}
			</span>
			<span className="wkp-disc-dur">
				{durationMs !== null ? formatDuration(durationMs / 1000) : "–"}
			</span>
		</button>
	)
}

export interface WaveViewProps {
	id: string
	title: string
	durationMs: number | null
	queue: () => QueueRef
}

/** The waveform: click (or drag) to seek, or to play from there; the playhead follows playback. */
export function WaveView({ id, title, durationMs, queue }: WaveViewProps) {
	const { playback } = useServices()
	const peaks = useStore(playback.peaks, m => m.get(id))
	const current = useStore(playback, s => s.id === id)
	const frac = useStore(playback, s =>
		s.id === id && s.duration ? Math.min(1, s.pos / s.duration) : 0,
	)
	useEffect(() => {
		void playback.loadPeaks(id)
	}, [playback, id])
	const total = durationMs !== null ? durationMs / 1000 : null
	const seekAt = (e: ReactPointerEvent<HTMLDivElement>) => {
		const rect = e.currentTarget.getBoundingClientRect()
		const f = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
		const s = playback.get()
		const d = s.id === id ? (s.duration ?? total) : total
		if (d === null) return
		if (s.id === id) playback.seek(f * d)
		else playback.play(id, queue(), f * d, title)
	}
	const bars = Array.isArray(peaks) ? peaks : null
	const w = 600 / WAVE_BARS
	return (
		<div className="wkp-wave-wrap">
			<div
				className="wkp-wave"
				title={current ? "Click to go there" : "Click to play from here"}
				onPointerDown={e => {
					e.currentTarget.setPointerCapture(e.pointerId)
					seekAt(e)
				}}
				onPointerMove={e => {
					if (e.buttons === 1 && e.currentTarget.hasPointerCapture(e.pointerId))
						seekAt(e)
				}}
			>
				<svg
					width="100%"
					height="100%"
					viewBox="0 0 600 100"
					preserveAspectRatio="none"
					aria-hidden="true"
				>
					{bars ? (
						bars.map((p, i) => {
							const h = Math.max(3, p * 84)
							const played = current && (i + 0.5) / WAVE_BARS <= frac
							return (
								<rect
									key={i}
									x={(i * w + w * 0.18).toFixed(1)}
									y={(50 - h / 2).toFixed(1)}
									width={(w * 0.64).toFixed(1)}
									height={h.toFixed(1)}
									className={played ? "wkp-bar is-played" : "wkp-bar"}
								/>
							)
						})
					) : (
						<rect x="0" y="49" width="600" height="2" className="wkp-bar" />
					)}
				</svg>
				{current && (
					<div className="wkp-head" style={{ left: `${frac * 100}%` }} />
				)}
				{peaks === undefined && (
					<span className="wkp-wave-note">Loading waveform…</span>
				)}
			</div>
			<div className="wkp-wave-times">
				<span>0:00</span>
				<span>{total !== null ? formatDuration(total) : ""}</span>
			</div>
		</div>
	)
}

/** Keep / Kept for a recording played from anywhere; disabled when its catalogue id is not known here. */
export function KeepButton({
	id,
	title,
	compact = false,
}: {
	id: string
	title: string
	compact?: boolean
}) {
	const { data } = useServices()
	const readOnly = useReadOnly()
	const items = useStore(data.recordings, s => s.items)
	const known = useStore(keptHere)
	const target = keepTarget(id, items, known)
	const keeping = useStore(data.recordings.marks, m =>
		target.inventoryId === null ? false : m.keeping.has(target.inventoryId),
	)
	const kept = target.kept === true
	const unknown = target.inventoryId === null
	return (
		<button
			type="button"
			className={compact ? "wk-icon-btn wkp-keep" : "wk-btn wkp-keep"}
			data-variant={compact ? undefined : "outline"}
			data-size={compact ? "sm" : undefined}
			aria-pressed={kept}
			aria-label={compact ? (kept ? "Kept" : "Keep") : undefined}
			disabled={readOnly || keeping || unknown}
			title={
				unknown
					? "Open it in Recordings to keep it"
					: kept
						? "Kept: retention never deletes it. Click to unkeep"
						: "Keep: protect it from every retention rule"
			}
			onClick={() =>
				void setKept(data.api, data.recordings, id, !kept).catch(
					(error: unknown) =>
						showAppToast(
							`Could not ${kept ? "unkeep" : "keep"} “${title}”: ${errorMessage(error)}`,
							{ tone: "warn" },
						),
				)
			}
		>
			<RecIcon name="star" size={15} filled={kept} />
			{!compact && (kept ? "Kept" : "Keep")}
		</button>
	)
}
