// The Scanner drawer's lists on the panels' one virtual list (ui/virtual-rows.ts).
import type { VirtualRows } from "../../../ui/virtual-rows.ts"
import { useVirtualRows } from "../../../ui/virtual-rows.ts"

export type VirtualList = VirtualRows

export function useVirtual(
	keys: readonly string[],
	estimate: (index: number) => number,
	onNearEnd?: () => void,
): VirtualList {
	return useVirtualRows({ keys, estimate, onNearEnd })
}
