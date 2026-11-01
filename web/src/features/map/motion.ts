// Smoothed aircraft motion on the Map (pure; the caller passes `now`). Each aircraft keeps one mutable
// MotionState: the accepted track (last plausible fix moved along course at speed, easing to a stop past the
// horizon), a correction that blends the drawn position onto a new track (critically damped, so position and
// velocity stay continuous when a fix arrives), a gate that holds implausible fixes back until a second one
// confirms them, and a glyph heading turned along the shortest arc. advance() mutates the state in place and
// allocates nothing; the state is the drawn position (a LatLon) the marker, label, trail head and card share.

/** 6371 km sphere (geo.ts): 6371 × π / 180 = 111.195 km per degree of latitude. */
const KM_PER_DEG = 111.195
const KN_TO_KM_PER_MS = 1.852 / 3_600_000

/**
 * Fastest ground speed a fix may imply: 1200 kn (fast military jets with a tailwind; airliners rarely pass
 * 650 kn) = 1200 × 1.852 / 3600 = 0.617 km/s. A reported speed above it is clamped to it.
 */
export const MAX_PLAUSIBLE_KN = 1200
const MAX_KM_PER_MS = MAX_PLAUSIBLE_KN * KN_TO_KM_PER_MS
/**
 * Distance any fix may stray beyond that speed: fixes are timed when the browser receives them, so two fixes
 * batched into one update can be ~0 ms apart yet up to a second of flight (0.3 km) and CPR rounding apart; 2 km
 * covers that. A wrong CPR zone lands tens to hundreds of km away and is held back.
 */
export const SLACK_KM = 2
/**
 * After this long without an accepted fix any new fix is taken (no permanent lock-out). By then the gate already
 * allows 60 s × 0.617 km/s + 2 = 39 km.
 */
export const REACQUIRE_MS = 60_000

/** Dead reckoning runs at full speed this long past the last fix. */
export const EXTRAPOLATE_FULL_MS = 10_000
/**
 * Then slows linearly to a stop here, so the plane never runs on with a stale speed or course and never stops
 * dead: the reach is 10 + (20 − 10) / 2 = 15 s of travel (3.5 km at 450 kn), then it holds.
 */
export const EXTRAPOLATE_STOP_MS = 20_000

/**
 * A correction is blended in over about this long (critically damped, ω = 6 / 2000 ms, time constant 333 ms). At
 * BLEND_MS at most (1 + 6)·e⁻⁶ = 1.7 % of it is left (17 m of a 1 km correction); it keeps decaying until under
 * SETTLE_KM, so it never ends in a jump. Half of a correction is done after (1 + x)·e⁻ˣ = 0.5, x = 1.68, 0.56 s.
 */
export const BLEND_MS = 2000
const OMEGA = 6 / BLEND_MS
/**
 * A correction ends (past BLEND_MS) once what is left is under 1 m, so the last step drops at most 1 m (0.004 px at
 * the default zoom). A 1 km one gets there when (1 + x)·e⁻ˣ < 10⁻³, x = 9.23, 3.1 s; an 8 km one at x = 11.6,
 * 3.9 s; even one around the world (20 000 km) at x = 26, 8.7 s.
 */
export const SETTLE_KM = 0.001
/**
 * A correction larger than this is drawn at once instead of blended: noise, CPR rounding and dead reckoning leave
 * well under 1 km (10 s along the tangent of a standard-rate 3°/s turn at 450 kn misses by v·t²·ω / 2 =
 * 0.2315 km/s × 100 s² × 0.0524 rad/s / 2 = 0.6 km), while blending 5 km already peaks at ω·A / e =
 * 0.003/ms × 5 km / 2.718 = 5.5 km/s, 9× the fastest plausible plane: anything more would sweep across the map.
 */
export const SNAP_KM = 5

/** The glyph counts as turned (settling() false) within this of the reported track. */
export const SETTLE_DEG = 0.1

