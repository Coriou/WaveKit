// The selection panel's parts that draw selectionInfo() (items.ts) as it is: the aircraft photo, the emergency
// alert, the planned route, the live fields and the aircraft's identity. No hooks on the map or the data stores,
// so they render (and are tested) on their own.
import { useState } from "react"

import type { AircraftDetails, Field, SelectionInfo } from "./items.ts"

/** The airframe's photo; the credit links back to the photo page, as Planespotters' terms require. */
export function AircraftPhoto(props: {
	src: string
	credit: string | null
	link: string | null
}) {
	const [state, setState] = useState<"loading" | "ok" | "failed">("loading")
	if (state === "failed") return null
	return (
		<figure className="wkm-photo" data-state={state}>
			<img
				src={props.src}
				alt=""
				loading="lazy"
				decoding="async"
				referrerPolicy="no-referrer"
				onLoad={() => setState("ok")}
				onError={() => setState("failed")}
			/>
			{props.credit &&
				(props.link ? (
					<a href={props.link} target="_blank" rel="noopener noreferrer">
						{props.credit}
					</a>
				) : (
					<figcaption>{props.credit}</figcaption>
				))}
		</figure>
	)
}

/** An aircraft's emergency, announced once when it appears. */
export function EmergencyAlert({ text }: { text: string }) {
	return (
		<p className="wkm-alert" role="alert">
			<svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
				<path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
			</svg>
			<span>{text}</span>
		</p>
	)
}

/** The callsign's planned route (crowd-sourced, so labelled as planned). */
export function PlannedRoute(props: NonNullable<AircraftDetails["route"]>) {
	return (
		<div
			className="wkm-route"
			role="group"
			aria-label={`Planned route from ${props.fromName} to ${props.toName}`}
		>
			<div className="wkm-route-ends">
				<span>
					<b className="wk-h3">{props.from}</b>
					<span className="wkm-dim wkm-ellipsis">{props.fromName}</span>
				</span>
				<svg width="44" height="12" viewBox="0 0 44 12" aria-hidden="true">
					<path d="M1 6h40M36 2l5 4-5 4" />
				</svg>
				<span data-end="">
					<b className="wk-h3">{props.to}</b>
					<span className="wkm-dim wkm-ellipsis">{props.toName}</span>
				</span>
			</div>
			<span className="wkm-dim">
				Planned route · from the callsign, may differ
			</span>
		</div>
	)
}

/** One value: the number, its unit set smaller, a climb arrow spoken as a word, an emergency meaning spoken. */
function FieldValue({ text, meta }: { text: string; meta: Field[2] }) {
	const unit = meta?.unit
	const number =
		unit && text.endsWith(` ${unit}`) ? text.slice(0, -(unit.length + 1)) : text
	return (
		<>
			{meta?.trend && (
				<>
					<span className="wkm-trend" aria-hidden="true">
						{meta.trend === "up" ? "↑" : "↓"}
					</span>
					<span className="wk-sr">
						{meta.trend === "up" ? "Climbing " : "Descending "}
					</span>
				</>
			)}
			{number}
			{number !== text && <span className="wkm-unit"> {unit}</span>}
			{meta?.alert && <span className="wk-sr">, {meta.alert}</span>}
		</>
	)
}

/** The live fields: a two-column list of label and value, fixed cells and tabular figures so updates never jump. */
export function SelectionFields({
	fields,
	label,
}: {
	fields: SelectionInfo["fields"]
	label: string
}) {
	return (
		<dl className="wkm-fields" aria-label={label}>
			{fields.map(([k, text, meta]) => (
				<div
					key={k}
					{...(meta?.alert ? { "data-tone": "danger" } : {})}
					{...(text === "—" ? { "data-empty": "" } : {})}
				>
					<dt>{k}</dt>
					<dd>
						<FieldValue text={text} meta={meta} />
					</dd>
				</div>
			))}
		</dl>
	)
}

/** Registration, type (with its ICAO code), operator, country, address, year. */
export function AircraftIdentity({ rows }: { rows: AircraftDetails["ident"] }) {
	if (rows.length === 0) return null
	return (
		<section className="wkm-ident" aria-label="Aircraft">
			<h3 className="wk-label">Aircraft</h3>
			<dl>
				{rows.map(([k, val, hint]) => (
					<div key={k}>
						<dt>{k}</dt>
						<dd>
							{val}
							{hint && (
								<>
									{" "}
									<abbr className="wkm-code" title="ICAO type code">
										{hint}
									</abbr>
								</>
							)}
						</dd>
					</div>
				))}
			</dl>
		</section>
	)
}
