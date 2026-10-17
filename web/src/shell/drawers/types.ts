/** Props every lazy drawer module's default export takes. */
export interface DrawerContentProps {
	onClose: () => void
}

/** Props of a drawer's attached pane content (src/shell/panes.ts). */
export interface PaneContentProps {
	/** `pane`: attached left of the drawer; `screen`: pushed into the full-width drawer, with a back button. */
	mode: "pane" | "screen"
	/** Hide the pane (its Hide button, Esc, or the screen's back button); the drawer stays. */
	onHide: () => void
}
