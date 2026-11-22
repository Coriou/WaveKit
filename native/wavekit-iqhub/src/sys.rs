//! The system calls, one function each, through the `libc` crate. Every socket is
//! non-blocking and close-on-exec. SIGPIPE is ignored process-wide, and as a second guard a
//! write to a closed peer cannot raise it either: on Linux every send passes `MSG_NOSIGNAL`, on
//! macOS (which has no such flag) every socket sets `SO_NOSIGPIPE`.
//!
//! Platform branches (`cfg`), the only ones in the crate:
//! - `MSG_NOSIGNAL` on Linux, `SO_NOSIGPIPE` on macOS ([`SEND_FLAGS`], [`no_sigpipe`]);
//! - the keepalive idle option: `TCP_KEEPIDLE` on Linux, `TCP_KEEPALIVE` on macOS.

use crate::hub::{CloseReason, Failure, Received, Sent};
use std::ffi::{c_int, c_void};
use std::net::SocketAddr;
use std::os::fd::{FromRawFd, OwnedFd, RawFd};

#[cfg(not(target_os = "macos"))]
pub const SEND_FLAGS: c_int = libc::MSG_NOSIGNAL;
#[cfg(target_os = "macos")]
pub const SEND_FLAGS: c_int = 0;

fn errno() -> c_int {
    std::io::Error::last_os_error().raw_os_error().unwrap_or(0)
}

fn would_block(e: c_int) -> bool {
    e == libc::EAGAIN || e == libc::EWOULDBLOCK || e == libc::EINTR
}

/// The reason an attempt closes for a socket error.
pub fn reason(e: c_int) -> CloseReason {
    match e {
        libc::ECONNREFUSED => CloseReason::Refused,
        libc::ENETUNREACH | libc::EHOSTUNREACH | libc::ENETDOWN | libc::EHOSTDOWN => {
            CloseReason::Unreachable
        }
        libc::ETIMEDOUT => CloseReason::Timeout,
        libc::ECONNRESET | libc::EPIPE | libc::ECONNABORTED | libc::ENOTCONN => CloseReason::Reset,
        _ => CloseReason::Error,
    }
}

/// The failure for an error number: the portable reason and the platform's own number.
pub fn failure(e: c_int) -> Failure {
    Failure {
        reason: reason(e),
        errno: Some(e),
    }
}

fn io_failure(e: &std::io::Error) -> Failure {
    match e.raw_os_error() {
        Some(n) => failure(n),
        None => CloseReason::Error.into(),
    }
}

/// One line on stderr, `wavekit-iqhub: <msg>`. A failed write is ignored: with stderr closed by
/// the parent (`EPIPE`), `eprintln!` would panic and turn exit code 1 into 101.
pub fn log(msg: std::fmt::Arguments) {
    use std::io::Write as _;
    let line = format!("wavekit-iqhub: {msg}\n");
    let _ = std::io::stderr().write_all(line.as_bytes());
}

/// Whether `fd` is an open file descriptor (`fcntl(F_GETFD)` succeeds).
pub fn fd_is_open(fd: RawFd) -> bool {
    // SAFETY: F_GETFD only reads the descriptor's flags; any integer is a valid argument.
    unsafe { libc::fcntl(fd, libc::F_GETFD) >= 0 }
}

/// Takes the inherited control fd: it must be open, and becomes this process's and non-blocking.
/// Called before the hub creates any fd, so a number the parent did not open can never name one
/// of the hub's own sockets. (Fds 0 to 2 need no such check: the Rust runtime opens `/dev/null`
/// on any of them that is closed before `main` runs.)
pub fn take_control_fd(fd: RawFd) -> Result<OwnedFd, String> {
    if fd < 3 || !fd_is_open(fd) {
        return Err(format!("control fd {fd} is not open"));
    }
    // SAFETY: the fd is open, and nothing else in this process uses it: it was inherited, and
    // the process has created no fd yet.
    let owned = unsafe { OwnedFd::from_raw_fd(fd) };
    set_nonblocking(fd).map_err(|e| format!("control fd {fd}: {e}"))?;
    Ok(owned)
}

