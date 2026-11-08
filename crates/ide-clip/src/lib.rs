//! Clipboard copy/paste (ported from snip-sync's snip-core at 81654b1): the
//! ClipCode-compatible file format, commit replay payloads, export from git and
//! restore planning.

pub mod blob;
pub mod browser;
pub mod clip;
pub mod commits;
pub mod copy;
pub mod filter;
pub mod format;
pub mod fsutil;
pub mod gitrun;
pub mod gitsrc;
pub mod nontext;
pub mod paths;
pub mod restore;
pub mod settings;
pub mod stats;
pub mod transfer;
pub mod workspace;
