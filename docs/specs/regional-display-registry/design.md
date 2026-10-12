# Regional display registry design

Status: reviewed design; not implemented or mounted. The complete public assembly must pass independent review before implementation allocation. No test or hardware qualification is implied.

See [requirements](requirements.md), [design](design.md) and [tasks](tasks.md).

## Scope and isolation

Provide a small independent read-only display registry. The first planned family is US FRS with national US applicability. Authoritative numeric publication is unavailable pending evidence acceptance. Do not derive rows from scanner ranges, rasters or vendor lists. Marine duplex, cross-national families, repeater directories and dynamic/user-edited registries are outside the initial slice.

Display results confer no tuner, decoder, scanner, audio, settings or regulatory authority. They never tune, acquire streams, mutate persistence or initiate controls.

The existing coarse region resolver and decoder defaults have distinct purposes. Preserve src/decoders/band-region.ts, src/decoders/band-defaults.ts, src/core/scanner/bandplan/index.ts and src/core/scanner/bandplan/builtin.ts unchanged. Decoder-specific region overrides are not national registry authority. Scanner worldwide/CA fallback, soft protocol priors, raster phase, snapping and frequency keys remain sweep semantics, not authoritative channel numbering. The registry imports none of these four modules and exports no adapter or extraction. Coarse EU grouping includes territories beyond the EU and must never imply a national allocation. An optional detached coarse context is informational only; requests always require an explicit region.

## Evidence and publication state

Archival factual transcription has been independently accepted as archival evidence. Its narrow factual-transcription rationale, local labels/aliases and null advisory hints are accepted within that scope. This does not accept current authoritative data or a verified dataset. No numeric rows, channel count, fabricated data digest or verifiedAsOf date is published by this specification.

Current raw regulatory source bytes/digest, the section-specific effective-date chain and positive support for the proposed receive/transmit frequency representation remain blocking. Captured historical frequency centers do not alone establish the reviewed same-frequency simplex representation. Current-source capture is still missing; the archival capture does not fill that gap. Retain evidence-pending/unavailable until a fresh exact data review closes the remaining gates. No further research or data implementation is released by this design.

Future research must use a separately bounded official eCFR/FCC source allocation, record URL/edition/retrieval date/effective-date chain/source-byte digest/row locators and factual-transcription rationale, independently compare every literal row, and avoid interpolation. Additional substantive documents need an explicit source budget. Keep display mode/bandwidth/step null when primary evidence does not establish receive hints. Distinguish spectrum facts from equipment/transmission eligibility; neither request region nor source applicability declares a user's activity lawful.

## Closed contracts

All JSON object schemas additionalProperties:false recursively; required fields explicit, nullable fields serialized null rather than omitted. No generic metadata bag. SchemaVersion literal1. RegionCode closed EU|US|CA|AU|NZ|JP|CN (request compatibility labels only, not universal nation assertion); familyId initial literal frs. Country applicability literal US for initial verified data. Unknown family strings remain syntactically validated then404, not dynamically accepted enums. Future families/regions require versioned contract review.

IDs: family frs; dataset us-frs; row prefix us-frs- followed by lower ASCII alphanumeric/hyphen authority-independent local key; IDregex ^[a-z][a-z0-9-]{0,63}$, length1..64. Stable row keys assigned only during verified transcription, never array indices or unchecked numbers. Changing a row's semantic identity creates a new ID; ordinary label/citation corrections retain ID and change datasetVersion. Versions ^[a-z0-9][a-z0-9.-]{0,31}$ (1..32); dataContentSha256 lowercase64hex hashes the exact CanonicalPublicationPayload bytes specified below. SchemaVersion changes only for DTO shape changes.

Bounds are engineering limits, NOT RF facts. Initial Registration contains exactly ONE frs registration, exactly zero or one us-frs dataset, at most128 rows, at most8 aliases/row,1..4 citations/row and1..8 source references/verified dataset. Up to32 collision declarations/dataset, each2..128 candidate IDs. No generic eight-manifest allowance exists in this initial literal-family slice. Future expansion needs a new reviewed contract. Complete StoredRegistration <=512KiB UTF8, each StoredDataset <=128KiB; the envelopes below include internal collisions/digest fields. Invalid/overflow registration fails entire provider initialization, never a partial publication. No runtime file/network loading/cache/persistence. Actual serialized response <=128KiB UTF8 before send, independent of storage size; overflow503, no truncation.