/** The glyph turns toward the reported track with this time constant... */
export const HEADING_TAU_MS = 400
/**
 * ...but never faster than 60°/s: airborne turns are 3–6°/s and taxiing ones under 40°/s, while a single noisy
 * track value then turns the glyph at most 60°/s × its ~0.5 s life = 30°, not a flip.
 */
export const MAX_TURN_DEG_PER_S = 60
const MAX_TURN_DEG_PER_MS = MAX_TURN_DEG_PER_S / 1000
/** A longer gap between steps counts as this long for the heading (a hidden tab comes back already turned). */
const MAX_HEADING_STEP_MS = 5000

export interface Fix {
	readonly lat: number
	readonly lon: number
	/** When the position was received (ms, the browser's clock). */
	readonly posAt: number
	/** Degrees true, null when unknown. */
	readonly course: number | null
	readonly speedKn: number | null
	readonly moving: boolean
}

export interface MotionState {
	/** The drawn position and glyph rotation (degrees true, 0–360) at the last advance(). */
	lat: number
	lon: number
	rotate: number
	/** How fast the drawn position moves (track plus correction), knots. */
	drawnKn: number
	/**
	 * The most it can move from now on, knots: the track speed plus a bound on the correction's speed (a correction
	 * that starts from rest has drawnKn 0 yet moves). The engine's push rate follows it.
	 */
	pushKn: number
	/** The last fix seen, accepted or not (a new one is told by any change). */
	seenLat: number
	seenLon: number
	seenAt: number
	seenCourse: number | null
	seenSpeed: number | null
	/** The accepted track: fix, its time, velocity north and east (km/ms) and course (the glyph turns to it). */
	fixLat: number
	fixLon: number
	fixAt: number
	vN: number
	vE: number
	fixCourse: number | null
	/** A held-back fix waiting for confirmation; candAt is NaN when there is none. */
	candLat: number
	candLon: number
	candAt: number
	/** The correction at offAt (km and km/ms, north and east); offAt is NaN when none is running. */
	oN: number
	oE: number
	ovN: number
	ovE: number
	offAt: number
	/** The previous advance() (the heading steps from it). */
	stepAt: number
	/** Fixes held back so far (for tests and diagnostics). */
	rejected: number
}

const wrapLon = (d: number): number => ((((d + 180) % 360) + 360) % 360) - 180
const cosLat = (lat: number): number =>
	Math.max(0.01, Math.cos((lat * Math.PI) / 180))

/** Equirectangular distance (km): close enough for the gate, no allocation. */
function kmBetween(
	lat1: number,
	lon1: number,
	lat2: number,
	lon2: number,
): number {
	const n = (lat2 - lat1) * KM_PER_DEG
	const e = wrapLon(lon2 - lon1) * KM_PER_DEG * cosLat((lat1 + lat2) / 2)
	return Math.sqrt(n * n + e * e)
}

/** Whether a fix at `at` can follow one at `fromAt` that far away. */
const plausible = (km: number, fromAt: number, at: number): boolean =>
	km <= MAX_KM_PER_MS * Math.max(0, at - fromAt) + SLACK_KM

/** Effective dead-reckoning time `u` ms past the fix: linear, then easing to a stop (see EXTRAPOLATE_STOP_MS). */
export function reach(u: number): number {
	if (u <= 0) return 0
	if (u <= EXTRAPOLATE_FULL_MS) return u
	const span = EXTRAPOLATE_STOP_MS - EXTRAPOLATE_FULL_MS
	const v = Math.min(u, EXTRAPOLATE_STOP_MS) - EXTRAPOLATE_FULL_MS
	return EXTRAPOLATE_FULL_MS + v - (v * v) / (2 * span)
}

/** d reach / du (from the right, so a fix seen the instant it is timed already moves): 1, then falling to 0. */
function reachRate(u: number): number {
	if (u < 0) return 0
	if (u <= EXTRAPOLATE_FULL_MS) return 1
	if (u >= EXTRAPOLATE_STOP_MS) return 0
	return (
		1 - (u - EXTRAPOLATE_FULL_MS) / (EXTRAPOLATE_STOP_MS - EXTRAPOLATE_FULL_MS)
	)
}

