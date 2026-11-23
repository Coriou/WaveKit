import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it } from "vitest"

import { ServicesContext } from "../../src/app/context.ts"
import { createServices, type AppServices } from "../../src/app/services.ts"
import { RecordingsDrawer } from "../../src/features/recordings/RecordingsDrawer.tsx"
import { transmissionNav } from "../../src/features/transmission/nav.ts"
import ActivityDrawer from "../../src/shell/drawers/ActivityDrawer.tsx"

let services: AppServices | null = null
afterEach(() => {
	transmissionNav.set(null)
	services?.dispose()
	services = null
})

function render(node: ReturnType<typeof createElement>): string {
	services = createServices()
	return renderToStaticMarkup(
		createElement(ServicesContext.Provider, { value: services }, node),
	)
}

describe("the Transmission view in its host drawer", () => {
	it("takes the Recordings list's place, Back naming it", () => {
		transmissionNav.set({
			ref: { recording: "scan:d_A~a.wav" },
			origin: { host: "recordings", label: "Recordings" },
			summary: null,
		})
		const html = render(
			createElement(RecordingsDrawer, { onClose: () => undefined }),
		)
		expect(html).toContain("‹ Recordings")
		expect(html).toContain('aria-label="Transmission"')
		expect(html).not.toContain('aria-label="Search recordings"')
	})

	it("leaves the Recordings list alone when it is not open there", () => {
		transmissionNav.set({
			ref: { event: "evt_1" },
			origin: { host: "activity", label: "Back" },
			summary: null,
		})
		const html = render(
			createElement(RecordingsDrawer, { onClose: () => undefined }),
		)
		expect(html).not.toContain('aria-label="Transmission"')
	})

	it("is pushed over Activity's list, which stays mounted underneath", () => {
		transmissionNav.set({
			ref: { event: "evt_1" },
			origin: { host: "activity", label: "Activity" },
			summary: null,
		})
		const html = render(
			createElement(ActivityDrawer, { onClose: () => undefined }),
		)
		expect(html).toContain("‹ Activity")
		expect(html).toMatch(/class="wka-browse" hidden=""/)
		expect(html).toContain('aria-label="Search activity"')
	})
})