Text: displayLabel1..80 Unicode scalar values AND<=320UTF8 bytes; reject controls/surrogates. Alias1..32 ASCII printable; normalized length1..32; source organization/title1..120 scalars/<=480bytes each; documentId/edition1..80ASCII; sourceURL HTTPS<=512ASCII bytes no credentials/fragment; locator1..120scalars/<=480bytes; fixed ISO date YYYY-MM-DD validated actual date, no locale text. No externally supplied source URLs fetched by API. String caps validated on internal data as well as DTO parsing.

SourceReference = {id: boundedID, organization, documentId, title, edition, publishedDate:null|date, retrievedDate:date, url, documentSha256:64hex, applicability:'US', redistribution:'facts-transcribed', locator}. The redistribution tag requires a reviewed rationale in dataset authoring evidence; it does not itself confer a license. Public citation exposes only safe public source metadata, no local paths/private review IDs. Document digest covers retrieved source bytes, not an assurance of ongoing law. Dataset = {schemaVersion:1,datasetId,datasetVersion,dataContentSha256,familyId:'frs',applicability:{kind:'national',countryCode:'US'},verifiedAsOf:date,sourceReferences,rows}. A verifiedAsOf date records review currency, not automatic live currency; bundled snapshots never claim live/current law.

ChannelRow = {id,displayLabel,aliases:string[],frequency:Frequency,display:{advisory:true,mode:null|'nfm'|'fm'|'am'|'digital'|'unknown',bandwidthHz:null|integer,stepHz:null|integer},sourceReferenceIds:string[]}.
Frequency closed discriminated union:

- {kind:'simplex',frequencyHz:integer}
- {kind:'duplex',stationReceiveHz:integer,stationTransmitHz:integer,endpoint:'subscriber'|'base'}.
  All frequencyHz integers1..1000000000000, safeinteger; bandwidthHz1..10000000 ornull, stepHz1..10000000 ornull. Bounds validate representation only, not receiver support. No generic min/max range row. Duplex stationReceiveHz is RF received by the named endpoint, stationTransmitHz RF transmitted by it; this endpoint-relative meaning is required for every row and source locator. A receiver display may show either explicitly labelled field but no automatic choice occurs here. Initial FRS admits only verified simplex rows. No computed offsets, inferred polarity, channel-number parsing or deduplication by frequency: distinct labels may share frequency if source establishes distinct identities.

Selection = {requestedRegion:RegionCode,source:'query',coarseContext:null|{code:RegionCode,source:'configured'|'decoder'|'guessed:tz'|'guessed:intl-timezone'|'guessed:locale-env'|'guessed:intl-locale'|'default'}}. Context is a detached informational snapshot from existing resolver, if supplied once at composition; registry never reads process env or modifies resolver. Query region required even if context configuredUS. RequestUS does not prove physical location or permission; data applicabilityUS is a property of the published source, not a user-location claim.

FamilyManifest is a closed discriminated union, common {familyId:'frs',displayLabel,applicability:{kind:'national',countryCode:'US'}}:

- unavailable adds {state:'unavailable',datasetVersion:null,reason:'evidence-pending'};
- verified adds {state:'verified',datasetVersion:version,reason:null}.
  No other combinations allowed. An unavailable manifest is not an infrastructure error. Unsupported is a region-result, not a manifest claiming foreign applicability.

Internal CollisionDeclaration = {alias:normalizedAlias,candidateIds:boundedID[]} with exactly these keys; candidateIds2..128 unique existing row IDs, sorted canonically. Alias1..32 normalized printable ASCII. declarations0..32, unique by alias. Declaration must equal the COMPLETE set of rows carrying that alias, not a subset. At least two matches required; declarations for unique/missing alias reject. Every actual cross-row alias collision must have exactly one matching declaration. No anonymous metadata or hidden collision type.

Registration = {schemaVersion:1,registrations:FamilyRegistration[],coarseContext:null|CoarseContext}. CoarseContext is exactly the non-null object defined in Selection.coarseContext above. Initial registrations length EXACTLY1, no empty registry is valid. FamilyRegistration closed union:

