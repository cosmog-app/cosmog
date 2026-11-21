//! Plugin store (Phase 3): the catalog (`index.json` in the cosmog-plugins repo), and signed
//! installs from its GitHub releases. Desktop only. See docs/PLUGINS.md "Registry".

pub mod http;
pub mod index;
pub mod install;
pub mod keys;
