// Station › Location's "Use my location": one position from the browser's geolocation, rounded to about 10 m, as
// the row's "lat, lon" value. Browsers only share a position on HTTPS or localhost, and only after the person
// allows it; each failure says what to do instead. Nothing is saved here: the row stages it for Apply.

export type LocateResult = { value: string } | { error: string }

export interface GeoLike {
	getCurrentPosition(
		ok: (p: { coords: { latitude: number; longitude: number } }) => void,
		fail: (e: { code: number }) => void,
		options?: PositionOptions,
	): void
}

/** Four decimals (about 11 m): plenty for ADS-B ranges and the map, no more than the station needs. */
export const locationValue = (lat: number, lon: number): string =>
	`${Number(lat.toFixed(4))}, ${Number(lon.toFixed(4))}`

const DENIED = 1
const UNAVAILABLE = 2

/** Whether this page can ask at all: geolocation present (secure context checked when asked). */
export function canLocate(): boolean {
	return typeof navigator !== "undefined" && "geolocation" in navigator
}

export function locate(
	geo: GeoLike | undefined = canLocate() ? navigator.geolocation : undefined,
	secure: boolean = typeof window !== "undefined" && window.isSecureContext,
): Promise<LocateResult> {
	if (!geo)
		return Promise.resolve({
			error: "This browser cannot share its location · type the position",
		})
	if (!secure)
		return Promise.resolve({
			error:
				"Browsers share their location only over HTTPS or on localhost · type the position",
		})
	return new Promise(resolve => {
		geo.getCurrentPosition(
			p =>
				resolve({
					value: locationValue(p.coords.latitude, p.coords.longitude),
				}),
			e =>
				resolve({
					error:
						e.code === DENIED
							? "Location is blocked for this site · allow it in the browser, or type the position"
							: e.code === UNAVAILABLE
								? "This device could not find its position · type it instead"
								: "Finding the position took too long · try again, or type it",
				}),
			{ enableHighAccuracy: false, timeout: 15_000, maximumAge: 600_000 },
		)
	})
}