pub fn ignore_sigpipe() {
    // SAFETY: setting a signal's disposition to SIG_IGN has no preconditions.
    unsafe {
        libc::signal(libc::SIGPIPE, libc::SIG_IGN);
    }
}

pub fn set_nonblocking(fd: RawFd) -> std::io::Result<()> {
    // SAFETY: fcntl on a caller-owned fd with integer arguments.
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 {
        return Err(std::io::Error::last_os_error());
    }
    // SAFETY: as above.
    if unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

fn set_cloexec(fd: RawFd) {
    // SAFETY: fcntl on a caller-owned fd with integer arguments; failure leaves the flag unset,
    // which only lets a child the hub never spawns inherit the fd.
    unsafe {
        libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC);
    }
}

fn set_int(fd: RawFd, level: c_int, name: c_int, value: c_int) -> bool {
    // SAFETY: a valid pointer to a c_int and its size, for the call's duration.
    unsafe {
        libc::setsockopt(
            fd,
            level,
            name,
            (&raw const value).cast::<c_void>(),
            std::mem::size_of::<c_int>() as libc::socklen_t,
        ) == 0
    }
}

fn get_int(fd: RawFd, level: c_int, name: c_int) -> Option<c_int> {
    let mut value: c_int = 0;
    let mut len = std::mem::size_of::<c_int>() as libc::socklen_t;
    // SAFETY: valid pointers to a c_int and its length, for the call's duration.
    let r = unsafe {
        libc::getsockopt(
            fd,
            level,
            name,
            (&raw mut value).cast::<c_void>(),
            &raw mut len,
        )
    };
    (r == 0).then_some(value)
}

/// On macOS a write to a closed peer must not raise SIGPIPE (ignored anyway).
#[cfg(target_os = "macos")]
pub fn no_sigpipe(fd: RawFd) {
    set_int(fd, libc::SOL_SOCKET, libc::SO_NOSIGPIPE, 1);
}
#[cfg(not(target_os = "macos"))]
pub fn no_sigpipe(_fd: RawFd) {}

#[cfg(target_os = "macos")]
const KEEPALIVE_IDLE: c_int = libc::TCP_KEEPALIVE;
#[cfg(not(target_os = "macos"))]
const KEEPALIVE_IDLE: c_int = libc::TCP_KEEPIDLE;

/// Keepalive: the first probe after `ms` idle (rounded up to a second), then one every
/// third of that (at least 1 s), 3 unanswered probes close the connection: a dead peer is
/// found after about twice `ms` of silence.
fn keepalive(fd: RawFd, ms: u64) {
    let idle = ms.div_ceil(1000).clamp(1, c_int::MAX as u64) as c_int;
    set_int(fd, libc::SOL_SOCKET, libc::SO_KEEPALIVE, 1);
    set_int(fd, libc::IPPROTO_TCP, KEEPALIVE_IDLE, idle);
    set_int(
        fd,
        libc::IPPROTO_TCP,
        libc::TCP_KEEPINTVL,
        (idle / 3).max(1),
    );
    set_int(fd, libc::IPPROTO_TCP, libc::TCP_KEEPCNT, 3);
}

