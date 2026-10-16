// A quiet status chip over the plot, top centre: the event socket is down or reconnecting, the core
// cannot be reached, or a protected core has no session for this browser (read-only until pairing lands).
import { isReadOnly, useServices } from "../../app/context.ts"
import { useStore } from "../../data/index.ts"
import { connectionNotice } from "./notice.ts"

export function ConnectionChip() {
	const { data } = useServices()
	const connection = useStore(data.connection)
	const access = useStore(data.access)
	const notice = connectionNotice(connection, access, isReadOnly(access))
	if (!notice) return null
	return (
		<div className="wkf-conn" role="status" aria-live="polite">
			<div
				className="wk-island wkf-conn-chip"
				data-tone={notice.tone === "amber" ? "amber" : undefined}
			>
				{notice.busy ? (
					<span className="wk-spinner" aria-hidden="true" />
				) : (
					<span className="wkf-conn-dot" aria-hidden="true" />
				)}
				<b>{notice.title}</b>
				{notice.detail && <span className="wkf-quiet">{notice.detail}</span>}
			</div>
		</div>
	)
}
