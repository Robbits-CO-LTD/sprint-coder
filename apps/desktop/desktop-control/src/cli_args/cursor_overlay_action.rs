// Changed by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
use clap::Subcommand;

use super::cursor_overlay_enable::CursorOverlayEnableArgs;

#[derive(Subcommand, Debug)]
pub(crate) enum CursorOverlayAction {
    #[command(about = "Enable and configure the cursor overlay for the selected session")]
    Enable(Box<CursorOverlayEnableArgs>),
    #[command(about = "Disable the cursor overlay for the selected session")]
    Disable,
    /// Hidden: the host that keeps the session takes down a finished agent's
    /// cursor with it, and an agent has no reason to.
    #[command(
        hide = true,
        about = "Take down the cursor of the selected agent (--agent-id) only"
    )]
    Retire,
}
