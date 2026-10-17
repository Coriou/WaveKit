// The decoded message card (Decode board): one anatomy for every decoder. Header (type tile, protocol, badges, time),
// title and who, the message in full, readings, a position preview with "Open on map", then the frequency (tunes) and
// the JSON toggle.
import type { ActivityRecord, ActivitySummary } from "@wavekit/api-types"
import { WaveKitIcon } from "@wavekit/brand/react"
import { useMemo, useState } from "react"

import { useServices } from "../../app/context.ts"
import { useStore } from "../../data/index.ts"
import { Button } from "../../ui/Button.tsx"
import { cx } from "../../ui/cx.ts"
import { formatMHz } from "../format.ts"
import { showOnMap } from "../map/focus.ts"
import { fieldText, messageView, positionPlot, positionText } from "./card.ts"
import { JsonView } from "./JsonView.tsx"
import "./messages.css"

export interface MessageCardProps {
	item: ActivitySummary
	/** The stored record, once loaded: all fields and the decoded JSON. */
	record?: ActivityRecord | null
	/** Inside another surface (the Activity detail): no panel, no border. */
	flat?: boolean
	/** Tuning is refused (read-only access). */
	readOnly?: boolean
	/** The JSON starts open. */
	jsonOpen?: boolean
	jsonMaxHeight?: number
	className?: string
}

export function MessageCard({
	item,
	record = null,
	flat = false,
	readOnly = false,
	jsonOpen = false,
	jsonMaxHeight = 280,
	className,
}: MessageCardProps) {
	const { data, tuning } = useServices()
	const station = useStore(data.station, s => s.station)
	const v = useMemo(() => messageView(item, record), [item, record])
	const [raw, setRaw] = useState(jsonOpen)
	const home =
		station && station.lat.value !== null && station.lon.value !== null
			? { lat: station.lat.value, lon: station.lon.value }
			: null
	const plot = v.position ? positionPlot(home, v.position) : null
	const hz = v.frequencyHz
	const json = v.raw

	return (
		<article
			className={cx("wkd-card", className)}
			data-flat={flat ? "" : undefined}
			aria-label={`${v.protocol}: ${v.title}`}
		>
			<header className="wkd-head">
				<span className="wk-tile wkd-tile" aria-hidden="true">
					{v.icon ? (
						<WaveKitIcon name={v.icon} size={16} />
					) : (
						<span className="wkd-tile-dot" />
					)}
				</span>
				<span className="wkd-proto">{v.protocol}</span>
				{v.badges.map(b => (
					<span
						key={b.label}
						className="wk-tag"
						data-size="md"
						data-variant={b.variant === "neutral" ? undefined : b.variant}
					>
						{b.label}
					</span>
				))}
				<span className="wkd-grow" />
				<time className="wkd-time" dateTime={item.producedAt}>
					{v.time}
				</time>
			</header>

			<div className="wkd-who">
				<span className="wkd-title" data-large={v.large ? "" : undefined}>
					{v.title}
				</span>
				{v.sub && <span className="wkd-sub">{v.sub}</span>}
			</div>

			{v.text !== null && (
				<p className="wkd-text" data-mono={v.mono ? "" : undefined}>
					{v.text}
				</p>
			)}
			{v.toneOnly && (
				<span className="wkd-note">Tone only. No message body.</span>
			)}

			{v.fields.length > 0 && (
				<dl className="wkd-fields">
					{v.fields.map(f => (
						<div key={f.key} className="wkd-field">
							<dt title={f.label}>{f.label}</dt>
							<dd
								title={fieldText(f)}
								data-state={
									f.key === "battery_ok" && f.value === "Low"
										? "low"
										: undefined
								}
							>
								{fieldText(f)}
							</dd>
						</div>
					))}
				</dl>
			)}

			{v.position && plot && (
				<div className="wkd-pos">
					<span className="wkd-pos-home" aria-hidden="true" />
					{(plot.dx !== 0 || plot.dy !== 0) && (
						<svg
							className="wkd-pos-line"
							viewBox="-40 -40 80 80"
							aria-hidden="true"
						>
							<line x1="0" y1="0" x2={plot.dx} y2={plot.dy} />
						</svg>
					)}
					<span
						className="wkd-pos-dot"
						aria-hidden="true"
						style={{ transform: `translate(${plot.dx}px, ${plot.dy}px)` }}
					/>
					<span className="wkd-pos-text">
						{positionText(v.position)}
						{plot.from && <span className="wkd-pos-from">{plot.from}</span>}
					</span>
					{v.mapId && (
						<button
							type="button"
							className="wkd-pos-open"
							onClick={() => v.mapId && showOnMap(v.mapId)}
						>
							Open on map
						</button>
					)}
				</div>
			)}

			<footer className="wkd-foot">
				{hz !== null && (
					<Button
						variant="ghost"
						size="sm"
						className="wkd-freq"
						disabled={readOnly}
						title={
							readOnly ? "Tuning needs access" : `Tune ${formatMHz(hz)} MHz`
						}
						onClick={() => void tuning.tune(hz)}
					>
						<svg
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeLinecap="round"
							strokeLinejoin="round"
							aria-hidden="true"
						>
							<path d="M3 7c3 0 1.5 10 4.5 10s1.5 -7 4.5 -7s1.5 7 4.5 7s1.5 -10 4.5 -10" />
						</svg>
						{formatMHz(hz)} MHz
					</Button>
				)}
				<span className="wkd-grow" />
				{json !== null && (
					<Button
						variant="ghost"
						size="sm"
						className="wkd-json-toggle"
						aria-expanded={raw}
						onClick={() => setRaw(!raw)}
					>
						{raw ? "Hide JSON" : "JSON"}
					</Button>
				)}
			</footer>
			{raw && json !== null && (
				<JsonView data={json} maxHeight={jsonMaxHeight} />
			)}
		</article>
	)
}
