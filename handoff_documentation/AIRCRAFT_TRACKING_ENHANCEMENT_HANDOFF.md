# Aircraft Tracking Enhancement Handoff

> **Last Updated**: 2026-01-15

## ⚠️ Important Context

**Before starting, read the main `readme.md` to understand WaveKit's full scope.**

WaveKit is a multi-protocol SDR decoder platform supporting ADS-B, AIS, ACARS, VDL2, DMR, P25, APRS, POCSAG, and more. This enhancement work is **ADS-B specific** and must not affect other decoder pipelines.

## Scope

This document covers enhancements to the **ADS-B aircraft tracking system only**:

- Aircraft enrichment via hexdb.io
- CLI display improvements for aircraft
- Aircraft-specific type definitions

**Do NOT modify**:

- Other decoder implementations (AIS, ACARS, DMR, etc.)
- Core infrastructure (source manager, fanout, etc.)
- Shared components unless adding ADS-B-specific branches

## Current Implementation Status

### ✅ Completed Features

| Feature | Status | Implementation |
|---------|--------|----------------|
| ADS-B Decoding (readsb) | ✅ Complete | ICAO, callsign, squawk, position, altitude, speed, track, nav modes |
| Aircraft Enrichment (hexdb.io) | ✅ Complete | Registration, type, manufacturer, operator (all 7 API fields) |
| Aircraft Image URLs | ✅ Complete | Fetched in parallel, cached, displayed as clickable 📷 in CLI |
| LRU Cache (24h TTL, 10k entries) | ✅ Complete | `aircraft-enrichment-service.ts` |
| Rate Limiting (1 req/s) | ✅ Complete | Queue-based with rate limiting |
| CLI Display (Rich Cards) | ✅ Complete | Emergency squawks, trend indicators, track direction |
| Documentation | ✅ Complete | `docs/ADSB.md` |

### Relevant Files (ADS-B Only)

- `src/services/aircraft-enrichment-service.ts` - hexdb.io integration (images + data)
- `src/data/icao-country-prefixes.ts` - Static ICAO hex → country lookup (150+ countries)
- `src/core/aircraft-tracker.ts` - State aggregation and tracking
- `src/core/aircraft-tracking-manager.ts` - Lifecycle management
- `packages/api-types/src/aircraft.ts` - Type definitions (50+ fields)
- `src/decoders/builtin/readsb.ts` - ADS-B decoder
- `cli/source/components/decoded-message.tsx` - CLI display (AircraftCard component)
- `docs/ADSB.md` - User-facing documentation

## Data Source Policy

### ✅ Allowed

