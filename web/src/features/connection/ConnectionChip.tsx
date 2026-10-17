// A quiet status chip over the plot, in the top-row gap between the Tuner and the Receiver (title only when the
// gap is tight, under the top row when it is too tight, as beside a full-height drawer): the event socket is down or reconnecting, the core
// cannot be reached, or a protected core has no session for this browser (read-only; the chip opens
// the pairing sheet when the core pairs browsers).
import { useLayoutEffect, useRef, useState } from "react"

import { isReadOnly, useServices } from "../../app/context.ts"
import { useStore } from "../../data/index.ts"
import { overlaySlot } from "../../shell/overlay-slot.ts"
import { chipPlace, connectionNotice, type ChipPlace } from "./notice.ts"
import { PairSheet } from "./PairSheet.tsx"

export function ConnectionChip() {
	const { data } = useServices()
	const connection = useStore(data.connection)
	const access = useStore(data.access)
	const slot = useStore(overlaySlot)
	const [pairing, setPairing] = useState(false)
	const [place, setPlace] = useState<ChipPlace | null>(null)
	const chip = useRef<HTMLElement | null>(null)
	const notice = connectionNotice(connection, access, isReadOnly(access))
	// natural widths: the title and detail spans report their full text width even while clipped
	useLayoutEffect(() => {
		const el = chip.current
		const next = el && slot ? chipPlace(slot, ...naturalWidths(el)) : null
		setPlace(p => (samePlace(p, next) ? p : next))
	}, [slot, notice?.title, notice?.detail])
	const sheet = pairing && notice?.pair && (
		<PairSheet onClose={() => setPairing(false)} />
	)
	if (!notice) return null
	const body = (
		<>
			{notice.busy ? (
				<span className="wk-spinner" aria-hidden="true" />
			) : (
				<span className="wkf-conn-dot" aria-hidden="true" />
			)}
			<b>{notice.title}</b>
			{notice.detail && (
				<span className="wkf-quiet wkf-conn-detail">{notice.detail}</span>
			)}
		</>
	)
	const tone = notice.tone === "amber" ? "amber" : undefined
	const style = place
		? { left: place.x + place.w / 2, top: place.top, maxWidth: place.w - 32 }
		: undefined
	const titleOnly = place?.titleOnly || undefined
	return (
		<div
			className="wkf-conn"
			role="status"
			aria-live="polite"
			data-placed={place ? "" : undefined}
			style={style}
		>
			{notice.pair ? (
				<button
					type="button"
					ref={el => {
						chip.current = el
					}}
					className="wk-island wkf-conn-chip"
					data-tone={tone}
					data-title-only={titleOnly}
					data-action=""
					onClick={() => setPairing(true)}
				>
					{body}
				</button>
			) : (
				<div
					ref={el => {
						chip.current = el
					}}
					className="wk-island wkf-conn-chip"
					data-tone={tone}
					data-title-only={titleOnly}
				>
					{body}
				</div>
			)}
			{sheet}
		</div>
	)
}

function naturalWidths(el: HTMLElement): [full: number, title: number] {
	const cs = getComputedStyle(el)
	const gap = parseFloat(cs.columnGap) || 0
	const pad = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight)
	const lead = (el.firstElementChild as HTMLElement | null)?.offsetWidth ?? 0
	const title = el.querySelector("b")?.scrollWidth ?? 0
	const detail = el.querySelector<HTMLElement>(".wkf-conn-detail")?.scrollWidth
	const titleW = Math.ceil(pad + lead + gap + title)
	return [
		detail === undefined ? titleW : Math.ceil(titleW + gap + detail),
		titleW,
	]
}

function samePlace(a: ChipPlace | null, b: ChipPlace | null): boolean {
	if (a === null || b === null) return a === b
	return (
		a.x === b.x && a.w === b.w && a.top === b.top && a.titleOnly === b.titleOnly
	)
}
