// "Check for update" on an imported plan with an address (DESIGN.md "Band plans" 4): the core fetches the file
// again and says what changed; nothing changes until Apply, which re-imports over the same plan.
import { useEffect, useRef, useState } from "react"
import type { BandPlanUpdateCheck } from "@wavekit/api-types"

import { useServices } from "../../../app/context.ts"
import { bandplanWriteError } from "../../../data/index.ts"
import { showAppToast } from "../../../shell/toast.ts"

/** "A newer file is there: 2 bands changed, 1 added." The first count names bands, the others follow it. */
export function updateText(c: BandPlanUpdateCheck): string {
	const parts: string[] = []
	for (const [k, word] of [
		[c.changed.length, "changed"],
		[c.added.length, "added"],
		[c.removed.length, "removed"],
	] as const)
		if (k)
			parts.push(
				parts.length
					? `${k} ${word}`
					: `${k} band${k === 1 ? "" : "s"} ${word}`,
			)
	if (!parts.length) return "A newer file is there with the same bands."
	return `A newer file is there: ${parts.join(", ")}. Your edits stay on top.`
}

export function UpdateCheck({
	packId,
	onDone,
}: {
	packId: string
	onDone: () => void
}) {
	const { data } = useServices()
	const stack = data.bandplanStack
	const [check, setCheck] = useState<BandPlanUpdateCheck | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [busy, setBusy] = useState(false)
	const done = useRef(onDone)
	done.current = onDone

	useEffect(() => {
		let live = true
		stack.checkUpdate(packId).then(
			c => {
				if (!live) return
				if (c.upToDate) {
					showAppToast("Already the newest file")
					done.current()
				} else setCheck(c)
			},
			(e: unknown) => {
				if (live) setError(bandplanWriteError(e))
			},
		)
		return () => {
			live = false
		}
	}, [stack, packId])

	const apply = async () => {
		const preview = check?.preview
		const pack = stack.get().view?.packs.find(p => p.id === packId)
		if (!preview || !pack || pack.provenance.kind !== "imported") return
		setBusy(true)
		try {
			await stack.commitImport({
				preview,
				file: {
					format: preview.format,
					fileName: preview.fileName,
					contentBase64: preview.contentBase64,
					groupOverrides: pack.provenance.groupOverrides ?? [],
				},
				name: pack.name,
				keepColourHints: false,
				replacesPackId: packId,
			})
			showAppToast(`${pack.name} updated · ${preview.bands.length} bands`)
			onDone()
		} catch (e) {
			setError(bandplanWriteError(e))
		} finally {
			setBusy(false)
		}
	}

	return (
		<span role="status" className="wkf-bp-update">
			<span className="wkf-grow">
				{error ?? (check ? updateText(check) : "Checking the address…")}
			</span>
			<span className="wkf-bp-updbtns">
				<button
					type="button"
					className="wk-btn"
					data-variant="ghost"
					data-size="sm"
					onClick={onDone}
				>
					{error ? "Close" : "Not now"}
				</button>
				{check && !error && (
					<button
						type="button"
						className="wk-btn"
						data-variant="outline"
						data-size="sm"
						disabled={busy}
						onClick={() => void apply()}
					>
						{busy ? "Applying…" : "Apply"}
					</button>
				)}
			</span>
		</span>
	)
}
