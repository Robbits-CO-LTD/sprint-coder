// Changed by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
use clap::Args;

#[derive(Args, Debug)]
pub(crate) struct IdentityArgs {
    #[arg(
        long,
        global = true,
        help = "Select the snapshot namespace; session-owned refs require the same scope"
    )]
    pub session: Option<String>,
    #[arg(
        long,
        global = true,
        help = "Harness subagent ID within --session (1-64 letters/digits/-/_)"
    )]
    pub agent_id: Option<String>,
}
