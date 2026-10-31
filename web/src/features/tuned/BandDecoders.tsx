// The tuned card's "On this band" (band-table.ts): a compact table of the decoders whose band holds the card's
// frequency, from the core's summary (GET /api/decoders/summary?hz=). Each decoder is one row of facts (name and
// program, state, last decode linking to Activity) over a line of detail with at most one action at its right;
// one "Decoder settings" link sits at the foot. Below 280 px the table stacks (band-decoders.css).
import type { DecoderInfo } from "@wavekit/api-types"
import { useEffect, useId, useMemo, useState } from "react"

import { useServices } from "../../app/context.ts"
import { useStore } from "../../data/index.ts"
import { shellStore } from "../../shell/store.ts"
import { showAppToast } from "../../shell/toast.ts"
import { Button } from "../../ui/Button.tsx"
import { Icon } from "../../ui/Icon.tsx"
import { EfficiencyBudgetStore } from "../settings/efficiency-budget.ts"
import { focusSetting } from "../settings/registry.ts"
import { formatMHz } from "../format.ts"
import { scanHoldingDecoders, type BandAction } from "./band-decoders.ts"
import {
	bandTable,
	LIVE_STATES,
	settingsTarget,
	type BandTableRow,
	type SummaryItem,
} from "./band-table.ts"
import { budgetPort, followBudget, raiseBudget } from "./budget-raise.ts"
import type { DecoderVerdictsFeed } from "./verdicts.ts"
import "./band-decoders.css"

/** Links open another place; calls change something and are off in read-only access. */
const isLink = (a: BandAction) => a.kind === "settings" || a.kind === "receiver"

export function BandDecoders({
	hz,
	decoders,
	items,
	feed,
	now,
	readOnly,
}: {
	hz: number
	decoders: readonly DecoderInfo[]
	/** The summary's items for `hz` (verdicts.ts itemsFor); null from a core without the summary. */
	items: readonly SummaryItem[] | null
	feed: DecoderVerdictsFeed
	now: number
	readOnly: boolean
}) {
	const { data, tuning, activity } = useServices()
	const sweep = useStore(data.scanner, s => s.sweep)
	const scanJobId = scanHoldingDecoders(sweep)
	const budgetStore = useMemo(
		() => new EfficiencyBudgetStore(data.api),
		[data.api],
	)
	const budgetWrites = useMemo(
		() => budgetPort(data.api, budgetStore),
		[data.api, budgetStore],
	)
	const budget = useStore(budgetStore, s => s.settings?.resolved ?? null)
	const [busy, setBusy] = useState<string | null>(null)
	const titleId = useId()

	const rows = bandTable(items, decoders, hz, { scanJobId, budget }, now)
	// the budget is read only while a row offers raising it, so a raise at the cap is not offered;
	// it is read again with every verdicts read, so a cap lowered elsewhere offers the raise again
	const wantsBudget =
		items?.some(
			i =>
				i.verdict.actions.includes("raise-budget") &&
				rows.some(r => r.id === i.id),
		) === true
	useEffect(
		() => (wantsBudget ? followBudget(feed, budgetStore) : undefined),
		[wantsBudget, feed, budgetStore],
	)
	if (rows.length === 0) return null

	const run = async (row: BandTableRow, action: BandAction) => {
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
			else if (action.kind === "stop-scan")
				await data.scanner.cancelJob(action.jobId)
			else
				failed = await raiseBudget(budgetWrites, showAppToast, () =>
					feed.soon(),
				)
		} catch (error) {
			failed = error instanceof Error ? error.message : String(error)
		} finally {
			setBusy(null)
		}
		if (failed !== null)
			showAppToast(`${action.label}: ${failed}`, { tone: "warn" })
		feed.soon()
	}
	const openActivity = (row: BandTableRow) => {
		if (row.activityChip === null) return
		activity.setSearch([], row.activityChip)
		shellStore.openDrawer("activity")
	}
	const openSettings = () => {
		focusSetting(settingsTarget(rows))
		shellStore.openDrawer("settings")
	}

	return (
		<section aria-labelledby={titleId} className="wkf-onband">
			<h3 id={titleId} className="wk-label">
				On this band
			</h3>
			<table className="wkf-bt">
				<caption className="wk-sr">
					Decoders whose band holds {formatMHz(hz)} MHz
				</caption>
				<thead>
					<tr>
						<th scope="col">Decoder</th>
						<th scope="col">State</th>
						<th scope="col" className="wkf-bt-last">
							Last decode
						</th>
					</tr>
				</thead>
				{rows.map(row => {
					const a = row.action
					const link = a !== null && isLink(a)
					const live = LIVE_STATES.has(row.state)
					return (
						<tbody key={row.id} className="wkf-bt-dec" data-state={row.state}>
							<tr className="wkf-bt-main">
								<th scope="row" className="wkf-bt-name">
									<span className="wkf-bt-title">{row.name}</span>
									<span className="wkf-bt-prog">{row.protocol}</span>
								</th>
								<td className="wkf-bt-state">
									<span
										className="wkf-state"
										data-tone={live ? "accent" : undefined}
									>
										<span
											className="wkf-dot"
											aria-hidden="true"
											data-off={live ? undefined : true}
										/>
										{row.stateWord}
									</span>
								</td>
								<td className="wkf-bt-last">
									{row.activityChip !== null && row.lastDecodeIso !== null ? (
										<button
											type="button"
											className="wkf-bt-link"
											title={`${row.name} in Activity`}
											onClick={() => openActivity(row)}
										>
											<time dateTime={row.lastDecodeIso}>{row.lastDecode}</time>
										</button>
									) : (
										<span className="wkf-quiet">
											{row.lastDecodeIso !== null ? (
												<time dateTime={row.lastDecodeIso}>
													{row.lastDecode}
												</time>
											) : (
												row.lastDecode
											)}
										</span>
									)}
								</td>
							</tr>
							{(row.detail !== "" || a !== null) && (
								<tr className="wkf-bt-sub">
									<td colSpan={a === null ? 3 : 2} className="wkf-bt-detail">
										{row.detail}
									</td>
									{a !== null && (
										<td className="wkf-bt-act">
											<Button
												size="sm"
												variant={link ? "ghost" : "tonal"}
												title={!link && readOnly ? "Read-only access" : a.title}
												aria-label={`${a.label}: ${row.name}`}
												disabled={busy !== null || (!link && readOnly)}
												onClick={() => void run(row, a)}
											>
												{a.label}
												{link && <Icon name="chevron-right" size={13} />}
											</Button>
										</td>
									)}
								</tr>
							)}
						</tbody>
					)
				})}
			</table>
			<div className="wkf-bt-foot">
				<Button size="sm" variant="ghost" onClick={openSettings}>
					Decoder settings
					<Icon name="chevron-right" size={13} />
				</Button>
			</div>
		</section>
	)
}