/** Shortest signed turn from a to b, degrees in [−180, 180). */
export function shortestArc(a: number, b: number): number {
	return ((((b - a + 180) % 360) + 360) % 360) - 180
}

const norm360 = (d: number): number => ((d % 360) + 360) % 360

/** A state for an aircraft first seen now: drawn at its fix (or its dead-reckoned position), no correction. */
export function createMotion(fix: Fix, now: number): MotionState {
	const s: MotionState = {
		lat: fix.lat,
		lon: fix.lon,
		rotate: norm360(fix.course ?? 0),
		drawnKn: 0,
		pushKn: 0,
		seenLat: Number.NaN,
		seenLon: Number.NaN,
		seenAt: Number.NaN,
		seenCourse: null,
		seenSpeed: null,
		fixLat: fix.lat,
		fixLon: fix.lon,
		fixAt: fix.posAt,
		vN: 0,
		vE: 0,
		fixCourse: null,
		candLat: 0,
		candLon: 0,
		candAt: Number.NaN,
		oN: 0,
		oE: 0,
		ovN: 0,
		ovE: 0,
		offAt: Number.NaN,
		stepAt: now,
		rejected: 0,
	}
	markSeen(s, fix)
	setTrack(s, fix, fix.lat, fix.lon, fix.posAt)
	place(s, now)
	return s
}

function markSeen(s: MotionState, fix: Fix): void {
	s.seenLat = fix.lat
	s.seenLon = fix.lon
	s.seenAt = fix.posAt
	s.seenCourse = fix.course
	s.seenSpeed = fix.speedKn
}

function setTrack(
	s: MotionState,
	fix: Fix,
	lat: number,
	lon: number,
	at: number,
): void {
	s.fixLat = lat
	s.fixLon = lon
	s.fixAt = at
	s.fixCourse = fix.course
	if (!fix.moving || fix.course === null || fix.speedKn === null) {
		s.vN = 0
		s.vE = 0
		return
	}
	const v =
		Math.min(Math.max(0, fix.speedKn), MAX_PLAUSIBLE_KN) * KN_TO_KM_PER_MS
	const c = (fix.course * Math.PI) / 180
	s.vN = v * Math.cos(c)
	s.vE = v * Math.sin(c)
}

/**
 * Track position at `now` into s.lat / s.lon, plus the running correction; also s.drawnKn and s.pushKn. Offsets
 * and velocities east are km at the fix's latitude (cosLat(s.fixLat)), the one basis place() converts with.
 */
function place(s: MotionState, now: number): void {
	const u = now - s.fixAt
	const r = reach(u)
	const rr = reachRate(u)
	let n = s.vN * r
	let e = s.vE * r
	let velN = s.vN * rr
	let velE = s.vE * rr
	let bound = 0
	if (!Number.isNaN(s.offAt)) {
		const t = Math.max(0, now - s.offAt)
		const k = Math.exp(-OMEGA * t)
		const bN = s.ovN + OMEGA * s.oN
		const bE = s.ovE + OMEGA * s.oE
		const cN = (s.oN + bN * t) * k
		const cE = (s.oE + bE * t) * k
		if (t >= BLEND_MS && Math.sqrt(cN * cN + cE * cE) < SETTLE_KM)
			s.offAt = Number.NaN
		else {
			const wN = (bN - OMEGA * (s.oN + bN * t)) * k
			const wE = (bE - OMEGA * (s.oE + bE * t)) * k
			n += cN
			e += cE
			velN += wN
			velE += wE
			// from now on the correction is (c + b·τ)·e^(−ωτ) with b = w + ω·c; its speed |w − ω·b·τ|·e^(−ωτ) is at
			// most |w| + |b|·max(ωτ·e^(−ωτ)) = |w| + |b| / e
			const gN = wN + OMEGA * cN
			const gE = wE + OMEGA * cE
			bound =
				Math.sqrt(wN * wN + wE * wE) + Math.sqrt(gN * gN + gE * gE) / Math.E
		}
	}
	s.lat = s.fixLat + n / KM_PER_DEG
	s.lon = wrapLon(s.fixLon + e / (KM_PER_DEG * cosLat(s.fixLat)))
	s.drawnKn = Math.sqrt(velN * velN + velE * velE) / KN_TO_KM_PER_MS
	s.pushKn =
		(Math.sqrt(s.vN * s.vN + s.vE * s.vE) * rr + bound) / KN_TO_KM_PER_MS
}