- {manifest:UnavailableFamilyManifest,dataset:null};
- {manifest:VerifiedFamilyManifest,dataset:StoredDataset}.
  StoredDataset = {publication:Dataset,collisions:CollisionDeclaration[]}.
  Manifest familyId=publication.familyId='frs', publication.datasetId='us-frs', both nationalUS applicability EXACTLY match; manifest.datasetVersion=publication.datasetVersion. Verified requires dataset; unavailable forbids it. Duplicate family IDs, duplicate dataset IDs, two versions of one dataset, conflicting sameID/version content and orphan data all reject before any provider is returned. These rules do not select first or last entry. SourceReference IDs1..8 unique per dataset; every row has1..4 UNIQUE existing citation IDs, including an empty verified dataset having zero rows but still1..8 source references. Row IDs unique; no unused orphan sourceReference allowed except when rows is empty, where all source references establish verified empty scope. Each nonempty dataset source reference must be cited by at least one row. Row aliases may be empty0..8 but duplicate aliases reject; no row silently acquires displayLabel alias. Initial verified publication rows are simplex only. Generic duplex schema tests do not admit a duplex FRS row.

## Exact canonical publication and byte envelopes

CanonicalPublicationPayload = {schemaVersion:1,publication:DatasetWithoutDigest,collisions:CollisionDeclaration[]} where DatasetWithoutDigest contains EXACT Dataset keys above except dataContentSha256. No other exclusion: datasetVersion, applicability, verifiedAsOf, all source-reference metadata/dates/digests, every row/alias/citation/display hint and every collision declaration are hashed. Family manifest label/state and coarseContext are not dataset content and are excluded from dataset hash, but included in StoredRegistration byte bounds. They cannot substitute dataset authority. A manifest-label-only change affects stored registration bytes but not datasetVersion; any hashed field change requires a new datasetVersion, including alias/label/collision/citation/edition/retrieval or verification-date correction. Even changing only datasetVersion changes digest. Same datasetId/version MUST mean identical payload bytes; candidate authoring must compare its prior published version before release and refuse reuse with changed content. This cross-publication check is an authoring/review gate, not a new persistence store. Within registration all repeats reject even identical repeats.

Canonical serializer C is defined for the already validated finite JSON subset: recursively order object keys by ascending ASCII byte order (all schema keys ASCII); no whitespace/BOM/trailingLF. Arrays are normalized by specific rules below then retain that order. Strings preserve Unicode scalar sequences EXACTLY: no NFC/NFD/case folding outside alias normalization, reject lone surrogates and controls. Encode double quote as backslash-doublequote and backslash as doublebackslash; printable ASCII and all other permitted Unicode scalars are written literally as UTF8, including slash/U+2028/U+2029. No optional escaping of nonASCII. Null/booleans literal lower-case; numbers only nonnegative safe integers encoded shortest base10 with no exponent, leading zeros or sign; reject negativezero. This avoids locale/order/runtime-dependent JSON escaping. UTF8 encoding strict without replacement characters. Inputs with decomposed versus precomposed Unicode are intentionally distinct and may have distinct digests. Their display equality never supplies alias equality.

Array normalization/duplicate rules: registrations by manifest.familyId (initialone); sourceReferences by id, rows by id; row aliases ASCII lexicographic normalized alias; row sourceReferenceIds ASCII ID; collisions by alias, collision candidateIds ASCII ID; output families by familyId, output rows/candidates by rowID. These are the ONLY arrays. Duplicates reject BEFORE sorting, never silently deduplicate. CoarseContext no arrays. No numeric label sort or localeCompare. All externally visible arrays follow these rules; array permutations of otherwise identical valid inputs normalize to identical bytes/output.

dataContentSha256 = lowercase SHA256 of UTF8 C(CanonicalPublicationPayload). StoredDataset bytes = UTF8 C({publication:DatasetIncludingDigest,collisions:CollisionDeclaration[]}); both collisions and64-character digest count toward128KiB. StoredRegistration bytes = UTF8 C(Registration), including manifest/coarseContext/alldatasets/collisions/digests, <=512KiB. These are normalized storage envelopes, no file write promised. Public responses use C on their closed DTO envelopes, including schemaVersion/selection/state/pagination/source refs, then measure ACTUAL bytes<=128KiB before reply.send of those exact bytes with application/json UTF8; no serializer silently strips unknowns/reorders/replaces bytes. Hash payload and stored/public envelopes deliberately differ. Response bound applies to families, channels, resolve and fixed localerrors. Runtime stores prevalidated frozen domain data, not a network-loaded journal.