fn connect_raw(fd: RawFd, addr: &SocketAddr) -> c_int {
    match addr {
        SocketAddr::V4(a) => {
            // SAFETY: sockaddr_in is plain data; all zeroes is a valid value. On macOS the
            // kernel sets sin_len from the length argument.
            let mut sin: libc::sockaddr_in = unsafe { std::mem::zeroed() };
            sin.sin_family = libc::AF_INET as libc::sa_family_t;
            sin.sin_port = a.port().to_be();
            sin.sin_addr = libc::in_addr {
                s_addr: u32::from_ne_bytes(a.ip().octets()),
            };
            // SAFETY: a valid sockaddr_in and its size.
            unsafe {
                libc::connect(
                    fd,
                    (&raw const sin).cast::<libc::sockaddr>(),
                    std::mem::size_of::<libc::sockaddr_in>() as libc::socklen_t,
                )
            }
        }
        SocketAddr::V6(a) => {
            // SAFETY: sockaddr_in6 is plain data; all zeroes is a valid value.
            let mut sin6: libc::sockaddr_in6 = unsafe { std::mem::zeroed() };
            sin6.sin6_family = libc::AF_INET6 as libc::sa_family_t;
            sin6.sin6_port = a.port().to_be();
            sin6.sin6_addr.s6_addr = a.ip().octets();
            sin6.sin6_flowinfo = a.flowinfo();
            sin6.sin6_scope_id = a.scope_id();
            // SAFETY: a valid sockaddr_in6 and its size.
            unsafe {
                libc::connect(
                    fd,
                    (&raw const sin6).cast::<libc::sockaddr>(),
                    std::mem::size_of::<libc::sockaddr_in6>() as libc::socklen_t,
                )
            }
        }
    }
}

/// Starts a non-blocking TCP connect. `Ok((fd, true))`: already connected.
pub fn tcp_connect(
    addr: &SocketAddr,
    keep_alive_ms: Option<u64>,
) -> Result<(OwnedFd, bool), Failure> {
    let domain = if addr.is_ipv4() {
        libc::AF_INET
    } else {
        libc::AF_INET6
    };
    // SAFETY: socket() with integer arguments.
    let raw = unsafe { libc::socket(domain, libc::SOCK_STREAM, 0) };
    if raw < 0 {
        return Err(failure(errno()));
    }
    // SAFETY: `raw` is a new fd that nothing else owns.
    let fd = unsafe { OwnedFd::from_raw_fd(raw) };
    set_cloexec(raw);
    set_nonblocking(raw).map_err(|e| io_failure(&e))?;
    no_sigpipe(raw);
    // A 5-byte tuner command leaves at once instead of waiting for Nagle's acknowledgement.
    set_int(raw, libc::IPPROTO_TCP, libc::TCP_NODELAY, 1);
    if let Some(ms) = keep_alive_ms {
        keepalive(raw, ms);
    }
    if connect_raw(raw, addr) == 0 {
        return Ok((fd, true));
    }
    match errno() {
        libc::EINPROGRESS | libc::EINTR => Ok((fd, false)),
        e => Err(failure(e)),
    }
}

/// The outcome of a connect that reported writable.
pub fn connect_result(fd: RawFd) -> Result<(), Failure> {
    match get_int(fd, libc::SOL_SOCKET, libc::SO_ERROR) {
        Some(0) => Ok(()),
        Some(e) => Err(failure(e)),
        None => Err(failure(errno())),
    }
}

/// The local port of a connected socket (`getsockname`).
pub fn local_port(fd: RawFd) -> Result<u16, Failure> {
    // SAFETY: sockaddr_storage is plain data; all zeroes is a valid value.
    let mut ss: libc::sockaddr_storage = unsafe { std::mem::zeroed() };
    let mut len = std::mem::size_of::<libc::sockaddr_storage>() as libc::socklen_t;
    // SAFETY: a valid sockaddr_storage and its length, for the call's duration; the kernel
    // writes at most `len` bytes.
    let r = unsafe { libc::getsockname(fd, (&raw mut ss).cast::<libc::sockaddr>(), &raw mut len) };
    if r != 0 {
        return Err(failure(errno()));
    }
    match ss.ss_family as c_int {
        libc::AF_INET => {
            // SAFETY: the family says the storage holds a sockaddr_in, which it is large and
            // aligned enough for.
            let sin = unsafe { &*(&raw const ss).cast::<libc::sockaddr_in>() };
            Ok(u16::from_be(sin.sin_port))
        }
        libc::AF_INET6 => {
            // SAFETY: as above, a sockaddr_in6.
            let sin6 = unsafe { &*(&raw const ss).cast::<libc::sockaddr_in6>() };
            Ok(u16::from_be(sin6.sin6_port))
        }
        _ => Err(CloseReason::Error.into()),
    }
}