/** The drawn velocity (km/ms) at `now`, from the current track and correction. */
function drawnVelocity(s: MotionState, now: number): { n: number; e: number } {
	const rr = reachRate(now - s.fixAt)
	let n = s.vN * rr
	let e = s.vE * rr
	if (!Number.isNaN(s.offAt)) {
		const tt = Math.max(0, now - s.offAt)
		const k = Math.exp(-OMEGA * tt)
		const bN = s.ovN + OMEGA * s.oN
		const bE = s.ovE + OMEGA * s.oE
		n += (bN - OMEGA * (s.oN + bN * tt)) * k
		e += (bE - OMEGA * (s.oE + bE * tt)) * k
	}
	VEL.n = n
	VEL.e = e
	return VEL
}
const VEL = { n: 0, e: 0 }

/**
 * Moves to a new track from the drawn position: the gap between where the plane is drawn and where the new
 * track puts it becomes a correction that decays over BLEND_MS, starting with the drawn velocity, so nothing
 * jumps. `snap` (a confirmed relocation, a fix after a long gap) or a gap over SNAP_KM moves at once instead.
 */
function retrack(
	s: MotionState,
	fix: Fix,
	lat: number,
	lon: number,
	at: number,
	now: number,
	snap: boolean,
): void {
	place(s, now)
	const fromLat = s.lat
	const fromLon = s.lon
	const v = drawnVelocity(s, now)
	const fromVN = v.n
	const fromVE = v.e
	const fromCos = cosLat(s.fixLat)
	setTrack(s, fix, lat, lon, at)
	s.offAt = Number.NaN
	place(s, now)
	if (snap) return
	// east in the new fix's basis, the one place() divides by, so the drawn point does not move (the old velocity
	// east is rescaled the same way: its degrees per ms stay the same)
	const toCos = cosLat(s.fixLat)
	s.oN = (fromLat - s.lat) * KM_PER_DEG
	s.oE = wrapLon(fromLon - s.lon) * KM_PER_DEG * toCos
	if (Math.sqrt(s.oN * s.oN + s.oE * s.oE) > SNAP_KM) return
	const rr = reachRate(now - s.fixAt)
	s.ovN = fromVN - s.vN * rr
	s.ovE = (fromVE * toCos) / fromCos - s.vE * rr
	s.offAt = now
	place(s, now)
}

/**
 * A fix that is new (any change since the last one seen): accept it, hold it back, or confirm a held one. A fix is
 * told by its position alone: the time is when the browser received the message, so a course or speed update for
 * the same position comes a few ms either side of it.
 */
