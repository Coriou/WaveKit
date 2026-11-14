// What draws the spectrum, as the plot shows it: the basic-mode chip, or the reason there is no renderer.
// Kept apart from Plot.tsx so it is testable without a DOM.

export interface PlotGraphics {
	kind: "webgl2" | "canvas2d" | "none"
	reason: string | null
}

export type GraphicsEvent =
	/** The engine says what draws. */
	| { type: "renderer"; kind: PlotGraphics["kind"]; reason?: string }
	/** The canvas remounts (WebGL2 is back): the old canvas's state says nothing about the new one. */
	| { type: "remount" }

/** The plot's graphics state after `event`: null until the (new) canvas's engine has spoken. */
export function graphicsAfter(event: GraphicsEvent): PlotGraphics | null {
	return event.type === "remount"
		? null
		: { kind: event.kind, reason: event.reason ?? null }
}
