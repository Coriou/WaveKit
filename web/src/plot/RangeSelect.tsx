// The Shift-drag range on the plot and its "Scan this range" offer (docs/web/canvas/Spectrum.dc.html `rsel`): the offer
// opens the Scanner drawer's plan pane with the range filled in. Its own tiny store, so a drag re-renders this only.
import type { Store } from "../data/index.ts"
import { useStore } from "../data/index.ts"
import { openPlan } from "../features/scanner/ui-store.ts"
import { shellStore } from "../shell/store.ts"
import type { SpectrumViewSpan } from "../spectrum/index.ts"
import { Button, Icon, IconButton } from "../ui/index.ts"
import { rangeBox, rangeText, type RangeSelection } from "./range-select.ts"

/** The offer's root, which the plot's pointer handler leaves alone. */
export const RANGE_OFFER_CLASS = "wk-plot-rsel-offer"

/** Opens "Scan a band" in the Scanner drawer with this range. */
export function scanRange(r: { startHz: number; endHz: number }): void {
	openPlan({ startHz: r.startHz, endHz: r.endHz })
	shellStore.openDrawer("scanner")
}

export function RangeSelect({
	range,
	view,
}: {
	range: Store<RangeSelection | null>
	view: SpectrumViewSpan
}) {
	const r = useStore(range)
	if (!r) return null
	const box = rangeBox(r, view)
	if (!box) return null
	const text = rangeText(r)
	return (
		<>
			<div
				className="wk-plot-rsel"
				aria-hidden="true"
				style={{ left: `${box.left}%`, width: `${box.width}%` }}
			/>
			{r.done && (
				<div className={RANGE_OFFER_CLASS} style={{ left: `${box.mid}%` }}>
					<Button
						variant="primary"
						size="lg"
						aria-label={`Scan this range, ${text} MHz`}
						onClick={() => {
							range.set(null)
							scanRange(r)
						}}
					>
						<Icon name="scanner" size={15} />
						Scan this range <span>{text}</span>
					</Button>
					<IconButton
						size="lg"
						label="Clear the selected range"
						onClick={() => range.set(null)}
					>
						<Icon name="close" size={16} />
					</IconButton>
				</div>
			)}
		</>
	)
}
