// The Scanner drawer's attached pane: "Scan a band" (setup, or running mode while a sweep runs).
import { ScanPlanner } from "../../features/scanner/planner/ScanPlanner.tsx"
import type { PaneContentProps } from "./types.ts"

export default function ScanPlanPane({ mode, onHide }: PaneContentProps) {
	return <ScanPlanner mode={mode} onHide={onHide} />
}