fn received(r: isize) -> Received {
    match r {
        0 => Received::Eof,
        n if n > 0 => Received::Data(n as usize),
        _ => match errno() {
            e if would_block(e) => Received::WouldBlock,
            e => Received::Failed(failure(e)),
        },
    }
}

fn sent(r: isize) -> Sent {
    match r {
        n if n >= 0 => Sent::Took(n as usize),
        _ => match errno() {
            e if would_block(e) => Sent::WouldBlock,
            e => Sent::Failed(failure(e)),
        },
    }
}

pub fn recv(fd: RawFd, buf: &mut [u8]) -> Received {
    if buf.is_empty() {
        return Received::WouldBlock;
    }
    // SAFETY: a valid writable buffer and its length.
    received(unsafe { libc::recv(fd, buf.as_mut_ptr().cast::<c_void>(), buf.len(), 0) })
}

/// One `readv` into `a`, then `b` (a plain `recv` when `b` is empty).
pub fn recv2(fd: RawFd, a: &mut [u8], b: &mut [u8]) -> Received {
    if b.is_empty() {
        return recv(fd, a);
    }
    if a.is_empty() {
        return recv(fd, b);
    }
    let iov = [
        libc::iovec {
            iov_base: a.as_mut_ptr().cast::<c_void>(),
            iov_len: a.len(),
        },
        libc::iovec {
            iov_base: b.as_mut_ptr().cast::<c_void>(),
            iov_len: b.len(),
        },
    ];
    // SAFETY: two iovecs over live, writable, non-overlapping slices for the call's duration.
    received(unsafe { libc::readv(fd, iov.as_ptr(), 2) })
}

pub fn peek(fd: RawFd) -> Received {
    let mut b = [0u8; 1];
    // SAFETY: a valid one-byte buffer.
    received(unsafe { libc::recv(fd, b.as_mut_ptr().cast::<c_void>(), 1, libc::MSG_PEEK) })
}

pub fn send(fd: RawFd, bytes: &[u8]) -> Sent {
    // SAFETY: a valid readable buffer and its length.
    sent(unsafe { libc::send(fd, bytes.as_ptr().cast::<c_void>(), bytes.len(), SEND_FLAGS) })
}

/// One `sendmsg` of up to three slices (a record header and the ring's two sides of the wrap).
pub fn sendv(fd: RawFd, bufs: &[&[u8]]) -> Sent {
    let empty = libc::iovec {
        iov_base: std::ptr::null_mut(),
        iov_len: 0,
    };
    let mut iov = [empty; 3];
    let mut n = 0;
    for b in bufs.iter().filter(|b| !b.is_empty()).take(3) {
        iov[n] = libc::iovec {
            iov_base: b.as_ptr() as *mut c_void,
            iov_len: b.len(),
        };
        n += 1;
    }
    if n == 0 {
        return Sent::Took(0);
    }
    // SAFETY: msghdr is plain data; all zeroes is a valid empty header.
    let mut msg: libc::msghdr = unsafe { std::mem::zeroed() };
    msg.msg_iov = iov.as_mut_ptr();
    msg.msg_iovlen = n as _;
    // SAFETY: the header points at `n` valid iovecs over live slices; sendmsg only reads them.
    sent(unsafe { libc::sendmsg(fd, &raw const msg, SEND_FLAGS) })
}

pub fn fionread(fd: RawFd) -> u64 {
    let mut n: c_int = 0;
    // SAFETY: FIONREAD writes one c_int through the pointer.
    let r = unsafe { libc::ioctl(fd, libc::FIONREAD, &raw mut n) };
    if r < 0 {
        0
    } else {
        n.max(0) as u64
    }
}

pub fn shutdown_read(fd: RawFd) {
    // SAFETY: shutdown on a caller-owned socket.
    unsafe {
        libc::shutdown(fd, libc::SHUT_RD);
    }
}

/// Shuts the write side (a FIN after the bytes already queued); reading goes on.
pub fn shutdown_write(fd: RawFd) {
    // SAFETY: shutdown on a caller-owned socket.
    unsafe {
        libc::shutdown(fd, libc::SHUT_WR);
    }
}