Fixed synthetic vector plan (future execution, no hashing test run now): pin full literal input, normalized bytes and expected64hex SHA for (V1) verified-empty dataset with one synthetic citation with publishedDate:null, retrievedDate and verifiedAsOf fixed valid dates, (V2) one synthetic simplex row with quotes/backslash and Unicode label, (V3) two synthetic rows sharing declared alias with reversed input order, (V4) unavailable Registration storage with null dataset/context. Citation dates obey actualdate constraints; vectors use inventedTEST facts, never published RF rows. Expected hashes must be independently derived from the written byte algorithm before implementation assertions, not calculated by the serializer under test. Pin ASCII object-key/null/boolean/integer escape primitive byte vectors too. Permute each object input-key order and every permitted array; same normalized bytes/hash. One-field changes across every hashed field (includingcollision/sourceedition/date) change expected payload bytes/hash and require new version; omitted digest hash exclusion, manifest/context exclusion, and digest counting in storage get distinct assertions. NFC versus NFD vector pair deliberately differs. Overflow cases measure both envelopes separately and actual public bytes.

Alias normalization: strict raw-query decoder below supplies one decoded value; aliases are ASCII only, trim ASCII spaces at ends, collapse internal ASCII spaces to one, lowercase A-Z. Reject empty/control/nonASCII/over32 bytes; punctuation and leading zeros preserved, no integer/frequency inference. Row aliases must already equal normalization and be unique; lookup also indexes normalized displayLabel only if it meets alias grammar and explicitly appears in aliases (no hidden alias). Scope exactregion/family. Cross-row alias collision requires an explicit internal collision declaration listing exact normalized alias+sorted rowIDs, max32 declarations/dataset; missing/extra/mismatched declaration invalidates dataset. Public resolution returns all matching candidates<=128; no ranking/priority/nearest-frequency guess. Same alias in another region/family cannot collide or leak into result. Collision never merges simplex/duplex roles.

## Pure provider interface and response shapes

createRegionalRegistry(registration:Registration) returns RegionalRegistry; construction validates/copies/deepfreezes all nested inputs or throws a safe WaveKitError internally. No logger callbacks/user hooks in a read. Functions synchronous; absent provider handled by route options, not a dummy emptyverified registry.

- listFamilies(region) -> closed result: US gives {schemaVersion:1,selection,state:'available',families:[FamilyManifest]} EXACTLY one frs manifest, regardless whether its state unavailable or verified. EU/CA/AU/NZ/JP/CN each gives {schemaVersion:1,selection,state:'unsupported',reason:'region-not-covered',families:[]} and never returns the US manifest/version. Invalid/empty Registration cannot create a provider (route null503); there is no successful empty-family registry. US verified-empty dataset still returns verified manifest and channels total0; US evidencepending returns unavailable manifest and no rows. This makes every accepted region deterministic.
- listChannels({region,family,offset,limit}) -> supported union below.
- resolveAlias({region,family,alias}) -> supported union below.
  Inputs internal validated closed types, route validates raw inputs first. Each returned DTO is a fresh deep copy/deepfreeze; callers cannot alter subsequent reads or constructor input. No exposed Maps/Set/streams.

Supported channels result = {schemaVersion:1,selection,state:'verified',dataset:{datasetId,datasetVersion,dataContentSha256,applicability,verifiedAsOf,sourceReferences},total:0..128,offset:0..1024,limit:1..128,rows:ChannelRow[],nextOffset:null|integer}. Offset>=total returns empty rows/nextOffsetnull with total still known. Defaultoffset0/limit64; explicitlimit capped128 by rejection not coercion. Stable complete ordering before slice; nextOffset=offset+rows.length iff more remain. No cursor persistence/implicit version: response identifies immutable bundled version; concurrent process restart can change version and clients must restart pagination if version differs.
Unavailable channels/resolve = {schemaVersion:1,selection,state:'unavailable',familyId:'frs',reason:'evidence-pending'}; no dataset/rows/total. Unsupported = {schemaVersion:1,selection,state:'unsupported',familyId:'frs',reason:'region-not-covered'}; no data. Known family and regionUS evidencepending ->unavailable; anyother validregion ->unsupported irrespectiveUSdataset state. No fallback/emptyverified certification.
Resolve verified = {schemaVersion:1,selection,state:'verified',dataset:same header,normalizedAlias,result:'matched'|'ambiguous'|'not-found',candidates:ChannelRow[]}; matched exactly1, ambiguous2..128, not-found0. These are200 resultstates; distinguish semantic aliasmiss from unknownfamily404. No fulltext/regex/fuzzy/freefrequency search.

