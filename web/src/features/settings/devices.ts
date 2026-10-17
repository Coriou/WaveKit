// Settings › Devices (the canvas Settings board's "Signed-in devices" row, page drawn here first): words for the
// browsers and apps a protected core remembers. Pure; the page renders them and tests run here.
import type { AccessDeviceDto, AccessDeviceKind } from "@wavekit/api-types"
import { ACCESS_DEVICE_KINDS } from "@wavekit/api-types"

import { dateText, sameDay, yearOf } from "../display.ts"
import type { SetIconName } from "./icons.tsx"

export const KIND_LABEL: Readonly<Record<AccessDeviceKind, string>> = {
	browser: "Browser",
	phone: "Phone",
	tablet: "Tablet",
	desktop: "Computer",
	cli: "Command line",
	other: "Other",
}

export const KIND_ICON: Readonly<Record<AccessDeviceKind, SetIconName>> = {
	browser: "browser",
	phone: "phone",
	tablet: "tablet",
	desktop: "desktop",
	cli: "terminal",
	other: "server",
}

export const KIND_OPTIONS = ACCESS_DEVICE_KINDS.map(k => ({
	value: k,
	label: KIND_LABEL[k],
}))

/** The name an operator gave it, else "Unnamed phone" (a browser when nothing is known). */
export function deviceTitle(d: Pick<AccessDeviceDto, "name" | "kind">): string {
	if (d.name) return d.name
	return `Unnamed ${KIND_LABEL[d.kind ?? "browser"].toLowerCase()}`
}

const HOUR = 3_600_000
const DAY = 24 * HOUR

function dayText(ms: number, now: number): string {
	if (sameDay(ms, now)) return "today"
	if (sameDay(ms + DAY, now)) return "yesterday"
	return dateText(
		ms,
		yearOf(ms) === yearOf(now)
			? { day: "numeric", month: "short" }
			: { day: "numeric", month: "short", year: "numeric" },
	)
}

/** `lastSeenAt` is the start of a UTC hour: "used this hour", "used 3 h ago", "used yesterday". */
export function lastUsedText(lastSeenAt: number, now: number): string {
	const hours = Math.floor((now - lastSeenAt) / HOUR)
	if (hours <= 0) return "used this hour"
	if (hours < 12) return `used ${hours} h ago`
	return `used ${dayText(lastSeenAt, now)}`
}

/** "Paired 12 Oct · used 3 h ago · signed in until 14 Nov". */
export function deviceSub(d: AccessDeviceDto, now: number): string {
	const parts = [`Paired ${dayText(d.createdAt, now)}`]
	if (d.lastSeenAt !== null && d.lastSeenAt !== undefined)
		parts.push(lastUsedText(d.lastSeenAt, now))
	const left = d.expiresAt - now
	parts.push(
		left < DAY
			? "signs out within a day"
			: `signed in until ${dayText(d.expiresAt, now)}`,
	)
	return parts.join(" · ")
}

/** The Settings row's help: "This browser, Ben's iPhone and 2 more". */
export function devicesSummary(devices: readonly AccessDeviceDto[]): string {
	const names = devices.map(d => (d.current ? "This browser" : deviceTitle(d)))
	if (names.length <= 2) return names.join(" and ")
	return `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`
}

export const devicesCount = (n: number): string =>
	n === 1 ? "1 device" : `${n} devices`
