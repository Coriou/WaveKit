//! `wavekit-iqhub`: one process per IQ source. It owns the TCP connection to an rtl_tcp-style
//! endpoint, the tuner command writes and the fanout of the payload to sinks (Unix-socket
//! connections a parent hands to child processes), with exact whole-frame positions. One ring,
//! one thread, one `poll` loop; the decisions live in a state machine ([`hub::Hub`]) that has no
//! I/O and no clock of its own. See README.md for the protocol.

pub mod args;
pub mod events;
pub mod hub;
pub mod io;
pub mod protocol;
pub mod ring;
pub mod stats;
pub mod sys;
