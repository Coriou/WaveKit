//! Version-1 control requests (addendum §11; fd 3 per plan A1, `mark-gap` fields per A2).
//! Protocol 2 adds `open` with `kind: "demod"`, plus `retune` and `squelch`. A `kind`-less
//! `open` is still the version-1 IQ request, parsed by the same arm as before.

use crate::channel::Format;
use crate::demod::Modulation;
use serde_json::{Map, Value};

/// Largest control line, including the newline. Mirrors `MAX_EVENT_LINE_BYTES` (64 KiB).
pub const MAX_CONTROL_LINE_BYTES: usize = 64 * 1024;

/// Demod audio rate. Fixed; a demod `open` has no `outputRateHz`.
pub const DEMOD_OUTPUT_RATE_HZ: u64 = 48_000;

/// 10 ms at [`DEMOD_OUTPUT_RATE_HZ`].
pub const DEMOD_BLOCK_SAMPLES: usize = 480;

pub const DEMOD_MIN_BANDWIDTH_HZ: f64 = 2_500.0;
pub const DEMOD_MAX_BANDWIDTH_HZ: f64 = 40_000.0;

pub const DEMOD_DEFAULT_GAIN: f32 = 2.0;
pub const DEMOD_DEFAULT_DEVIATION_HZ: f64 = 5_000.0;
pub const DEMOD_DEFAULT_HYSTERESIS_DB: f64 = 2.0;
pub const DEMOD_DEFAULT_HANG_MS: f64 = 250.0;
pub const DEMOD_DEFAULT_QUIETING_DB: f64 = 6.0;

/// Largest `queueBytes` the process accepts. `ChannelQueue` allocates its whole capacity up front,
/// so an absurd request must be refused here, not met with a huge allocation. 64 MiB is ~170 s
/// of 48 kHz cf32 and far above every §6 budget; Task 16's Node schema mirrors it.
pub const MAX_QUEUE_BYTES: usize = 64 << 20;

/// Accepted cu8 `gain` range, inclusive. Both ends are normal f32 values, so the parsed f64 never
/// becomes `inf` (above f32::MAX) or a subnormal or 0 (below f32::MIN_POSITIVE) as an f32; ±120 dB
/// is far beyond any useful cu8 scaling. Node's schema and `admitChannel` use the same range.
pub const MIN_GAIN: f64 = 1e-6;
pub const MAX_GAIN: f64 = 1e6;

#[derive(Debug, Clone, PartialEq)]
pub struct OpenReq {
    pub id: String,
    pub center_hz: f64,
    pub bandwidth_hz: f64,
    pub transition_hz: f64,
    pub output_rate_hz: u64,
    pub format: Format,
    pub gain: f32,
    pub queue_bytes: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AudioFormat {
    F32Le,
    S16Le,
}

impl AudioFormat {
    pub fn sample_bytes(self) -> usize {
        match self {
            AudioFormat::F32Le => 4,
            AudioFormat::S16Le => 2,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            AudioFormat::F32Le => "f32le",
            AudioFormat::S16Le => "s16le",
        }
    }

