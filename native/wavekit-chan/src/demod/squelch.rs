//! Block squelch state machines mirroring `ChannelSquelch` / `NoiseSquelch`.
//!
//! Power: open at `level >= threshold`, hold while within `hysteresis_db` below it, close after
//! `hang_ms` of stream time. A hold-band block that is also less than `hysteresis_db` above the
//! frozen noise floor does not refresh the hang (WG7 noise tail). The floor is sampled only
//! while the gate is closed; `None` clears it in every state.
//!
//! Noise: the same hang and hysteresis on the quieting metric. NaN (an unusable block) does not
//! open or refresh, matching a quieting of −∞.
//!
//! `block_ms` is the stream time added at the start of each block, the same value
//! `ChannelSquelch` stores as `(blockSamples / sampleRate) * 1000`.

/// Power gate. `threshold_dbfs: None`, or any value that is not a finite negative number,
/// disables the gate (it stays open), matching `normalizeThreshold`.
#[derive(Clone, Debug)]
pub struct PowerGate {
    threshold_dbfs: Option<f64>,
    hysteresis_db: f64,
    hang_ms: f64,
    block_ms: f64,
    stream_ms: f64,
    last_above_ms: f64,
    floor_dbfs: Option<f64>,
    open: bool,
}

impl PowerGate {
    pub fn new(
        threshold_dbfs: Option<f64>,
        hysteresis_db: f64,
        hang_ms: f64,
        block_ms: f64,
    ) -> Self {
        let threshold_dbfs = normalize_threshold(threshold_dbfs);
        Self {
            open: threshold_dbfs.is_none(),
            threshold_dbfs,
            hysteresis_db,
            hang_ms,
            block_ms,
            stream_ms: 0.0,
            last_above_ms: f64::NEG_INFINITY,
            floor_dbfs: None,
        }
    }

    pub fn is_open(&self) -> bool {
        self.open
    }

    pub fn set_threshold_dbfs(&mut self, threshold_dbfs: Option<f64>) {
        self.threshold_dbfs = normalize_threshold(threshold_dbfs);
        if self.threshold_dbfs.is_none() {
            self.open = true;
        }
    }

    /// Floor estimate in dBFS. Applied only while the gate is closed; `None` clears it.
    pub fn set_noise_floor_dbfs(&mut self, floor_dbfs: Option<f64>) {
        match floor_dbfs {
            Some(floor) if floor.is_finite() => {
                if !self.open {
                    self.floor_dbfs = Some(floor);
                }
            }
            _ => self.floor_dbfs = None,
        }
    }

    /// One block at `level_dbfs`. Returns the gate after the block.
    pub fn push(&mut self, level_dbfs: f64) -> bool {
        self.stream_ms += self.block_ms;
        let Some(threshold) = self.threshold_dbfs else {
            return self.open;
        };
        if level_dbfs >= threshold {
            self.open = true;
            self.last_above_ms = self.stream_ms;
        } else if self.open {
            let in_band = level_dbfs >= threshold - self.hysteresis_db;
            let above_floor = match self.floor_dbfs {
                Some(floor) => level_dbfs >= floor + self.hysteresis_db,
                None => true,
            };
            if in_band && above_floor {
                self.last_above_ms = self.stream_ms;
            } else if self.stream_ms - self.last_above_ms >= self.hang_ms {
                self.open = false;
            }
        }
        self.open
    }
}

/// FM-quieting gate. Starts closed. `quieting_db` of NaN is an unusable block.
#[derive(Clone, Debug)]
pub struct NoiseGate {
    threshold_db: f64,
    hysteresis_db: f64,
    hang_ms: f64,
    block_ms: f64,
    stream_ms: f64,
    last_above_ms: f64,
    open: bool,
}

impl NoiseGate {
    pub fn new(quieting_db: f64, hysteresis_db: f64, hang_ms: f64, block_ms: f64) -> Self {
        Self {
            threshold_db: quieting_db,
            hysteresis_db,
            hang_ms,
            block_ms,
            stream_ms: 0.0,
            last_above_ms: f64::NEG_INFINITY,
            open: false,
        }
    }

    pub fn is_open(&self) -> bool {
        self.open
    }

    pub fn push(&mut self, quieting_db: f64) -> bool {
        self.stream_ms += self.block_ms;
        if quieting_db >= self.threshold_db {
            self.open = true;
            self.last_above_ms = self.stream_ms;
        } else if self.open {
            if quieting_db >= self.threshold_db - self.hysteresis_db {
                self.last_above_ms = self.stream_ms;
            } else if self.stream_ms - self.last_above_ms >= self.hang_ms {
                self.open = false;
            }
        }
        self.open
    }
}

fn normalize_threshold(value: Option<f64>) -> Option<f64> {
    match value {
        Some(value) if value.is_finite() && value < 0.0 => Some(value),
        _ => None,
    }
}
