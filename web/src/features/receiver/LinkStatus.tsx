// The status place of the receiver's conditions (src/shell/notices/service.ts): a short "Samples lost" marker on
// the Receiver chip while a link condition of its source is active, and every active condition of that source in
// full in the Receiver panel. Both grey while the facts are stale (no fresh resources snapshot).
import { useStore } from "../../data/index.ts"
import { WarnGlyph } from "../../shell/notices/NoticeRegion.tsx"
import {
	notices,
	type Condition,
	type ConditionKey,
	type NoticeService,
} from "../../shell/notices/service.ts"
import { SAMPLES_LOST_LABEL } from "./notices.ts"

/** The source's link condition, or undefined. */
export function linkCondition(
	conditions: ReadonlyMap<ConditionKey, Condition>,
	sourceId: string | null,
): Condition | undefined {
	return sourceId === null ? undefined : conditions.get(`link:${sourceId}`)
}

/** The source's conditions the Receiver panel lists: its link, then a skipped rate raise. */
export function receiverConditions(
	conditions: ReadonlyMap<ConditionKey, Condition>,
	sourceId: string | null,
): Condition[] {
	if (sourceId === null) return []
	const keys: ConditionKey[] = [
		`link:${sourceId}`,
		`rate-policy-skip:${sourceId}`,
	]
	return keys.flatMap(k => {
		const c = conditions.get(k)
		return c ? [c] : []
	})
}

/** On the Receiver chip: an amber triangle and "Samples lost" while the source's link loses samples. */
export function LinkLossMarker({
	sourceId,
	service = notices,
}: {
	sourceId: string | null
	service?: NoticeService
}) {
	const c = useStore(service.conditions, m => linkCondition(m, sourceId))
	if (!c) return null
	return (
		<span
			className="wkf-rx-loss"
			data-stale={c.stale || undefined}
			title={c.stale ? `${c.text} (not current)` : c.text}
		>
			<WarnGlyph size={12} />
			{SAMPLES_LOST_LABEL}
			{c.stale && <span className="wk-sr"> (not current)</span>}
		</span>
	)
}

/** In the Receiver panel: each active condition of the source in full. */
export function ReceiverConditions({
	sourceId,
	service = notices,
}: {
	sourceId: string | null
	service?: NoticeService
}) {
	const map = useStore(service.conditions)
	const list = receiverConditions(map, sourceId)
	if (list.length === 0) return null
	return (
		<div className="wkf-rx-conditions">
			{list.map(c => (
				<div
					key={c.key}
					role="status"
					className="wkf-rx-condition"
					data-stale={c.stale || undefined}
				>
					<WarnGlyph size={14} />
					<span className="wkf-grow">
						{c.text}
						{c.stale && <span className="wkf-quiet"> · not current</span>}
					</span>
				</div>
			))}
		</div>
	)
}
