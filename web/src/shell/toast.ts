// The app toast for what a user action did (a receipt: "Saved", "Copied", with Undo when it can be taken back):
// one at a time in the notice region at the top centre of the free plot. Conditions the app is in (a link
// dropping samples, an update waiting for Reload) are not toasts from here: see ./notices/service.ts.
import {
	notices,
	RECEIPT_MS,
	type Receipt,
	type ReceiptOptions,
} from "./notices/service.ts"

export type AppToast = Receipt

/** The receipt on screen. */
export const appToast = notices.receipt

export const TOAST_MS = RECEIPT_MS

export function showAppToast(text: string, options: ReceiptOptions = {}): void {
	notices.showReceipt(text, options)
}

export function dismissAppToast(): void {
	notices.dismissReceipt()
}