## Routes, methods, lifecycle, errors and admission

Plugin regionalRoutes(options:{registry:RegionalRegistry|null}) mounted as an encapsulated child beneath root access hooks. Exact concrete paths:

- GET /api/regional/families requires region only.
- GET /api/regional/channels requires region/family; optional offset(default0)/limit(default64).
- GET /api/regional/resolve requires region/family/alias.

All GET registrations exposeHeadRoute:false. Register HEAD, POST, PUT, PATCH and DELETE deny routes ONLY at each of these exact three paths. No wildcard/automaticHEAD and no regional OPTIONS route. HEAD local error has no body; Allow:GET on local405 only. These are the enumerated denied framework methods, not an assertion about arbitrary HTTP tokens. OPTIONS/preflight remains existing rootpolicy/CORS: protected acceptedpreflight204 before plugin; legacyCORS behavior unchanged; otherOPTIONS requests follow existingnotfound behavior, no regional405. CONNECT, TRACE, upgrade, malformed/request-line or router/HTTP-parser unsupported methods remain current transport behavior, not local errors or new endpoints. Unknown paths, including HEAD /api/regional/anything or trailing/subpaths not matching exactroutes, retain existing404 after applicable root admission; no wildcard catches them. No websocket upgrade/CONNECT/tunnel surface is offered.

Precedence (same in protected/legacy except existing root/CORS differences):

1. HTTP parser/router/request-construction failures before plugin remain existing transport/global behavior. No promise of regional body/code/cache headers for rejected malformed framing, conflictingCL/TE, invalidheader/requesttarget or query-parser exceptions before onRequest.

2. Root admission/earlyshutdown/preflight FIRST, using original HTTPfacts. Rootdeny or handledOPTIONS ends processing; feature hook/parser/provider NEVERruns. Machine/session/origin/boundary/unsafeCSRF policy unchanged.

3. For matched GET/HEAD/POST/PUT/PATCH/DELETE, plugin-local onRequest checks framing and terminates on framed request400 (HEADbodyless), BEFORE preParsing/content-typeparser/preValidation. No body consumption/inspection/customstream/timer. Transport-valid Content-Length absent or literal0 accepted; positiveCL rejected, all Transfer-Encoding rejected EVEN emptychunked. Noncanonical/duplicateCL if HTTP permits it is local400; parser-invalid never reaches plugin. Inspect bounded existingheader/rawheader entries (currentrootbounds preserved); never read payload. Unsupportedmedia or malformedJSON positiveCL/TE POST therefore400local before parser, not415/globalJSONerror. CL0/absent with content-type and denied method is405 in onRequest, so parserneverruns. Body bytes without legalframing remain HTTPtransport responsibilities, not inferred empty payloadproof.

4. With legalemptyframing, denied method returns405 immediately BEFORE queryvalidation/provider; GET requiredquery does NOT apply to deny routes. Missing/malformed/oversized query on HEAD/POST/PUT/PATCH/DELETE is ignored by featuremethod denial once requestconstruction/root accepts it. Root rawtarget bound/error may still precede405. SessionunsafePOST/PUT/PATCH/DELETE withoutrequiredCSRF/origin receives ROOT403 first, not405; admittedmachine/correctsession/legacy gets405. No provider call/contentparser on either.

5. Only GET proceeds to strict bounded raw query validation IN this onRequest hook; route stores validated typed query on request-local private symbol, not request.query. Local400 on queryfailure. Then pure handler sees typed input, provider presence503 before family lookup404, then semantic200. Unexpected provider/serialization failure safe503. No body/parser work is needed for bodyless GET. No AJV query/body schema capable of stripping/coercing is attached; closed response schemas/documentation may describe DTO, but exactbytes are serialized explicitly after validation.