- **hexdb.io** - Open source, completely free, no API key required
- **OurAirports** (https://ourairports.com/data/) - CC0 public domain
- **Static bundled data** - ICAO prefixes, type codes
- **ADS-B data itself** - What we already receive from broadcasts

### ❌ Not Allowed

- APIs requiring API keys (OpenSky, FlightAware, etc.)
- Commercial services (even with free tiers that could change)
- Scraping websites
- Undocumented/unofficial APIs
- Any service that could become paid or restricted

**Rationale**: We want a reliable, self-contained system that won't break when external services change their terms.

---

## Task Status Summary

| Task | Priority | Status | Notes |
|------|----------|--------|-------|
| Task 1: hexdb.io Images | High | ✅ **COMPLETE** | Implemented in enrichment service, displayed in CLI |
| Task 2: Audit hexdb.io Fields | High | ✅ **COMPLETE** | All 7 fields already parsed, no additional fields exist |
| Task 3: Static Airport Database | Medium | ⏸️ **DEFERRED** | No clear use case without route data |
| Task 4: hexdb.io Deep Dive | Research | ✅ **COMPLETE** | Simple API, 2 endpoints only |
| Task 5: Route Information | Low | ❌ **REMOVED** | Not feasible with open data |
| **NEW**: ICAO Country Prefixes | Low | ✅ **COMPLETE** | Static lookup from ICAO hex prefix, zero API calls |

---

## ✅ Task 1: hexdb.io Aircraft Images — COMPLETE

**Implementation Details:**

- **Image fetching**: `fetchImageUrl()` in `aircraft-enrichment-service.ts` (lines 424-470)
- **Parallel fetching**: Uses `Promise.all` to fetch aircraft data and image URL simultaneously
- **Caching**: Image URLs cached alongside other enrichment data (24h TTL)
- **CLI display**: Clickable 📷 link in `decoded-message.tsx` (lines 1075-1083)
- **Config toggle**: `fetchImages` option (default: `true`)

**API Behavior (verified):**

| Aspect | Behavior |
|--------|----------|
| Endpoint | `GET https://hexdb.io/hex-image?hex={ICAO}` |
| Response format | Plain text URL |
| Missing images | Returns 404 or `n/a` |
| Image hosting | All on hexdb.io (`/static/aircraft-images/`) |
| Rate limit | Same as main API (we use 1 req/s) |

---

## ✅ Task 2: hexdb.io Field Audit — COMPLETE

**API Response Schema (verified via live query):**

```json
{
  "ModeS": "3C675A",
  "Registration": "D-AIZZ",
  "Manufacturer": "Airbus",
  "ICAOTypeCode": "A320",
  "Type": "A320 214SL",
  "RegisteredOwners": "Lufthansa",
  "OperatorFlagCode": "DLH"
}
```

**Field Mapping — All 7 Fields Parsed:**

| hexdb.io Field | WaveKit Field | Status |
|----------------|---------------|--------|
| `ModeS` | (lookup key) | ✅ Used |
| `Registration` | `registration` | ✅ Parsed |
| `ICAOTypeCode` | `typeCode` | ✅ Parsed |
| `Type` | `typeDescription` | ✅ Parsed |
| `Manufacturer` | `manufacturer` | ✅ Parsed |
| `RegisteredOwners` | `operator` | ✅ Parsed |
| `OperatorFlagCode` | `operatorCode` | ✅ Parsed |

**Fields That Do NOT Exist (previously speculated):**
- ❌ Country of registration
- ❌ Serial number (MSN)
- ❌ Year built
- ❌ Engine count/type
- ❌ Wake turbulence category
- ❌ Owner history
- ❌ Operator logo URL

---

## ⏸️ Task 3: Static Airport Database — DEFERRED

**Reason for deferral**: ADS-B does not broadcast origin/destination airports. Without route data, the primary use cases don't exist:

| Use Case | Feasibility |
|----------|-------------|
| Enrich route data with airport details | ❌ No route data available |
| "Near KJFK" contextual info | ⚠️ Possible but low value |
| Distance calculations | ⚠️ Possible but unclear benefit |

**Future consideration**: If a use case emerges, OurAirports data (CC0) is the right source.

---

## ✅ Task 4: hexdb.io Deep Dive — COMPLETE

| Aspect | Finding |
|--------|---------|
| Repository | Not public (closed source) |
| API endpoints | Only 2: `/api/v1/aircraft/{icao}` and `/hex-image?hex={icao}` |
| Rate limits | Informal — we use 1 req/s to be respectful |
| Data source | Aggregates from FAA, EASA, national registries |
| Update frequency | Unknown but data appears current |
| Bulk download | Not available |

---

## ❌ Task 5: Route Information — REMOVED FROM SCOPE

**Finding**: Route data (origin/destination) is **not achievable** with open data only.

| Approach | Result |
|----------|--------|
| hexdb.io routes | ❌ No route endpoints exist |
| Callsign pattern matching | ❌ Too unreliable (flights vary by day/time) |
| Open route databases | ❌ None found without API keys |
| ADS-B broadcast | ❌ Routes not part of ADS-B spec |

**Documented as known limitation** in `docs/ADSB.md`.

---

## ✅ ICAO Country Prefixes — COMPLETE

**Concept**: Derive country of registration from ICAO hex prefix (deterministic, no API calls).

ICAO addresses encode the country in the hex prefix:

| Prefix | Country | Example ICAO |
|--------|---------|--------------|
| `A` | United States | A12345 |
| `3C` | Germany | 3C675A |
| `40` | United Kingdom | 406D8A |
| `48` | France | 48A1B2 |
| `C0` | Canada | C0A123 |

**Implementation:**

- **Data file**: `src/data/icao-country-prefixes.ts` — ~150 country ranges with binary search lookup
- **Integration**: `aircraft-enrichment-service.ts` — populates `country` field on all enrichments
- **Fallback**: Even when hexdb.io returns 404, country is still derived from ICAO prefix
- **Tests**: `tests/unit/data/icao-country-prefixes.test.ts` — 16 tests covering major countries and edge cases

---

## Implementation Guidelines

### Quality Standards

1. **State-of-the-Art Quality**
   - Production-ready code only
   - Comprehensive error handling
   - Full TypeScript types
   - Unit tests for all new logic

2. **No Hacky Solutions**
   - Every feature must be reliable
   - Clear API contracts
   - Graceful degradation on failure
   - No scraping, no undocumented APIs

3. **Performance**
   - Async enrichment (never block message processing)
   - Aggressive caching with appropriate TTLs
   - Rate limiting for external calls
   - No impact on core ADS-B tracking speed

4. **ADS-B Isolation**
   - Changes confined to aircraft-related files
   - No modifications to shared decoder infrastructure
   - Type extensions only in `aircraft.ts`

### Code Patterns

Follow existing patterns in `aircraft-enrichment-service.ts`:

- EventEmitter for lifecycle events
- LRU cache with TTL
- Rate-limited queue processing
- Async/await with proper error handling
- Structured logging

---

## Success Criteria (Updated)

- [x] hexdb.io image URL integration working
- [x] All hexdb.io response fields documented
- [x] Image URL displayed in CLI (clickable 📷)
- [x] No regressions in existing aircraft tracking
- [x] No impact on other decoders (AIS, DMR, etc.)
- [x] Documentation updated in `docs/ADSB.md`
- [x] ICAO country prefix enrichment
- [ ] (Deferred) Static airport database

---

## References

- **hexdb.io**: https://hexdb.io/
- **hexdb.io Image API**: `https://hexdb.io/hex-image?hex={ICAO}`
- **OurAirports Data**: https://ourairports.com/data/
- **Current Implementation**: `src/services/aircraft-enrichment-service.ts`
- **Aircraft Types**: `packages/api-types/src/aircraft.ts`
- **CLI Display**: `cli/source/components/decoded-message.tsx`
- **Main README**: `readme.md` (read this first!)
