// Changed by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
mod bridge;
mod child;
mod endpoint;
mod host_watch;
mod placement;
mod spawn;

pub(crate) use child::entry_from_env;
pub(crate) use spawn::update;
