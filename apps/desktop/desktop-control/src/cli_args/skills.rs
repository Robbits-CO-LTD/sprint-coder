// Changed by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
use clap::{Args, Subcommand};

#[derive(Args, Debug)]
#[command(after_help = "\
Skills are compiled into the binary, so they always match this exact
sprint-coder-desktop-control version. Each command prints the JSON envelope; the skill's
markdown is in data.content.

Start here:
  sprint-coder-desktop-control skills get desktop            # Core guide, any OS
  sprint-coder-desktop-control skills get platform           # Guide for the OS you run on

More:
  sprint-coder-desktop-control skills                        # List skills
  sprint-coder-desktop-control skills get desktop workflows  # One reference
  sprint-coder-desktop-control skills get windows            # A named platform guide
  sprint-coder-desktop-control skills path                   # Where skills live")]
pub(crate) struct SkillsArgs {
    #[command(subcommand)]
    pub action: Option<SkillsAction>,
}

#[derive(Subcommand, Debug)]
pub(crate) enum SkillsAction {
    #[command(about = "List bundled skills with summaries (default)")]
    List,
    #[command(about = "Print a skill (markdown in data.content)")]
    Get(SkillsGetArgs),
    #[command(about = "Print where bundled skills live")]
    Path,
}

#[derive(Args, Debug)]
pub(crate) struct SkillsGetArgs {
    #[arg(help = "Skill name or alias: desktop, platform, macos, windows, linux, ffi")]
    pub name: String,
    #[arg(
        help = "Reference filename (e.g. workflows or references/workflows.md). Omit for the main guide."
    )]
    pub reference: Option<String>,
    #[arg(long, help = "Append every reference file to the output")]
    pub full: bool,
}