    fn parse(s: &str) -> Option<Self> {
        match s {
            "f32le" => Some(AudioFormat::F32Le),
            "s16le" => Some(AudioFormat::S16Le),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SquelchMode {
    Off,
    Power,
    Noise,
}

impl SquelchMode {
    fn parse(s: &str) -> Option<Self> {
        match s {
            "off" => Some(SquelchMode::Off),
            "power" => Some(SquelchMode::Power),
            "noise" => Some(SquelchMode::Noise),
            _ => None,
        }
    }
}

/// Audio options carried by a demod `open`. Missing keys take the kernel defaults.
#[derive(Debug, Clone, PartialEq)]
pub struct AudioOpts {
    pub gain: f32,
    pub deviation_hz: f64,
    pub de_emphasis_us: Option<u32>,
    pub low_pass_hz: Option<f64>,
    pub high_pass_hz: Option<f64>,
}

impl Default for AudioOpts {
    fn default() -> Self {
        Self {
            gain: DEMOD_DEFAULT_GAIN,
            deviation_hz: DEMOD_DEFAULT_DEVIATION_HZ,
            de_emphasis_us: None,
            low_pass_hz: None,
            high_pass_hz: None,
        }
    }
}

/// One `retune {audio}` object. `None` keeps the current value. `Some(None)` clears a filter.
#[derive(Debug, Clone, PartialEq)]
pub struct AudioUpdate {
    pub gain: Option<f32>,
    pub deviation_hz: Option<f64>,
    pub de_emphasis_us: Option<Option<u32>>,
    pub low_pass_hz: Option<Option<f64>>,
    pub high_pass_hz: Option<Option<f64>>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SquelchOpts {
    pub mode: SquelchMode,
    pub threshold_dbfs: Option<f64>,
    pub hysteresis_db: f64,
    pub hang_ms: f64,
    pub quieting_db: f64,
}

impl Default for SquelchOpts {
    fn default() -> Self {
        Self {
            mode: SquelchMode::Off,
            threshold_dbfs: None,
            hysteresis_db: DEMOD_DEFAULT_HYSTERESIS_DB,
            hang_ms: DEMOD_DEFAULT_HANG_MS,
            quieting_db: DEMOD_DEFAULT_QUIETING_DB,
        }
    }
}

/// Fields present on a `squelch` request. Omitted numeric fields keep the channel's current value.
#[derive(Debug, Clone, PartialEq)]
pub struct SquelchReq {
    pub id: String,
    pub mode: SquelchMode,
    pub threshold_dbfs: Option<f64>,
    pub hysteresis_db: Option<f64>,
    pub hang_ms: Option<f64>,
    pub quieting_db: Option<f64>,
    /// `None` leaves the floor unchanged. `Some(None)` clears it. `Some(Some(dbfs))`
    /// is the WG7 noise-floor estimate, applied only while a power gate is closed.
    pub noise_floor_dbfs: Option<Option<f64>>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct DemodOpen {
    pub id: String,
    pub center_hz: f64,
    pub bandwidth_hz: f64,
    pub modulation: Modulation,
    pub format: AudioFormat,
    pub queue_bytes: usize,
    pub audio: AudioOpts,
    pub squelch: SquelchOpts,
    pub metrics: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RetuneReq {
    pub id: String,
    pub center_hz: Option<f64>,
    pub bandwidth_hz: Option<f64>,
    pub modulation: Option<Modulation>,
    pub audio: Option<AudioUpdate>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Request {
    Open(OpenReq),
    OpenDemod(DemodOpen),
    Retune(RetuneReq),
    Squelch(SquelchReq),
    Close {
        id: String,
    },
    MarkGap {
        at_input_byte: Option<u64>,
        dropped_input_bytes: Option<u64>,
    },
    Shutdown,
}

/// The schema's id pattern, `[A-Za-z0-9._-]{1,64}`.
pub fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'_' || b == b'-')
}

fn only(obj: &Map<String, Value>, keys: &[&str]) -> Result<(), String> {
    match obj.keys().find(|k| !keys.contains(&k.as_str())) {
        Some(k) => Err(format!("unknown field {k}")),
        None => Ok(()),
    }
}

/// Parses one control line. An error carries the request's `id` when it had a string one (or
/// "") and a detail; the runtime answers it with `rejected`, never an exit (§11).
pub fn parse_request(line: &str) -> Result<Request, (String, String)> {
    if line.len() > MAX_CONTROL_LINE_BYTES {
        return Err((
            String::new(),
            format!("control line exceeds {MAX_CONTROL_LINE_BYTES} bytes"),
        ));
    }
    let v: Value =
        serde_json::from_str(line).map_err(|e| (String::new(), format!("invalid JSON: {e}")))?;
    let obj = v
        .as_object()
        .ok_or_else(|| (String::new(), "request must be an object".to_string()))?;
    let id = obj
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let err = |d: String| (id.clone(), d);
    if obj.get("v").and_then(Value::as_u64) != Some(1) {
        return Err(err("v must be 1".into()));
    }
    let num = |k: &str| {
        obj.get(k)
            .and_then(Value::as_f64)
            .ok_or_else(|| err(format!("{k} must be a number")))
    };
    let uint = |k: &str| {
        obj.get(k)
            .and_then(Value::as_u64)
            .ok_or_else(|| err(format!("{k} must be a non-negative integer")))
    };
    let opt_uint = |k: &str| match obj.get(k) {
        None => Ok(None),
        Some(_) => uint(k).map(Some),
    };
    let checked_id = || {
        if valid_id(&id) {
            Ok(id.clone())
        } else {
            Err(err("id must match [A-Za-z0-9._-]{1,64}".into()))
        }
    };
    match obj.get("type").and_then(Value::as_str) {
        Some("open") if obj.contains_key("kind") => parse_demod_open(obj, id),
        Some("open") => {
            only(
                obj,
                &[
                    "v",
                    "type",
                    "id",
                    "centerHz",
                    "bandwidthHz",
                    "transitionHz",
                    "outputRateHz",
                    "format",
                    "gain",
                    "queueBytes",
                ],
            )
            .map_err(err)?;
            let id = checked_id()?;
            let format = obj
                .get("format")
                .and_then(Value::as_str)
                .and_then(Format::parse)
                .ok_or_else(|| err("format must be cu8|cf32".into()))?;
            // Same rule as Node's admitChannel (Task 16): gain is cu8 only, within MIN_GAIN..=MAX_GAIN.
            let gain = match obj.get("gain") {
                None => 1.0,
                Some(_) if format != Format::Cu8 => return Err(err("gain is cu8 only".into())),
                Some(g) => g
                    .as_f64()
                    .filter(|g| (MIN_GAIN..=MAX_GAIN).contains(g))
                    .ok_or_else(|| {
                        err(format!(
                            "gain must be a number within {MIN_GAIN}..={MAX_GAIN}"
                        ))
                    })? as f32,
            };
            let queue_bytes = uint("queueBytes")?;
            if queue_bytes == 0 || queue_bytes > MAX_QUEUE_BYTES as u64 {
                return Err(err(format!(
                    "queueBytes must be within 1..={MAX_QUEUE_BYTES}"
                )));
            }
            Ok(Request::Open(OpenReq {
                id,
                center_hz: num("centerHz")?,
                bandwidth_hz: num("bandwidthHz")?,
                transition_hz: num("transitionHz")?,
                output_rate_hz: uint("outputRateHz")?,
                format,
                gain,
                queue_bytes: queue_bytes as usize,
            }))
        }
        Some("retune") => parse_retune(obj, id),
        Some("squelch") => parse_squelch(obj, id),
        Some("close") => {
            only(obj, &["v", "type", "id"]).map_err(err)?;
            Ok(Request::Close { id: checked_id()? })
        }
        Some("mark-gap") => {
            only(obj, &["v", "type", "atInputByte", "droppedInputBytes"]).map_err(err)?;
            Ok(Request::MarkGap {
                at_input_byte: opt_uint("atInputByte")?,
                dropped_input_bytes: opt_uint("droppedInputBytes")?,
            })
        }
        Some("shutdown") => {
            only(obj, &["v", "type"]).map_err(err)?;
            Ok(Request::Shutdown)
        }
        _ => Err(err("unknown request type".into())),
    }
}

/// Private opt-in envelope. The ordinary parser remains strict version 1.
#[derive(Debug, Clone, PartialEq)]
pub enum ObservedRequest {
    Ordinary(Request),
    Open {
        token: u64,
        request: OpenReq,
    },
    InvalidOpen {
        token: u64,
        id: String,
        detail: String,
    },
}

// serde_json::Value normally replaces duplicate keys. Observed identity must never do so.
struct UniqueObject(Map<String, Value>);
impl<'de> serde::Deserialize<'de> for UniqueObject {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Visitor;
        impl<'de> serde::de::Visitor<'de> for Visitor {
            type Value = UniqueObject;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("an object without duplicate keys")
            }
            fn visit_map<M: serde::de::MapAccess<'de>>(
                self,
                mut map: M,
            ) -> Result<Self::Value, M::Error> {
                let mut result = Map::new();
                while let Some((key, value)) = map.next_entry::<String, Value>()? {
                    if result.insert(key, value).is_some() {
                        return Err(serde::de::Error::custom("duplicate field"));
                    }
                }
                Ok(UniqueObject(result))
            }
        }
        deserializer.deserialize_map(Visitor)
    }
}

pub fn parse_observed_request(line: &str) -> Result<ObservedRequest, (String, String)> {
    let value: Value =
        serde_json::from_str(line).map_err(|e| (String::new(), format!("invalid JSON: {e}")))?;
    if value.get("type").and_then(Value::as_str) != Some("open-observed") {
        return parse_request(line).map(ObservedRequest::Ordinary);
    }
    let UniqueObject(mut obj) = serde_json::from_str::<UniqueObject>(line)
        .map_err(|e| (String::new(), format!("invalid observed JSON: {e}")))?;
    drop(value);
    let id = obj
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let token = obj
        .get("token")
        .and_then(Value::as_str)
        .filter(|t| !t.is_empty() && !t.starts_with('0') && t.bytes().all(|b| b.is_ascii_digit()))
        .and_then(|t| t.parse::<u64>().ok())
        .filter(|t| *t > 0)
        .ok_or_else(|| {
            (
                id.clone(),
                "token must be a canonical positive decimal u64 string".into(),
            )
        })?;
    // Identity spelling is closed ASCII, so escaped keys/token/id cannot disguise identity.
    if line.contains('\\') || !valid_id(&id) {
        return Err((
            id,
            "observed identity must use unescaped ASCII spelling".into(),
        ));
    }
    only(
        &obj,
        &[
            "v",
            "type",
            "token",
            "id",
            "centerHz",
            "bandwidthHz",
            "transitionHz",
            "outputRateHz",
            "format",
            "gain",
            "queueBytes",
        ],
    )
    .map_err(|detail| (id.clone(), detail))?;
    if obj.get("v").and_then(Value::as_u64) != Some(1) {
        return Err((id, "v must be 1".into()));
    }
    obj.remove("token");
    obj.insert("type".into(), Value::String("open".into()));
    match parse_request(&Value::Object(obj).to_string()) {
        Ok(Request::Open(request)) => Ok(ObservedRequest::Open { token, request }),
        Err((_, detail)) => Ok(ObservedRequest::InvalidOpen { token, id, detail }),
        Ok(_) => Ok(ObservedRequest::InvalidOpen {
            token,
            id,
            detail: "observed open does not accept kind demod".into(),
        }),
    }
}

fn parse_demod_open(obj: &Map<String, Value>, id: String) -> Result<Request, (String, String)> {
    let err = |d: String| (id.clone(), d);
    only(
        obj,
        &[
            "v",
            "type",
            "id",
            "kind",
            "centerHz",
            "bandwidthHz",
            "modulation",
            "format",
            "queueBytes",
            "audio",
            "squelch",
            "metrics",
        ],
    )
    .map_err(err)?;
    if obj.get("kind").and_then(Value::as_str) != Some("demod") {
        return Err(err("kind must be \"demod\"".into()));
    }
    if !valid_id(&id) {
        return Err(err("id must match [A-Za-z0-9._-]{1,64}".into()));
    }
    let center_hz = finite_required(obj, "centerHz").map_err(err)?;
    let bandwidth_hz = finite_required(obj, "bandwidthHz").map_err(err)?;
    if !(DEMOD_MIN_BANDWIDTH_HZ..=DEMOD_MAX_BANDWIDTH_HZ).contains(&bandwidth_hz) {
        return Err(err(format!(
            "bandwidthHz must be within {DEMOD_MIN_BANDWIDTH_HZ}..={DEMOD_MAX_BANDWIDTH_HZ}"
        )));
    }
    let modulation = modulation_of(obj.get("modulation")).map_err(err)?;
    let format = obj
        .get("format")
        .and_then(Value::as_str)
        .and_then(AudioFormat::parse)
        .ok_or_else(|| err("format must be f32le|s16le".into()))?;
    let queue_bytes = uint_required(obj, "queueBytes").map_err(err)?;
    if queue_bytes == 0 || queue_bytes > MAX_QUEUE_BYTES as u64 {
        return Err(err(format!(
            "queueBytes must be within 1..={MAX_QUEUE_BYTES}"
        )));
    }
    let audio = match obj.get("audio") {
        None => AudioOpts::default(),
        Some(v) => parse_audio_opts(v).map_err(err)?,
    };
    let squelch = match obj.get("squelch") {
        None => SquelchOpts::default(),
        Some(v) => parse_squelch_opts(v).map_err(err)?,
    };
    let metrics = match obj.get("metrics") {
        None => false,
        Some(Value::Bool(b)) => *b,
        Some(_) => return Err(err("metrics must be a boolean".into())),
    };
    check_audio_vs_modulation(modulation, &audio).map_err(err)?;
    Ok(Request::OpenDemod(DemodOpen {
        id: id.clone(),
        center_hz,
        bandwidth_hz,
        modulation,
        format,
        queue_bytes: queue_bytes as usize,
        audio,
        squelch,
        metrics,
    }))
}

fn parse_retune(obj: &Map<String, Value>, id: String) -> Result<Request, (String, String)> {
    let err = |d: String| (id.clone(), d);
    only(
        obj,
        &[
            "v",
            "type",
            "id",
            "centerHz",
            "bandwidthHz",
            "modulation",
            "audio",
        ],
    )
    .map_err(err)?;
    if !valid_id(&id) {
        return Err(err("id must match [A-Za-z0-9._-]{1,64}".into()));
    }
    let center_hz = match obj.get("centerHz") {
        None => None,
        Some(_) => Some(finite_required(obj, "centerHz").map_err(err)?),
    };
    let bandwidth_hz = match obj.get("bandwidthHz") {
        None => None,
        Some(_) => {
            let bw = finite_required(obj, "bandwidthHz").map_err(err)?;
            if !(DEMOD_MIN_BANDWIDTH_HZ..=DEMOD_MAX_BANDWIDTH_HZ).contains(&bw) {
                return Err(err(format!(
                    "bandwidthHz must be within {DEMOD_MIN_BANDWIDTH_HZ}..={DEMOD_MAX_BANDWIDTH_HZ}"
                )));
            }
            Some(bw)
        }
    };
    let modulation = match obj.get("modulation") {
        None => None,
        Some(v) => Some(modulation_of(Some(v)).map_err(err)?),
    };
    let audio = match obj.get("audio") {
        None => None,
        Some(v) => Some(parse_audio_update(v).map_err(err)?),
    };
    Ok(Request::Retune(RetuneReq {
        id: id.clone(),
        center_hz,
        bandwidth_hz,
        modulation,
        audio,
    }))
}

fn parse_squelch(obj: &Map<String, Value>, id: String) -> Result<Request, (String, String)> {
    let err = |d: String| (id.clone(), d);
    only(
        obj,
        &[
            "v",
            "type",
            "id",
            "mode",
            "thresholdDbfs",
            "hysteresisDb",
            "hangMs",
            "quietingDb",
            "noiseFloorDbfs",
        ],
    )
    .map_err(err)?;
    if !valid_id(&id) {
        return Err(err("id must match [A-Za-z0-9._-]{1,64}".into()));
    }
    let mode = obj
        .get("mode")
        .and_then(Value::as_str)
        .and_then(SquelchMode::parse)
        .ok_or_else(|| err("mode must be off|power|noise".into()))?;
    let threshold_dbfs = optional_finite(obj, "thresholdDbfs").map_err(err)?;
    let hysteresis_db = optional_db(obj, "hysteresisDb").map_err(err)?;
    let hang_ms = optional_hang(obj, "hangMs").map_err(err)?;
    let quieting_db = optional_finite(obj, "quietingDb").map_err(err)?;
    let noise_floor_dbfs = optional_nullable_finite(obj, "noiseFloorDbfs").map_err(err)?;
    Ok(Request::Squelch(SquelchReq {
        id: id.clone(),
        mode,
        threshold_dbfs,
        hysteresis_db,
        hang_ms,
        quieting_db,
        noise_floor_dbfs,
    }))
}

/// Absent → `None` (leave the floor). JSON null → `Some(None)` (clear). A finite number → set.
fn optional_nullable_finite(
    obj: &Map<String, Value>,
    key: &str,
) -> Result<Option<Option<f64>>, String> {
    match obj.get(key) {
        None => Ok(None),
        Some(Value::Null) => Ok(Some(None)),
        Some(Value::Number(n)) => n
            .as_f64()
            .filter(|x| x.is_finite())
            .map(|x| Some(Some(x)))
            .ok_or_else(|| format!("{key} must be a finite number or null")),
        Some(_) => Err(format!("{key} must be a finite number or null")),
    }
}

fn modulation_of(v: Option<&Value>) -> Result<Modulation, String> {
    match v.and_then(Value::as_str) {
        Some("nfm") => Ok(Modulation::Nfm),
        Some("am") => Ok(Modulation::Am),
        _ => Err("modulation must be nfm|am".into()),
    }
}

fn finite_required(obj: &Map<String, Value>, key: &str) -> Result<f64, String> {
    match obj.get(key) {
        Some(Value::Number(n)) => n
            .as_f64()
            .filter(|x| x.is_finite())
            .ok_or_else(|| format!("{key} must be a finite number")),
        Some(_) => Err(format!("{key} must be a number")),
        None => Err(format!("missing {key}")),
    }
}

fn optional_finite(obj: &Map<String, Value>, key: &str) -> Result<Option<f64>, String> {
    match obj.get(key) {
        None => Ok(None),
        Some(Value::Number(n)) => n
            .as_f64()
            .filter(|x| x.is_finite())
            .map(Some)
            .ok_or_else(|| format!("{key} must be a finite number")),
        Some(_) => Err(format!("{key} must be a number")),
    }
}

fn optional_db(obj: &Map<String, Value>, key: &str) -> Result<Option<f64>, String> {
    let Some(v) = optional_finite(obj, key)? else {
        return Ok(None);
    };
    if (0.0..=1.0e6).contains(&v) {
        Ok(Some(v))
    } else {
        Err(format!("{key} must be within 0..=1000000"))
    }
}

fn optional_hang(obj: &Map<String, Value>, key: &str) -> Result<Option<f64>, String> {
    let Some(v) = optional_finite(obj, key)? else {
        return Ok(None);
    };
    if (0.0..=86_400_000.0).contains(&v) {
        Ok(Some(v))
    } else {
        Err(format!("{key} must be within 0..=86400000"))
    }
}

fn uint_required(obj: &Map<String, Value>, key: &str) -> Result<u64, String> {
    obj.get(key)
        .and_then(Value::as_u64)
        .ok_or_else(|| format!("{key} must be a non-negative integer"))
}

fn check_audio_vs_modulation(modulation: Modulation, audio: &AudioOpts) -> Result<(), String> {
    if modulation == Modulation::Am && audio.de_emphasis_us.is_some() {
        return Err("deEmphasisUs is NFM only".into());
    }
    if !(audio.gain.is_finite() && audio.gain >= 0.1 && audio.gain <= 100.0) {
        return Err("gain must be within 0.1..=100".into());
    }
    if !(audio.deviation_hz.is_finite()
        && audio.deviation_hz > 0.0
        && audio.deviation_hz < DEMOD_OUTPUT_RATE_HZ as f64 / 2.0)
    {
        return Err("deviationHz must be within (0, 24000)".into());
    }
    if let Some(low) = audio.low_pass_hz {
        if !(low.is_finite() && low > 0.0 && low < DEMOD_OUTPUT_RATE_HZ as f64 / 2.0) {
            return Err("lowPassHz must be within (0, 24000)".into());
        }
    }
    if let Some(high) = audio.high_pass_hz {
        if !(high.is_finite() && high > 0.0 && high < DEMOD_OUTPUT_RATE_HZ as f64 / 2.0) {
            return Err("highPassHz must be within (0, 24000)".into());
        }
        if let Some(low) = audio.low_pass_hz {
            if high >= low {
                return Err("highPassHz must be below lowPassHz".into());
            }
        }
    }
    Ok(())
}

fn parse_audio_opts(v: &Value) -> Result<AudioOpts, String> {
    let obj = v.as_object().ok_or("audio must be an object")?;
    only(
        obj,
        &[
            "gain",
            "deviationHz",
            "deEmphasisUs",
            "lowPassHz",
            "highPassHz",
        ],
    )?;
    let mut audio = AudioOpts::default();
    if obj.contains_key("gain") {
        let g = finite_required(obj, "gain")?;
        audio.gain = g as f32;
    }
    if obj.contains_key("deviationHz") {
        audio.deviation_hz = finite_required(obj, "deviationHz")?;
    }
    if let Some(v) = obj.get("deEmphasisUs") {
        audio.de_emphasis_us = parse_de_emphasis(v)?;
    }
    if obj.contains_key("lowPassHz") {
        audio.low_pass_hz = nullable_hz(obj, "lowPassHz")?;
    }
    if obj.contains_key("highPassHz") {
        audio.high_pass_hz = nullable_hz(obj, "highPassHz")?;
    }
    Ok(audio)
}

fn parse_audio_update(v: &Value) -> Result<AudioUpdate, String> {
    let obj = v.as_object().ok_or("audio must be an object")?;
    only(
        obj,
        &[
            "gain",
            "deviationHz",
            "deEmphasisUs",
            "lowPassHz",
            "highPassHz",
        ],
    )?;
    let gain = if obj.contains_key("gain") {
        let g = finite_required(obj, "gain")?;
        if !(0.1..=100.0).contains(&g) {
            return Err("gain must be within 0.1..=100".into());
        }
        Some(g as f32)
    } else {
        None
    };
    let deviation_hz = if obj.contains_key("deviationHz") {
        let d = finite_required(obj, "deviationHz")?;
        if !(d > 0.0 && d < DEMOD_OUTPUT_RATE_HZ as f64 / 2.0) {
            return Err("deviationHz must be within (0, 24000)".into());
        }
        Some(d)
    } else {
        None
    };
    let de_emphasis_us = match obj.get("deEmphasisUs") {
        None => None,
        Some(v) => Some(parse_de_emphasis(v)?),
    };
    let low_pass_hz = if obj.contains_key("lowPassHz") {
        Some(nullable_hz(obj, "lowPassHz")?)
    } else {
        None
    };
    let high_pass_hz = if obj.contains_key("highPassHz") {
        Some(nullable_hz(obj, "highPassHz")?)
    } else {
        None
    };
    Ok(AudioUpdate {
        gain,
        deviation_hz,
        de_emphasis_us,
        low_pass_hz,
        high_pass_hz,
    })
}

fn parse_de_emphasis(v: &Value) -> Result<Option<u32>, String> {
    match v {
        Value::Null => Ok(None),
        Value::Number(n) => match n.as_u64() {
            Some(50) => Ok(Some(50)),
            Some(75) => Ok(Some(75)),
            _ => Err("deEmphasisUs must be 50 or 75".into()),
        },
        _ => Err("deEmphasisUs must be 50, 75 or null".into()),
    }
}

fn nullable_hz(obj: &Map<String, Value>, key: &str) -> Result<Option<f64>, String> {
    match obj.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Number(n)) => {
            let x = n
                .as_f64()
                .filter(|x| x.is_finite())
                .ok_or_else(|| format!("{key} must be a finite number"))?;
            if x > 0.0 && x < DEMOD_OUTPUT_RATE_HZ as f64 / 2.0 {
                Ok(Some(x))
            } else {
                Err(format!("{key} must be within (0, 24000)"))
            }
        }
        Some(_) => Err(format!("{key} must be a number or null")),
    }
}

fn parse_squelch_opts(v: &Value) -> Result<SquelchOpts, String> {
    let obj = v.as_object().ok_or("squelch must be an object")?;
    only(
        obj,
        &[
            "mode",
            "thresholdDbfs",
            "hysteresisDb",
            "hangMs",
            "quietingDb",
        ],
    )?;
    let mode = obj
        .get("mode")
        .and_then(Value::as_str)
        .and_then(SquelchMode::parse)
        .ok_or("mode must be off|power|noise")?;
    let mut opts = SquelchOpts {
        mode,
        ..SquelchOpts::default()
    };
    if obj.contains_key("thresholdDbfs") {
        opts.threshold_dbfs = optional_finite(obj, "thresholdDbfs")?;
    }
    if let Some(h) = optional_db(obj, "hysteresisDb")? {
        opts.hysteresis_db = h;
    }
    if let Some(h) = optional_hang(obj, "hangMs")? {
        opts.hang_ms = h;
    }
    if let Some(q) = optional_finite(obj, "quietingDb")? {
        opts.quieting_db = q;
    }
    Ok(opts)
}

#[cfg(test)]
mod tests {
    use super::*;