Rawquery algorithm: obtain substring after first '?' in request.raw.url from matchedpath; absentquery or emptyquery becomes no pairs, then GETmissingrequired400. Limitrawsubstring1024ASCIIbytes beforedecode, max4pairs; reject rawnonASCII, raw'#', empty pairs (leading/trailing'&' or'&&'), missing'=' or more than one literal'=' perpair, emptykey/value. Split '&', split at soleliteral'='; encoded delimiters stay encoded untilcomponentdecode. For each key/value replace literal '+' with ASCIIspace (form-queryrule), require every '%' followedbytwohex digits, convert percentescapes and literalASCII tobytes and decode STRICT UTF8 rejectingoverlong/lonesurrogate/outofrange/incomplete sequences; no replacement. Decode exactlyONCE; '%' produced by %25 remains ordinarypercentcharacter, no seconddecode. Reject decodedcontrols. Keys afterdecode must be exact allowedASCII names (region/family/offset/limit/alias), no whitespace/casefold; duplicate detection uses DECODEDkey, so region and %72egion collide. Unknownkey400. Key/value bounds applied afterdecode as well as rawbound.

For resolve alias, literal'+' becomes space and participates in aliastrim/collapse; %2B becomes literalplus retained, %252B becomes literal'%2b' afterASCIIcasefold, NEVERplus. Encoded'&'/'=' may be printablealias characters afterdecode but do not create anotherpair. Alias rawdecoded input must1..32ASCIIbytes beforetrim/collapse, thennormalized1..32; rejectcontrols/nonASCII/empty. Region exactenum, family exactboundedlowerIDgrammar. offset/limit canonicaldecimal ^(0|[1-9][0-9]{0,3})$ then offset0..1024/limit1..128, no whitespace/leadingzeros/fraction/scientific/plus. A '+' decodedspace never formsnumber. For families onlyregion permitted; channelsallowed4keys; resolveallowed3keys. Parsed framework request.query may already exist, but feature NEVERtrusts it and does not claim requestconstruction was query-free.

| Observed boundary                                                                  | Status / body / provider effects                                                                                                                                      |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| rootdeny/preflight                                                                 | Existing rootcode-onlybody/status/headers or204; feature not entered, provider zero                                                                                   |
| transportinvalid beforelocalhook                                                   | Existing transport/router/globalhandling, excluded from regionalerrorpromise                                                                                          |
| admittedframed exactroute                                                          | 400 {error:'Bad Request',code:'REGIONAL_INVALID_REQUEST',message:'Invalid regional registry request'}; HEADbody empty; provider/parserzero                            |
| admittedemptyframed deniedmethod, anyquery                                         | 405 {error:'Method Not Allowed',code:'REGIONAL_METHOD_NOT_ALLOWED',message:'Regional registry method is not allowed'}, Allow:GET; HEADbody empty; provider/parserzero |
| GETinvalidraw query                                                                | samefixed400; provider zero                                                                                                                                           |
| GETvalidquery, nullprovider orthrows/invalidoutput/actualserializedoverflow        | 503 {error:'Service Unavailable',code:'REGIONAL_UNAVAILABLE',message:'Regional registry is unavailable'}                                                              |
| GETvalidquery/presentprovider/syntacticallyvalidunknownfamily                      | 404 {error:'Not Found',code:'REGIONAL_FAMILY_NOT_FOUND',message:'Regional family not found'}                                                                          |
| validGET families/verifiedrows/aliasmatched/ambiguous/miss/unavailable/unsupported | 200 closed DTOs; no fallback                                                                                                                                          |
| unknownsubpath/methodnotregistered                                                 | existing404/transportbehavior, not regionalwildcard                                                                                                                   |

Plugin-local hook returns fixederror directly ratherthanthrowing validation/parsererrors into globalhandler. It uses fixed JSON serializer on localerrors and prevalidated C bytes on200; localexceptions caught tosafe503 withoutcause/path/alias echo. All LOCAL responses Cache-Control:no-store; no ETag/304/cache or customcompression. Rootdenials/preflight retain EXACTexistingheaders/codes/body/serializer; plugin MUSTNOT rewrite them or add contrarycacheheaders, and does not claim no-store for root/globalresponses it does not own. Response schemas include localfixederror and existingcode-onlyroot denial alternatives where statusesoverlap; rootforcedserializer retained. No API/publicbootstrap exception, flags, CSRFbypass/downloadleases/subscriptions. Integration must mount child afterroot installAccessHooks, validate inheritedhook order with actualcompositiontests. Legacydefault/CORS/protectednormalmetadataadmission unchanged.

## Integration dependencies

