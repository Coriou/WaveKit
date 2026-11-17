// A quiet status chip, a guest in the shell's status slot (src/shell/layout/compute.ts, "Status slot"): beside the
// condition notice against the Receiver on a wide window (title only when the slot is tight), in the strip under the
// top rail on a phone, or in a covering drawer's notice slot. It reports its natural widths (whole, title only) and
// takes the rectangle the layout gives it. It shows while the event socket is down or reconnecting, the core cannot be
// reached, the core refuses the page's address (the chip links to the other loopback name), or a protected core has
// no session for this browser (read-only; the chip opens the pairing sheet when the core pairs browsers).
import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"

import { isReadOnly, useServices } from "../../app/context.ts"
import { useStore } from "../../data/index.ts"
import { slotAttrs, topLeft } from "../../shell/layout/slot.ts"
import {
	dockedSlot,
	publishedLayout,
	statusReports,
} from "../../shell/layout/stores.ts"
import { connectionNotice } from "./notice.ts"
import { PairSheet } from "./PairSheet.tsx"

const ID = "connection"

export function ConnectionChip() {
	const { data } = useServices()
	const connection = useStore(data.connection)
	const access = useStore(data.access)
	const placed = useStore(
		publishedLayout,
		l => l?.status.items.find(i => i.id === ID) ?? null,
	)
	const docked = useStore(
		publishedLayout,
		l => l?.status.docked.includes(ID) ?? false,
	)
	const shell = useStore(publishedLayout, l => l !== null)
	const slot = useStore(dockedSlot)
	const [pairing, setPairing] = useState(false)
	const chip = useRef<HTMLElement | null>(null)
	const notice = connectionNotice(
		connection,
		access,
		isReadOnly(access),
		window.location.href,
		document.referrer,
	)
	// natural widths: the title and detail spans report their full text width even while clipped
	useLayoutEffect(() => {
		const el = chip.current
		if (!notice || !el) {
			statusReports.withdraw(ID)
			return
		}
		const [full, title] = naturalWidths(el)
		const h = el.offsetHeight || 36
		statusReports.report({
			id: ID,
			kind: "connection",
			forms: { full: { w: full, h }, compact: { w: title, h } },
		})
	})
	useEffect(() => () => statusReports.withdraw(ID), [])
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
	const titleOnly = placed?.form === "compact" || undefined
	const setChip = (el: HTMLElement | null) => {
		chip.current = el
	}
	const content = notice.pair ? (
		<button
			type="button"
			ref={setChip}
			className="wk-island wkf-conn-chip"
			data-tone={tone}
			data-title-only={titleOnly}
			data-action=""
			onClick={() => setPairing(true)}
		>
			{body}
		</button>
	) : notice.href !== undefined ? (
		<a
			ref={setChip}
			className="wk-island wkf-conn-chip"
			data-tone={tone}
			data-title-only={titleOnly}
			data-action=""
			href={notice.href}
			title={notice.detail ?? undefined}
		>
			{body}
		</a>
	) : (
		<div
			ref={setChip}
			className="wk-island wkf-conn-chip"
			data-tone={tone}
			data-title-only={titleOnly}
		>
			{body}
		</div>
	)
	// no shell: its own place at the top centre (features.css)
	if (!shell)
		return (
			<div className="wkf-conn" role="status" aria-live="polite">
				{content}
				{sheet}
			</div>
		)
	const guest = (
		<div
			className="wk-status-guest"
			role="status"
			aria-live="polite"
			{...slotAttrs(`status:${ID}`, docked ? null : placed)}
			data-pending={!docked && !placed ? "" : undefined}
			style={
				docked
					? undefined
					: placed
						? topLeft(placed, true)
						: { left: 0, top: 0, width: "max-content" }
			}
		>
			{content}
		</div>
	)
	return (
		<>
			{docked && slot ? createPortal(guest, slot) : guest}
			{sheet}
		</>
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