/// Requests a send buffer and returns what the kernel reports (Linux reports twice the
/// request, its bookkeeping included).
pub fn set_send_buffer(fd: RawFd, bytes: usize) -> Option<usize> {
    let want = bytes.min(c_int::MAX as usize) as c_int;
    set_int(fd, libc::SOL_SOCKET, libc::SO_SNDBUF, want);
    get_int(fd, libc::SOL_SOCKET, libc::SO_SNDBUF).map(|g| g.max(0) as usize)
}

pub type PollFd = libc::pollfd;
pub const POLLIN: i16 = libc::POLLIN;
pub const POLLOUT: i16 = libc::POLLOUT;
pub const POLLERR: i16 = libc::POLLERR;
pub const POLLHUP: i16 = libc::POLLHUP;
pub const POLLNVAL: i16 = libc::POLLNVAL;

pub fn pollfd(fd: RawFd, events: i16) -> PollFd {
    PollFd {
        fd,
        events,
        revents: 0,
    }
}

/// `poll`; an interrupted call reports no readiness.
pub fn poll(fds: &mut [PollFd], timeout_ms: c_int) -> std::io::Result<usize> {
    // SAFETY: a valid array of pollfd and its length for the call's duration.
    let r = unsafe { libc::poll(fds.as_mut_ptr(), fds.len() as libc::nfds_t, timeout_ms) };
    if r < 0 {
        if errno() == libc::EINTR {
            return Ok(0);
        }
        return Err(std::io::Error::last_os_error());
    }
    Ok(r as usize)
}

pub enum FdRead {
    Data(usize),
    WouldBlock,
    Eof,
    Failed,
}

pub fn read(fd: RawFd, buf: &mut [u8]) -> FdRead {
    if buf.is_empty() {
        return FdRead::WouldBlock;
    }
    // SAFETY: a valid writable buffer and its length.
    let r = unsafe { libc::read(fd, buf.as_mut_ptr().cast::<c_void>(), buf.len()) };
    match r {
        0 => FdRead::Eof,
        n if n > 0 => FdRead::Data(n as usize),
        _ if would_block(errno()) => FdRead::WouldBlock,
        _ => FdRead::Failed,
    }
}

pub enum FdWrite {
    Took(usize),
    WouldBlock,
    Closed,
    Failed,
}

pub fn write(fd: RawFd, bytes: &[u8]) -> FdWrite {
    // SAFETY: a valid readable buffer and its length.
    let r = unsafe { libc::write(fd, bytes.as_ptr().cast::<c_void>(), bytes.len()) };
    match r {
        n if n >= 0 => FdWrite::Took(n as usize),
        _ => match errno() {
            e if would_block(e) => FdWrite::WouldBlock,
            libc::EPIPE => FdWrite::Closed,
            _ => FdWrite::Failed,
        },
    }
}

pub fn euid() -> u32 {
    // SAFETY: geteuid has no preconditions.
    unsafe { libc::geteuid() }
}

/// CPU time and context switches of this process (`getrusage(RUSAGE_SELF)`).
#[derive(Debug, Clone, Copy, Default)]
pub struct Usage {
    pub user_us: u64,
    pub system_us: u64,
    pub voluntary: u64,
    pub involuntary: u64,
}

pub fn usage_self() -> Usage {
    // SAFETY: rusage is plain data; getrusage fills it.
    let mut ru: libc::rusage = unsafe { std::mem::zeroed() };
    // SAFETY: a valid rusage pointer.
    unsafe {
        libc::getrusage(libc::RUSAGE_SELF, &raw mut ru);
    }
    let us = |t: libc::timeval| t.tv_sec as u64 * 1_000_000 + t.tv_usec as u64;
    Usage {
        user_us: us(ru.ru_utime),
        system_us: us(ru.ru_stime),
        voluntary: ru.ru_nvcsw as u64,
        involuntary: ru.ru_nivcsw as u64,
    }
}
