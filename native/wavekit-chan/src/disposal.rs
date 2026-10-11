//! Private physical-disposal witness. Publisher destruction never implies completion.
use std::io::{self, ErrorKind, Read, Write};
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::Arc;

pub const CAPABILITY: &str = "attempt-disposal-v1";
pub const SLOTS: usize = 128;
const ALL: u8 = 0x0f;

/// Own the dedicated descriptor only after validating it, then enforce initial blocking reads.
#[cfg(any(target_os = "linux", target_os = "macos"))]
pub(crate) fn bootstrap_fd4() -> io::Result<std::fs::File> {
    use std::os::fd::FromRawFd;
    unsafe extern "C" {
        fn fcntl(fd: i32, command: i32, ...) -> i32;
    }
    // F_GETFD/F_GETFL/F_SETFL are 1/3/4 on the supported Linux and macOS targets.
    // SAFETY: no runtime threads have started; FD4 cannot be concurrently reassigned here.
    if unsafe { fcntl(4, 1) } < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: validation above establishes an open descriptor, exclusively inherited for bootstrap.
    let file = unsafe { std::fs::File::from_raw_fd(4) };
    let flags = unsafe { fcntl(4, 3) };
    if flags < 0 {
        return Err(io::Error::last_os_error());
    }
    #[cfg(target_os = "linux")]
    const NONBLOCK: i32 = 0x800;
    #[cfg(target_os = "macos")]
    const NONBLOCK: i32 = 0x4;
    if unsafe { fcntl(4, 4, flags & !NONBLOCK) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(file)
}
#[cfg(not(any(target_os = "linux", target_os = "macos")))]
pub(crate) fn bootstrap_fd4() -> io::Result<std::fs::File> {
    Err(io::Error::new(
        ErrorKind::Unsupported,
        "settlement bootstrap platform unsupported",
    ))
}

/// Exactly 32 bytes followed by EOF; each phase allows at most eight interruptions.
pub fn read_nonce(mut reader: impl Read) -> io::Result<[u8; 32]> {
    let mut nonce = [0; 32];
    let mut offset = 0;
    let mut interruptions = 0;
    while offset < nonce.len() {
        match reader.read(&mut nonce[offset..]) {
            Ok(0) => return Err(io::Error::new(ErrorKind::UnexpectedEof, "short bootstrap")),
            Ok(n) => offset += n,
            Err(e) if e.kind() == ErrorKind::Interrupted && interruptions < 8 => interruptions += 1,
            Err(e) => return Err(e),
        }
    }
    let mut extra = [0];
    interruptions = 0;
    loop {
        match reader.read(&mut extra) {
            Ok(0) => return Ok(nonce),
            Ok(_) => {
                return Err(io::Error::new(
                    ErrorKind::InvalidData,
                    "extra bootstrap byte",
                ))
            }
            Err(e) if e.kind() == ErrorKind::Interrupted && interruptions < 8 => interruptions += 1,
            Err(e) => return Err(e),
        }
    }
}

pub fn hello(nonce: &[u8; 32], pid: u64) -> Vec<u8> {
    let nonce: String = nonce.iter().map(|b| format!("{b:02x}")).collect();
    format!("{{\"v\":1,\"type\":\"hello\",\"nonce\":\"{nonce}\",\"pid\":\"{pid}\"}}\n").into_bytes()
}

/// Blocking startup only: WouldBlock is fatal, positive writes advance a finite cursor.
pub fn write_hello(mut writer: impl Write, frame: &[u8]) -> io::Result<()> {
    let mut offset = 0;
    let mut interruptions = 0;
    while offset < frame.len() {
        match writer.write(&frame[offset..]) {
            Ok(0) => return Err(io::Error::new(ErrorKind::WriteZero, "hello write zero")),
            Ok(n) => offset += n,
            Err(e) if e.kind() == ErrorKind::Interrupted && interruptions < 8 => interruptions += 1,
            Err(e) => return Err(e),
        }
    }
    Ok(())
}

pub(crate) fn bootstrap(path: &Path, reader: impl Read) -> io::Result<Disposal> {
    // reader ownership is gone (including FD4) before connect, on success and failure.
    let nonce = read_nonce(reader)?;
    let mut stream = UnixStream::connect(path)?;
    write_hello(&mut stream, &hello(&nonce, u64::from(std::process::id())))?;
    stream.set_nonblocking(true)?;
    Ok(Disposal::new(stream))
}

struct Completion {
    token: u64,
    incarnation: u64,
    bits: AtomicU8,
}
struct Publisher<const BIT: u8> {
    completion: Arc<Completion>,
    token: u64,
    incarnation: u64,
}
impl<const BIT: u8> Publisher<BIT> {
    fn publish(self) {
        if self.token == self.completion.token && self.incarnation == self.completion.incarnation {
            self.completion.bits.fetch_or(BIT, Ordering::AcqRel);
        }
        // Consuming self drops the last publishing reference; no Drop implementation publishes.
    }
}
macro_rules! publisher {
    ($name:ident, $bit:literal) => {
        pub(crate) struct $name(Publisher<$bit>);
        impl $name {
            pub(crate) fn publish(self) {
                self.0.publish();
            }
        }
    };
}
publisher!(ReservationPublisher, 1);
publisher!(PayloadPublisher, 2);
publisher!(WriterPublisher, 4);
publisher!(LogicalPublisher, 8);

pub(crate) struct PreparationPermits {
    pub reservation: ReservationPublisher,
    pub payload: PayloadPublisher,
}
pub(crate) struct RuntimePermits {
    pub slot: usize,
    pub writer: WriterPublisher,
    pub logical: LogicalPublisher,
}
pub(crate) struct AttemptPermits {
    pub preparation: PreparationPermits,
    pub runtime: RuntimePermits,
}
struct Record {
    completion: Arc<Completion>,
    id: String,
    frame: Vec<u8>, // Empty until Acquire/all-bits/sole-Arc eligibility; then <=129 bytes.
}
struct Cursor {
    slot: Option<usize>, // None is the single refusal lane
    offset: usize,
}
pub(crate) enum Admission {
    Accepted(AttemptPermits),
    Refused,
    Invalid,
}
pub(crate) struct Disposal {
    stream: UnixStream,
    records: [Option<Record>; SLOTS],
    refusal: Option<Vec<u8>>,
    cursor: Option<Cursor>,
    scan: usize,
    last_token: u64,
    incarnation: u64,
    failed: bool,
}
fn disposed(token: u64, id: &str) -> Vec<u8> {
    format!("{{\"v\":1,\"type\":\"disposed\",\"token\":\"{token}\",\"id\":\"{id}\"}}\n")
        .into_bytes()
}
impl Disposal {
    pub(crate) fn new(stream: UnixStream) -> Self {
        Self {
            stream,
            records: std::array::from_fn(|_| None),
            refusal: None,
            cursor: None,
            scan: 0,
            last_token: 0,
            incarnation: 0,
            failed: false,
        }
    }
    #[cfg(test)]
    pub(crate) fn bits_for_test(&self, slot: usize) -> u8 {
        self.records[slot]
            .as_ref()
            .unwrap()
            .completion
            .bits
            .load(Ordering::Acquire)
    }
    pub(crate) fn admit(&mut self, token: u64, id: &str) -> Admission {
        if self.failed || token <= self.last_token || !crate::protocol::valid_id(id) {
            return Admission::Invalid;
        }
        self.last_token = token;
        let Some(next) = self.incarnation.checked_add(1) else {
            self.failed = true;
            return Admission::Invalid;
        };
        if self.refusal.is_some() {
            return Admission::Refused;
        }
        let Some(slot) = self.records.iter().position(Option::is_none) else {
            if self.refusal.is_none() {
                self.refusal = Some(disposed(token, id));
            }
            return Admission::Refused;
        };
        self.incarnation = next;
        let completion = Arc::new(Completion {
            token,
            incarnation: next,
            bits: AtomicU8::new(0),
        });
        let publisher = |bit_completion: Arc<Completion>| (bit_completion, token, next);
        let (c, t, i) = publisher(completion.clone());
        let reservation = ReservationPublisher(Publisher {
            completion: c,
            token: t,
            incarnation: i,
        });
        let (c, t, i) = publisher(completion.clone());
        let payload = PayloadPublisher(Publisher {
            completion: c,
            token: t,
            incarnation: i,
        });
        let (c, t, i) = publisher(completion.clone());
        let writer = WriterPublisher(Publisher {
            completion: c,
            token: t,
            incarnation: i,
        });
        let (c, t, i) = publisher(completion.clone());
        let logical = LogicalPublisher(Publisher {
            completion: c,
            token: t,
            incarnation: i,
        });
        self.records[slot] = Some(Record {
            completion,
            id: id.to_owned(),
            frame: Vec::new(),
        });
        Admission::Accepted(AttemptPermits {
            preparation: PreparationPermits {
                reservation,
                payload,
            },
            runtime: RuntimePermits {
                slot,
                writer,
                logical,
            },
        })
    }
    /// Scan all fixed slots from a rotating origin; <=8 raw writes, one partial cursor.
    pub(crate) fn poll(&mut self) {
        self.poll_with(|stream, bytes| stream.write(bytes));
    }
    fn poll_with(&mut self, mut write: impl FnMut(&mut UnixStream, &[u8]) -> io::Result<usize>) {
        if self.failed {
            return;
        }
        let mut scan_budget = SLOTS;
        for _ in 0..8 {
            if self.cursor.is_none() {
                // One refusal cannot starve behind a sustained set of eligible records.
                if self.refusal.is_some() {
                    self.cursor = Some(Cursor {
                        slot: None,
                        offset: 0,
                    });
                } else {
                    let mut ready = None;
                    while scan_budget > 0 {
                        scan_budget -= 1;
                        let i = self.scan;
                        self.scan = (i + 1) % SLOTS;
                        if self.records[i].as_ref().is_some_and(|r| {
                            r.completion.bits.load(Ordering::Acquire) == ALL
                                && Arc::strong_count(&r.completion) == 1
                        }) {
                            ready = Some(i);
                            break;
                        }
                    }
                    let Some(slot) = ready else {
                        return;
                    };
                    let record = self.records[slot].as_mut().unwrap();
                    // Serialization follows the acquired complete mask and sole-reference test.
                    record.frame = disposed(record.completion.token, &record.id);
                    self.cursor = Some(Cursor {
                        slot: Some(slot),
                        offset: 0,
                    });
                }
            }
            let cursor = self.cursor.as_mut().unwrap();
            let frame = match cursor.slot {
                Some(i) => &self.records[i].as_ref().unwrap().frame,
                None => self.refusal.as_ref().unwrap(),
            };
            match write(&mut self.stream, &frame[cursor.offset..]) {
                Ok(0) => {
                    self.failed = true;
                    return;
                }
                Ok(n) => {
                    cursor.offset += n;
                    if cursor.offset == frame.len() {
                        match cursor.slot {
                            Some(i) => {
                                drop(self.records[i].take());
                            }
                            None => {
                                drop(self.refusal.take());
                            }
                        }
                        self.cursor = None;
                    }
                }
                Err(e) if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::Interrupted) => {}
                Err(_) => {
                    self.failed = true;
                    return;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn table() -> Disposal {
        let (stream, _peer) = UnixStream::pair().unwrap();
        stream.set_nonblocking(true).unwrap();
        Disposal::new(stream)
    }
    fn accepted(d: &mut Disposal, token: u64) -> AttemptPermits {
        match d.admit(token, "same-id") {
            Admission::Accepted(p) => p,
            _ => panic!("admission"),
        }
    }
    fn complete(p: AttemptPermits) {
        p.preparation.reservation.publish();
        p.preparation.payload.publish();
        p.runtime.writer.publish();
        p.runtime.logical.publish();
    }

    #[test]
    fn canonical_frame_size_is_bounded_without_escaping() {
        let id = "a".repeat(64);
        let frame = disposed(u64::MAX, &id);
        assert_eq!(frame.len(), 129);
        assert!(frame.is_ascii());
        assert!(!frame.contains(&b'\r'));
        assert!(!frame.contains(&b'\\'));
        assert!(hello(&[0xff; 32], u64::MAX).len() <= 127);
    }

    #[test]
    fn unpublished_drop_and_last_reference_are_not_physical_proof() {
        let mut d = table();
        let p = accepted(&mut d, 1);
        let slot = p.runtime.slot;
        let held = d.records[slot].as_ref().unwrap().completion.clone();
        complete(p);
        let mut writes = 0;
        d.poll_with(|_, bytes| {
            writes += 1;
            Ok(bytes.len())
        });
        assert_eq!(
            writes, 0,
            "all bits cannot override an outstanding reference"
        );
        drop(held);
        d.poll_with(|_, bytes| {
            writes += 1;
            Ok(bytes.len())
        });
        assert_eq!(writes, 1);
        assert!(d.records[slot].is_none());
        let p = accepted(&mut d, 2);
        let slot = p.runtime.slot;
        p.preparation.reservation.publish();
        drop(p.preparation.payload); // panic/uncertain cleanup path: no optimistic Drop bit.
        p.runtime.writer.publish();
        p.runtime.logical.publish();
        d.poll_with(|_, _| panic!("unknown payload must not emit"));
        assert!(d.records[slot].is_some());
    }

    #[test]
    fn fresh_allocation_old_token_and_fixed_mask_survive_slot_reuse() {
        let mut d = table();
        let p = accepted(&mut d, 1);
        let slot = p.runtime.slot;
        complete(p);
        d.poll_with(|_, b| Ok(b.len()));
        let p = accepted(&mut d, 2);
        assert_eq!(p.runtime.slot, slot);
        assert!(matches!(d.admit(1, "same-id"), Admission::Invalid));
        assert!(matches!(d.admit(2, "same-id"), Admission::Invalid));
        assert_eq!(
            d.records[slot]
                .as_ref()
                .unwrap()
                .completion
                .bits
                .load(Ordering::Acquire),
            0
        );
        assert_eq!(d.records[slot].as_ref().unwrap().completion.incarnation, 2);
        p.preparation.reservation.publish();
        p.preparation.payload.publish();
        p.runtime.logical.publish();
        d.poll_with(|_, _| panic!("writer is not joined yet"));
        p.runtime.writer.publish();
        d.poll_with(|_, b| Ok(b.len()));
        assert!(d.records[slot].is_none());
        complete(accepted(&mut d, u64::MAX));
        assert!(matches!(d.admit(u64::MAX, "same-id"), Admission::Invalid));
        assert!(matches!(d.admit(0, "same-id"), Admission::Invalid));
    }

    #[test]
    fn partial_cursor_interrupts_backpressure_and_fatal_write_never_interleave_or_refund() {
        let mut d = table();
        complete(accepted(&mut d, 1));
        complete(accepted(&mut d, 2));
        let mut wire = Vec::new();
        let mut calls = 0;
        d.poll_with(|_, b| {
            calls += 1;
            if calls == 1 {
                wire.extend_from_slice(&b[..3]);
                return Ok(3);
            }
            Err(io::Error::from(if calls % 2 == 0 {
                ErrorKind::Interrupted
            } else {
                ErrorKind::WouldBlock
            }))
        });
        assert_eq!(calls, 8);
        assert_eq!(wire.len(), 3);
        assert_eq!(d.records.iter().flatten().count(), 2);
        d.poll_with(|_, b| {
            wire.extend_from_slice(b);
            Ok(b.len())
        });
        assert_eq!(
            wire,
            [disposed(1, "same-id"), disposed(2, "same-id")].concat()
        );
        complete(accepted(&mut d, 3));
        d.poll_with(|_, _| Err(io::Error::from(ErrorKind::BrokenPipe)));
        assert!(d.failed);
        assert_eq!(d.records.iter().flatten().count(), 1);
        assert!(matches!(d.admit(4, "same-id"), Admission::Invalid));
        d.poll_with(|_, _| panic!("failed transport never reconnects/writes"));
    }

    #[test]
    fn fixed_capacity_refusal_lane_and_eight_writes_are_independent_of_live_slots() {
        let mut d = table();
        let mut permits = Vec::new();
        for token in 1..=SLOTS as u64 {
            permits.push(accepted(&mut d, token));
        }
        assert!(matches!(d.admit(129, "same-id"), Admission::Refused));
        assert!(matches!(d.admit(130, "same-id"), Admission::Refused));
        assert_eq!(d.refusal.as_ref().unwrap(), &disposed(129, "same-id"));
        for p in permits {
            complete(p);
        }
        let mut wire = Vec::new();
        let mut calls = 0;
        d.poll_with(|_, b| {
            calls += 1;
            wire.extend_from_slice(b);
            Ok(b.len())
        });
        assert_eq!(calls, 8);
        assert!(wire.starts_with(&disposed(129, "same-id")));
        assert_eq!(d.records.iter().flatten().count(), SLOTS - 7);
        for _ in 0..16 {
            d.poll_with(|_, b| {
                wire.extend_from_slice(b);
                Ok(b.len())
            });
        }
        assert!(d.records.iter().all(Option::is_none));
        assert_eq!(wire.iter().filter(|&&b| b == b'\n').count(), 129);
        assert!(!String::from_utf8(wire)
            .unwrap()
            .contains("\"token\":\"130\""));
    }
}
