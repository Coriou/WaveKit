// What the shell layout shares with elements outside the shell's own tree (the connection chip lives beside the
// shell; the notice region and the plot's paused label are guests in the status slot): the sizes they report, the
// layout the shell computed from them, and where docked status items go. Reporting a size is the only thing a
// guest does about its place; the rectangle comes back from the layout.
import { createContext } from "react"

import { Store } from "../../data/store.ts"
import type { Layout, Size, StatusItem } from "./compute.ts"

const sameSize = (a: Size | undefined, b: Size | undefined) =>
	a === b || (a !== undefined && b !== undefined && a.w === b.w && a.h === b.h)

const sameItem = (a: StatusItem, b: StatusItem) =>
	a.kind === b.kind &&
	sameSize(a.forms.full, b.forms.full) &&
	sameSize(a.forms.compact, b.forms.compact) &&
	sameSize(a.forms.icon, b.forms.icon)

/** The status items that want a place now, by id, with their measured forms. */
export class StatusReports extends Store<ReadonlyMap<string, StatusItem>> {
	constructor() {
		super(new Map())
	}

	report(item: StatusItem): void {
		const had = this.get().get(item.id)
		if (had && sameItem(had, item)) return
		const next = new Map(this.get())
		next.set(item.id, item)
		this.set(next)
	}

	withdraw(id: string): void {
		if (!this.get().has(id)) return
		const next = new Map(this.get())
		next.delete(id)
		this.set(next)
	}
}

export const statusReports = new StatusReports()

/** The layout the shell rendered last (null while no shell is mounted). */
export const publishedLayout = new Store<Layout | null>(null)

/** The open drawer's notice slot element while status items dock in it, else null. */
export const dockedSlot = new Store<HTMLElement | null>(null)

/** The reader minimised the tuned card to its line (reported by the card; the layout sizes its slot for it). */
export const cardMinimised = new Store<boolean>(false)

/** The tuned card shows its minimised line because its expanded form has no room (not the reader's choice). */
export const cardLineForced = new Store<boolean>(false)

/** The plot's part of the layout, for the plot inside the shell (null outside a shell). */
export const PlotLayoutContext = createContext<Layout["plot"] | null>(null)
