// The tuned card's "On this band" (band-decoders.ts): which decoders listen on the tuned band and, for one that does
// not, the core's one-line verdict with its first suggested action. Settings stays the place to turn a decoder off;
// actions without a safe one-click call open Settings or the Receiver instead.
import type { DecoderInfo } from "@wavekit/api-types"
import { useEffect, useMemo, useState } from "react"

import { useServices } from "../../app/context.ts"
import { useStore } from "../../data/index.ts"
import { shellStore } from "../../shell/store.ts"
import { showAppToast } from "../../shell/toast.ts"
import { Button } from "../../ui/Button.tsx"
import { Icon } from "../../ui/Icon.tsx"
import { EfficiencyBudgetStore } from "../settings/efficiency-budget.ts"
import { focusSetting } from "../settings/registry.ts"
import {
	bandDecoders,
	raisedBudget,
	type BandAction,
	type BandDecoderRow,
} from "./band-decoders.ts"
import { DecoderVerdictsFeed } from "./verdicts.ts"
import "./band-decoders.css"

/** Links open another place; calls change something and are off in read-only access. */
const isLink = (a: BandAction) => a.kind === "settings" || a.kind === "receiver"

export function BandDecoders({
	hz,
	decoders,
	readOnly,
}: {
	hz: number
	decoders: readonly DecoderInfo[]
	readOnly: boolean
}) {
	const { data, tuning } = useServices()
	const feed = useMemo(() => new DecoderVerdictsFeed(data), [data])
	useEffect(() => feed.attach(), [feed])
	const verdicts = useStore(feed, s => s.verdicts)
	const sweep = useStore(data.scanner, s => s.sweep)
	const scanJobId = sweep?.state === "running" ? sweep.id : null
	const [busy, setBusy] = useState<string | null>(null)

	const rows = bandDecoders(decoders, verdicts, hz, { scanJobId })
	if (rows.length === 0) return null

	const raiseBudget = async (): Promise<string | null> => {
		const store = new EfficiencyBudgetStore(data.api)
		await store.load()
		const s = store.get()
		if (s.unavailable) return "This WaveKit has no CPU budget setting"
		if (!s.settings) return s.error ?? "The CPU budget could not be read"
		const before = s.settings.cpuBudgetCores
		const next = raisedBudget(s.settings.resolved)
		if (next === null) return "The CPU budget is already at its maximum"
		const result = await store.save(next)
		if (!result.ok) return result.message
		showAppToast(`CPU budget raised to ${next} cores`, {
			undo: () =>
				void store.save(before).then(
					() => feed.soon(),
					() => undefined,
				),
		})
		return null
	}

	const run = async (row: BandDecoderRow, action: BandAction) => {
		switch (action.kind) {
			case "settings":
				focusSetting(action.settingId)
				shellStore.openDrawer("settings")
				return
			case "receiver":
				shellStore.openPanel("receiver")
				return
		}
		setBusy(row.id)
		let failed: string | null = null
		try {
			if (action.kind === "decoder") {
				const result = await data.decoderSettings.action(row.id, action.op)
				if (!result.ok) failed = result.message
			} else if (action.kind === "tune") await tuning.tune(action.hz)
			else if (action.kind === "pause-scan")
				await data.scanner.pauseJob(action.jobId)
			else failed = await raiseBudget()
		} catch (error) {
			failed = error instanceof Error ? error.message : String(error)
		} finally {
			setBusy(null)
		}
		if (failed !== null)
			showAppToast(`${action.label}: ${failed}`, { tone: "warn" })
		feed.soon()
	}

	return (
		<section aria-label="Decoders on this band" className="wkf-band">
			<h3 className="wk-label">On this band</h3>
			<ul className="wkf-band-list">
				{rows.map(row => {
					const a = row.action
					const link = a !== null && isLink(a)
					return (
						<li key={row.id} className="wkf-band-row">
							<span
								className="wkf-state wkf-band-state"
								data-tone={row.listening ? "accent" : undefined}
							>
								<span
									className="wkf-dot"
									aria-hidden="true"
									data-off={row.listening ? undefined : true}
								/>
								<span className="wkf-band-text">{row.text}</span>
							</span>
							{a !== null && (
								<Button
									size="sm"
									variant={link ? "ghost" : "tonal"}
									className="wkf-band-act"
									title={!link && readOnly ? "Read-only access" : a.title}
									aria-label={`${a.label}: ${row.name}`}
									disabled={busy !== null || (!link && readOnly)}
									onClick={() => void run(row, a)}
								>
									{a.label}
									{link && <Icon name="chevron-right" size={13} />}
								</Button>
							)}
						</li>
					)
				})}
			</ul>
		</section>
	)
}