ApiServerDependencies regionalRegistry?:RegionalRegistry|null; undefined means pluginunmounted (404), null means intentionallymounted unavailable (503), actualprovider meansmounted. Dependency and public-type changes require exact integration review. src/index.ts creates validated immutable registry from reviewedbundled data and optional detached resolvedcoarsecontext once, injectsserver; no newconfig.env/location inference. It must not map config.regionEU to a nationalcountry or replace bandresolver. src/api/server.ts registers plugin beneath existing rootaccesshooks in both modes, includes admittedmethod denial/header policy; no newexception/bootstrapflag. ChildlocalonRequest framing/method/raw query rejection inherits ROOTfirst order; no sharedparser/accessdefault change. packages/api-types/src/index.ts barrel export and docs/API.md and docs/ROADMAP.md documentation updates. Shared config/defaults unchanged; no decoder, SDR-host, source/tuner, scanner/APIclient/webmountchanges. The route plugin requires a separate exact implementation allocation.

## Correctness properties

### Property 1: Authority separation

validates1.2–1.4,2.5,3.2: changing coarseguessed/default/context never changes an explicit requested dataset; unsupportedpair cannotreturnrows or fallback. >=100 generated context/region cases.

### Property 2: Alias determinism

validates2.1–2.3,3.5: permutationsofvalidatedrows/aliases/collisiondeclarations yieldidentical normalizedresolution/candidateordering; distinctcollisionnevermatched. >=100 runs.

### Property 3: Detached projection

validates1.1,3.3: mutating callerconstructorobjects or attempted returnednestedmutation cannotalterfuturelookup/version. >=100 generatedvaliddatasets (freezeexceptions handledassertions, not hidden).

### Property 4: Bounds

validates3.3,3.5: validgenerateddatasets/responses respect rows/UTF8 bytes/strings/aliases; anysingleboundaryoverflowrejectswholepublication, no truncation. >=100 runs includesmultibyteunicode. Serializationlength checked independently.

### Property 5: Duplex preservation

validates2.4: generatedendpoint/frequency pairs projectunchanged roles; no numericorder/swap/defaultreceivechoice. >=100 runs; initialdataset simplexonly.

### Property 6: Isolation

validates1.5,4.3: everyregistryoperation haszero dependency calls to tuner/source/decoder/scanner/persistence; exactfourlegacyblobs unchanged and existingregressioncontracts unaffected. This is behavioral/unit plus source blob proof, not a fake mirroredproperty.

### Property 7: Admission ordering

validates4.1–4.2,4.5: actualmounted server protecteddenials nevercallprovider evenfor malformed/ambiguousquery; admitted/legacyroutes obey sameclosedsemanticstates and safeheaders. Scenario tests, not blanketpropertyclaim.

### Property 8: Canonical publication

validates2.1,3.5: arbitrary object-key/array input permutations normalize to identical exactCbytes/digest; hashedonefieldchange requiresversionchange; storage/hash/publicenvelopes measuredseparately. >=100 runs plusfixedvectors.

### Property 9: Correlated registration

validates2.3,2.5,3.1,3.4–3.5: construction rejects everyduplicate/orphan/missing/mismatchedstate/collision/reference invariant atomically; all7regionfamilies projections satisfyclosedresult. >=100 generatedcontradictions plusenumeratedstatecases.

Future property tests use exact repositorytrace comment Feature: regional-display-registry, Property N: name; Validates: Requirements IDs, numRuns>=100. Properties test meaningful input permutations/mutations/units, not merely schema implementation roundtrips.

## Proposed implementation modules

Future internal modules: src/core/regional/types.ts for closed validation and immutable domain types; registry.ts for pure lookup/projection; data.ts for the mandatory manifest and, only after evidence acceptance, verified static transcription. Before then data is evidence-pending. Public DTOs belong in packages/api-types/src/regional.ts; plugin schemas/query handling in src/api/routes/regional.ts. No extra generic regional extraction or schema helper is required.

Future tests: tests/unit/core/regional/registry.test.ts and data.test.ts; tests/unit/api/regional.test.ts and regional-access.test.ts; tests/unit/repo/regional-isolation.test.ts. Existing server/index composition, exports and public documentation require separate serial integration allocation. Existing decoder/scanner/SDR-host paths are outside this slice. Naming these paths does not authorize authoring them.

## Validation matrix

