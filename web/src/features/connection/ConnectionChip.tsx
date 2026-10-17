// A quiet status chip over the plot, top centre: the event socket is down or reconnecting, the core
// cannot be reached, or a protected core has no session for this browser (read-only; the chip opens
// the pairing sheet when the core pairs browsers).
import { useState } from "react"

import { isReadOnly, useServices } from "../../app/context.ts"
import { useStore } from "../../data/index.ts"
import { connectionNotice } from "./notice.ts"
import { PairSheet } from "./PairSheet.tsx"

export function ConnectionChip() {
	const { data } = useServices()
	const connection = useStore(data.connection)
	const access = useStore(data.access)
	const [pairing, setPairing] = useState(false)
	const notice = connectionNotice(connection, access, isReadOnly(access))
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
			{notice.detail && <span className="wkf-quiet">{notice.detail}</span>}
		</>
	)
	const tone = notice.tone === "amber" ? "amber" : undefined
	return (
		<div className="wkf-conn" role="status" aria-live="polite">
			{notice.pair ? (
				<button
					type="button"
					className="wk-island wkf-conn-chip"
					data-tone={tone}
					data-action=""
					onClick={() => setPairing(true)}
				>
					{body}
				</button>
			) : (
				<div className="wk-island wkf-conn-chip" data-tone={tone}>
					{body}
				</div>
			)}
			{sheet}
		</div>
	)
}