function observe(s: MotionState, fix: Fix, now: number): void {
	markSeen(s, fix)
	if (fix.lat === s.fixLat && fix.lon === s.fixLon) {
		// a new course or speed for the accepted fix: re-extrapolate from it (at its own time), blended
		retrack(s, fix, s.fixLat, s.fixLon, s.fixAt, now, false)
		return
	}
	// an older fix elsewhere (or one timed with the accepted one) would rewind the track and the gate's clock: ignored
	if (fix.posAt <= s.fixAt) return
	const reacquire = fix.posAt - s.fixAt >= REACQUIRE_MS
	const held =
		!Number.isNaN(s.candAt) && fix.lat === s.candLat && fix.lon === s.candLon
	// the held-back fix re-sent (a new course or speed only) is neither another rejection nor its own confirmation
	if (held && !reacquire) return
	const fromAccepted = kmBetween(s.fixLat, s.fixLon, fix.lat, fix.lon)
	if (plausible(fromAccepted, s.fixAt, fix.posAt) || reacquire) {
		const far = !plausible(fromAccepted, s.fixAt, fix.posAt)
		// past EXTRAPOLATE_STOP_MS the drawn plane is held where its track stopped (a hidden tab or layer, a gap in
		// reception): the fix is drawn at once, not swept across the map
		const stale = now - s.fixAt > EXTRAPOLATE_STOP_MS
		s.candAt = Number.NaN
		retrack(s, fix, fix.lat, fix.lon, fix.posAt, now, far || stale)
		return
	}
	if (
		!Number.isNaN(s.candAt) &&
		fix.posAt > s.candAt &&
		plausible(
			kmBetween(s.candLat, s.candLon, fix.lat, fix.lon),
			s.candAt,
			fix.posAt,
		)
	) {
		// two fixes agree on the new place: a real relocation, drawn there at once
		s.candAt = Number.NaN
		retrack(s, fix, fix.lat, fix.lon, fix.posAt, now, true)
		return
	}
	s.candLat = fix.lat
	s.candLon = fix.lon
	s.candAt = fix.posAt
	s.rejected += 1
}

/**
 * Whether the drawn position or glyph is still converging (a correction running, or the glyph more than
 * SETTLE_DEG off the accepted track's course): the engine keeps pushing until it is not, even for a plane that is not
 * moving, and stops for a settled held or stale one. Reads the state as the last advance() left it.
 */
export function settling(s: MotionState): boolean {
	return (
		!Number.isNaN(s.offAt) ||
		(s.fixCourse !== null &&
			Math.abs(shortestArc(s.rotate, s.fixCourse)) > SETTLE_DEG)
	)
}

/** The state at `now` for the item's latest fix: observes a new fix, then places the drawn position and heading. */
export function advance(s: MotionState, fix: Fix, now: number): void {
	if (
		fix.lat !== s.seenLat ||
		fix.lon !== s.seenLon ||
		fix.posAt !== s.seenAt ||
		fix.course !== s.seenCourse ||
		fix.speedKn !== s.seenSpeed
	)
		observe(s, fix, now)
	place(s, now)
	const dt = Math.min(Math.max(0, now - s.stepAt), MAX_HEADING_STEP_MS)
	s.stepAt = now
	// along the accepted track: a held-back fix's course does not turn the glyph
	const course = s.fixCourse
	if (course !== null && dt > 0) {
		const d = shortestArc(s.rotate, course)
		const want = d * (1 - Math.exp(-dt / HEADING_TAU_MS))
		const cap = MAX_TURN_DEG_PER_MS * dt
		s.rotate = norm360(s.rotate + Math.max(-cap, Math.min(cap, want)))
	}
}

/**
 * The engine's motion bookkeeping: one state per aircraft, kept across item rebuilds and dropped when the
 * aircraft leaves. Pushes advance the states of drawn aircraft; the card reads drawnAt().
 */
export class MotionBook {
	private readonly states = new Map<string, MotionState>()

	get size(): number {
		return this.states.size
	}

	has(id: string): boolean {
		return this.states.has(id)
	}

	/** The aircraft's state advanced to `now` (created on first sight). */
	advance(id: string, fix: Fix, now: number): MotionState {
		let m = this.states.get(id)
		if (m) advance(m, fix, now)
		else {
			m = createMotion(fix, now)
			this.states.set(id, m)
		}
		return m
	}

	/** Drops the state of every aircraft `has` no longer knows. */
	retain(has: (id: string) => boolean): void {
		for (const id of this.states.keys()) if (!has(id)) this.states.delete(id)
	}

	/**
	 * Where the card puts the aircraft: while its layer is drawn, the state as the last push left it (the marker's
	 * place, even between pushes); while it is hidden nothing advances it, so it is advanced to `now` here.
	 */
	drawnAt(id: string, fix: Fix, now: number, drawn: boolean): MotionState {
		const m = this.states.get(id)
		return m && drawn ? m : this.advance(id, fix, now)
	}
}