Matrix: providerabsent/null/throws/invaliddata/oversize503; unsupportedall6otherregions vs USunavailable/verified/empty; unknownfamily404 after admission; required/repeated/unknownqueries, malformedencoding/length, aliasempty/nonASCII/overlength/leadingzero preserved; offset/limit0/1/64/128/129/max/overmax/end/empty deterministicpages; allstringbytes/citationcounts/aliascollisiondeclaration thresholds; Unicodebytes/control/surrogates; frequencyinteger/unsafe/negative/duplexrole; detachednestedprojection; stableversions/digestfixture changes; public citations expose no local path. Route GET200 states, unofferedHEAD405body empty/AllowGET andothermethod405, OPTIONSexistingpreflight, unknownpath404; noHEADparity claim becauseHEADnotprovided. Actualroot protected unauthorized/badbearer/origin/malformedboundary/admissionstop/sessionfailure callprovider zero; authenticated machine/sessionreads success, legacyreadsuccess, unmounted404. Rootdenial code-only shape survives response serialization, no accidentalbootstrapexception includingquery variants. No sideeffectcommands/streamacquisition/persistence/events; the four existing source blob IDs/hashes before/after plus existing focusedscanner/decoder equivalence tests at futurevalidationwindow. At least 100-run properties1–5,8–9 withtraceIDs; no fake100RFmeasurements.

### Mandatory additional validation schedules

Fixedcanonicalpayload/storage vectors and expectedbytes/digests; key/arraypermutations, NFC/NFD, escapes/null/numericnegativezero, allhashedfieldchanges includingversion/collision/citations/dates, sameID/versionconflict, actualstorageandpublicbyte overflow. ClosedRegistrationunavailable+datasetinvalid, verifiedmissingdataset/version/reasonmismatch, duplicatefamily/dataset/versions, emptyregistrationsinvalid, orphanrows/citations/sources, everycollisionmissing/extraneous/subset/duplicatecandidate/nonexistingID, sourceIDsduplicate/zero rowcitations. USunavailable/verified/verifiedemptyfamiliesexactone; all6otherregionsunsupportedfamiliesempty regardlessUSstate.

Actualmounted protected/legacy lifecyclecases: exactHEAD3paths405body empty versusunknownHEAD404; deniedPOST/PUT/PATCH/DELETE missing/malformedquery405 onlyafterroot admission; sessionunsafe missingCSRF/originroot403, machine/correctsession/legacy405. GETandHEADpositiveCL400; allTEincludingemptychunked400 whentransportvalid; unsupportedmedia/malformedJSONPOSTframed400before parser, emptyframeddeniedmethod405; incompatibleframing/parser-invalid remains excludedtransportcase. Spyproviderandcontentparsercallszero forlocalframing/method/query failures; no inventedruntimeclaimfromfixtures. root denialheader/body unchanged despitelocalonSend/no-store; local200/errorsno-store. OPTIONSprotectedpreflight204/legacyCORS/unhandledexistingbehavior, noregionalOPTIONSauthority.

Rawquery: region+%72egion duplicate400; encodedunknownkey400; literalplusalias space versus%2Bliteralplus; %252Bsingledecodepercentliteral; encoded&/= keptaliasnotpairs; emptyquery/missingrequired, emptyvalue/key/pair/trailing&/&&/multipleliteral=; rawUnicode/raw#invalid, invalidpercent/UTF8/overlong/surrogate/outofrange, decodedcontrol, validUnicodealiasrejectASCII, querybyte/pairedcounts. AJVstrip/coerce cannot turn unknownkey/repeatednumber into success because neverusedforinput. Futuretest must drive actualRawtarget and hooks, not only pluginhandler request.query fixtures.

## Property-test trace convention

Generated property tests use fast-check with `numRuns: 100` or greater and preserve the numbered requirement/property traces:

```ts
// Feature: regional-display-registry, Property N: <name>
// Validates: Requirements X.Y, X.Z
```

Deterministic scenario matrices and mounted admission tests supplement generated properties; they do not constitute hardware or regulatory qualification.

## Initial local presentation convention

Subject to the remaining data acceptance gates, a numbered FRS channel uses stable local ID `us-frs-channel-N`, display label `FRS N` and sole normalized alias `frs N`, where N is the official channel number. These are local presentation conventions, not verbatim agency labels. Do not introduce bare-number, zero-padded, privacy-code, GMRS or repeater aliases. Mode, bandwidthHz and stepHz remain null. Canonical row ordering is ASCII by ID, not numeric by channel number. This convention does not publish numeric frequency data or prove simplex representation.
