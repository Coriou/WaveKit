// "Scan a band" (docs/web/DESIGN.md, Scanner UX review and second pass; canvas ScanPlanner.dc.html): the Scanner
// drawer's attached pane, or a screen pushed into the drawer on narrow windows. Setup composes a sweep (presets,
// band-plan lanes, a ruler, the range table, options, the plan preview and the consent line); while the operator's
// sweep runs it is the running plan (RunningPlan.tsx).
import "./planner.css"

import { useEffect, useRef, useState } from "react"

import { useServices } from "../../../app/context.ts"
import { useStore } from "../../../data/store.ts"
import type { PlannerSize } from "./parts.tsx"
import { useWidth } from "./SetupRuler.tsx"
import { RunningPlan } from "./RunningPlan.tsx"
import { SetupPlan } from "./SetupPlan.tsx"

export interface ScanPlannerProps {
	/** `pane`: attached left of the drawer, with Hide; `screen`: pushed into the drawer, with "‹ Scanner". */
	mode: "pane" | "screen"
	onHide: () => void
}

export function plannerSize(width: number): PlannerSize {
	return width >= 860 ? "wide" : width >= 560 ? "two" : "narrow"
}

export function ScanPlanner({ mode, onHide }: ScanPlannerProps) {
	const { data } = useServices()
	const sweep = useStore(data.scanner, s => s.sweep)
	const [widthRef, width] = useWidth<HTMLDivElement>()
	const [root, setRoot] = useState<HTMLDivElement | null>(null)
	const size = plannerSize(width || 900)

	// running mode needs a sweep: when the scan ends while it shows, the plan closes
	const hadSweep = useRef(sweep !== null)
	useEffect(() => {
		if (hadSweep.current && sweep === null) onHide()
		hadSweep.current = sweep !== null
	}, [sweep, onHide])

	return (
		<div
			ref={el => {
				setRoot(el)
				widthRef(el)
			}}
			className="wk-pl"
			data-mode={mode}
			data-size={size}
		>
			{sweep ? (
				<RunningPlan
					job={sweep}
					mode={mode}
					size={size}
					root={root}
					onHide={onHide}
				/>
			) : (
				<SetupPlan mode={mode} size={size} root={root} onHide={onHide} />
			)}
		</div>
	)
}

export default ScanPlanner