    const OPEN: &str = r#""v":1,"type":"open","id":"ais-g1","centerHz":162000000,"bandwidthHz":364800,"transitionHz":9600,"outputRateHz":384000"#;

    fn open_with(rest: &str) -> Result<Request, (String, String)> {
        parse_request(&format!("{{{OPEN},{rest}}}"))
    }

    // Feature: core-channelizer, Property 14: Protocol validity (Rust parse side)
    // Validates: addendum §11, §12.14
    #[test]
    fn parses_v1_and_rejects_everything_else() {
        let ok = parse_request(
            r#"{"v":1,"type":"open","id":"ais-g1","centerHz":162000000,"bandwidthHz":364800,"transitionHz":9600,"outputRateHz":384000,"format":"cu8","queueBytes":192000}"#,
        );
        assert!(matches!(ok, Ok(Request::Open(_))));
        assert!(matches!(
            parse_request(r#"{"v":1,"type":"mark-gap","atInputByte":4096}"#),
            Ok(Request::MarkGap {
                at_input_byte: Some(4096),
                ..
            })
        ));
        for bad in [
            "not json",
            r#"{"v":2,"type":"shutdown"}"#,
            r#"{"v":1,"type":"explode","id":"x"}"#,
            r#"{"v":1,"type":"open","id":"bad id!"}"#,
            r#"{"v":1,"type":"open","id":"a","extra":1}"#,
        ] {
            assert!(parse_request(bad).is_err(), "{bad}");
        }
        assert_eq!(
            parse_request(r#"{"v":1,"type":"explode","id":"x"}"#)
                .unwrap_err()
                .0,
            "x"
        );
    }

    #[test]
    fn open_fields_and_defaults() {
        let Ok(Request::Open(o)) = open_with(r#""format":"cu8","queueBytes":192000"#) else {
            panic!("open must parse")
        };
        assert_eq!(
            o,
            OpenReq {
                id: "ais-g1".into(),
                center_hz: 162e6,
                bandwidth_hz: 364_800.0,
                transition_hz: 9_600.0,
                output_rate_hz: 384_000,
                format: Format::Cu8,
                gain: 1.0,
                queue_bytes: 192_000,
            }
        );
        let Ok(Request::Open(o)) = open_with(r#""format":"cu8","gain":2.5,"queueBytes":2"#) else {
            panic!("gain must parse")
        };
        assert_eq!((o.gain, o.queue_bytes), (2.5, 2));
    }

    // Mirrors Node's admission checks (Task 16) so the two agree (Property 1).
    #[test]
    fn open_rejects_what_node_rejects() {
        for rest in [
            r#""format":"cs16","queueBytes":192000"#,
            r#""format":"cf32","gain":2,"queueBytes":192000"#,
            r#""format":"cu8","gain":0,"queueBytes":192000"#,
            r#""format":"cu8","gain":-1,"queueBytes":192000"#,
            r#""format":"cu8","gain":"2","queueBytes":192000"#,
            r#""format":"cu8","queueBytes":0"#,
            r#""format":"cu8","queueBytes":-5"#,
            r#""format":"cu8","queueBytes":1.5"#,
            r#""format":"cu8""#,
        ] {
            let e = open_with(rest).unwrap_err();
            assert_eq!(e.0, "ais-g1", "{rest}");
        }
        let line = |center: &str, out: &str| {
            format!(
                r#"{{"v":1,"type":"open","id":"a","centerHz":{center},"bandwidthHz":45600,"transitionHz":1200,"outputRateHz":{out},"format":"cu8","queueBytes":2}}"#
            )
        };
        assert!(parse_request(&line("162e6", "48000")).is_ok());
        for (center, out) in [
            ("162e6", "48000.5"),
            ("162e6", "-1"),
            ("\"162e6\"", "48000"),
            ("null", "48000"),
        ] {
            assert!(parse_request(&line(center, out)).is_err(), "{center} {out}");
        }
        let missing = r#"{"v":1,"type":"open","id":"a","bandwidthHz":1,"transitionHz":1,"outputRateHz":1,"format":"cu8","queueBytes":2}"#;
        assert!(parse_request(missing).is_err());
    }

    // Node's schema and admitChannel use the same range (Property 1).
    #[test]
    fn gain_is_bounded_to_a_finite_normal_f32_range() {
        for g in ["1e-6", "0.000001", "1e6", "1000000", "2.5"] {
            let Ok(Request::Open(o)) =
                open_with(&format!(r#""format":"cu8","gain":{g},"queueBytes":2"#))
            else {
                panic!("gain {g} must parse")
            };
            assert!(o.gain.is_normal() && o.gain > 0.0, "{g} -> {}", o.gain);
        }
        assert_eq!((MIN_GAIN, MAX_GAIN), (1e-6, 1e6));
        // Above f32::MAX the cast gave inf; below f32::MIN_POSITIVE it gave a subnormal or 0.
        for g in [
            "1000000.0001",
            "1e7",
            "1e39",
            "1e300",
            "9.9e-7",
            "1e-39",
            "1e-300",
        ] {
            let e = open_with(&format!(r#""format":"cu8","gain":{g},"queueBytes":2"#)).unwrap_err();
            assert!(e.1.contains("gain"), "{g}: {}", e.1);
        }
    }

    // JS parses a number literal correctly rounded, as `str::parse::<f64>` does. serde_json's default
    // fast path misses by one ulp on many 17-digit literals (all of these), which can flip a verdict
    // that sits on an admission boundary; `float_roundtrip` makes the two agree (Property 1).
    #[test]
    fn numbers_parse_exactly_as_js_does() {
        for x in [
            "99682904.01506901",
            "100314340.81832843",
            "9.999999999999999e5",
            "28.966552742717226",
            "0.060001140267409596",
        ] {
            let line = format!(
                r#"{{"v":1,"type":"open","id":"a","centerHz":{x},"bandwidthHz":{x},"transitionHz":1,"outputRateHz":1,"format":"cu8","queueBytes":2}}"#
            );
            let Ok(Request::Open(o)) = parse_request(&line) else {
                panic!("{line}")
            };
            let want = x.parse::<f64>().unwrap().to_bits();
            assert_eq!(o.center_hz.to_bits(), want, "centerHz {x}");
            assert_eq!(o.bandwidth_hz.to_bits(), want, "bandwidthHz {x}");
        }
    }

    #[test]
    fn queue_bytes_is_capped() {
        let at = format!(r#""format":"cu8","queueBytes":{MAX_QUEUE_BYTES}"#);
        assert!(open_with(&at).is_ok());
        let over = format!(r#""format":"cu8","queueBytes":{}"#, MAX_QUEUE_BYTES + 1);
        let e = open_with(&over).unwrap_err();
        assert!(e.1.contains("queueBytes"), "{}", e.1);
        assert!(open_with(r#""format":"cu8","queueBytes":18446744073709551615"#).is_err());
    }

    #[test]
    fn ids_follow_the_schema() {
        let id64 = "a".repeat(64);
        assert_eq!(
            parse_request(&format!(r#"{{"v":1,"type":"close","id":"{id64}"}}"#)),
            Ok(Request::Close { id: id64.clone() })
        );
        for bad in ["", "a b", "a/b", "é", &"a".repeat(65)] {
            let line = format!(r#"{{"v":1,"type":"close","id":"{bad}"}}"#);
            assert!(parse_request(&line).is_err(), "{line}");
        }
        assert!(parse_request(r#"{"v":1,"type":"close","id":7}"#).is_err());
        assert_eq!(
            parse_request(r#"{"v":1,"type":"close","id":7}"#)
                .unwrap_err()
                .0,
            ""
        );
    }

    #[test]
    fn mark_gap_shutdown_and_close_are_strict() {
        assert_eq!(
            parse_request(r#"{"v":1,"type":"mark-gap"}"#),
            Ok(Request::MarkGap {
                at_input_byte: None,
                dropped_input_bytes: None
            })
        );
        assert_eq!(
            parse_request(r#"{"v":1,"type":"mark-gap","atInputByte":0,"droppedInputBytes":512}"#),
            Ok(Request::MarkGap {
                at_input_byte: Some(0),
                dropped_input_bytes: Some(512)
            })
        );
        assert_eq!(
            parse_request(r#"{"v":1,"type":"shutdown"}"#),
            Ok(Request::Shutdown)
        );
        for bad in [
            r#"{"v":1,"type":"mark-gap","atInputByte":-1}"#,
            r#"{"v":1,"type":"mark-gap","atInputByte":1.5}"#,
            r#"{"v":1,"type":"mark-gap","droppedInputBytes":"9"}"#,
            r#"{"v":1,"type":"mark-gap","id":"a"}"#,
            r#"{"v":1,"type":"shutdown","id":"a"}"#,
            r#"{"v":1,"type":"close","id":"a","reason":"x"}"#,
            r#"{"type":"shutdown"}"#,
            r#"{"v":"1","type":"shutdown"}"#,
            r#"{"v":1.0,"type":"shutdown"}"#,
            r#"{"v":1}"#,
            r#"[1]"#,
            "",
        ] {
            assert!(parse_request(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn squelch_noise_floor_is_optional_nullable_and_finite() {
        let absent = parse_request(r#"{"v":1,"type":"squelch","id":"d","mode":"power"}"#).unwrap();
        let Request::Squelch(absent) = absent else {
            panic!("squelch");
        };
        assert_eq!(absent.noise_floor_dbfs, None);

        let clear = parse_request(
            r#"{"v":1,"type":"squelch","id":"d","mode":"power","noiseFloorDbfs":null}"#,
        )
        .unwrap();
        let Request::Squelch(clear) = clear else {
            panic!("squelch");
        };
        assert_eq!(clear.noise_floor_dbfs, Some(None));

        let set = parse_request(
            r#"{"v":1,"type":"squelch","id":"d","mode":"power","noiseFloorDbfs":-45.5}"#,
        )
        .unwrap();
        let Request::Squelch(set) = set else {
            panic!("squelch");
        };
        assert_eq!(set.noise_floor_dbfs, Some(Some(-45.5)));

        assert!(parse_request(
            r#"{"v":1,"type":"squelch","id":"d","mode":"power","noiseFloorDbfs":"low"}"#
        )
        .is_err());
        assert!(parse_request(
            r#"{"v":1,"type":"squelch","id":"d","mode":"power","noiseFloorDbfs":1e309}"#
        )
        .is_err());
    }
}
