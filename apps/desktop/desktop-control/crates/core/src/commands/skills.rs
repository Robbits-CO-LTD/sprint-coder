// Changed by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
use crate::AppError;
use serde_json::{Value, json};

const SKILL_DESKTOP_MAIN: &str = include_str!("../../../../skills/desktop-control/SKILL.md");
const SKILL_DESKTOP_REF_OBSERVATION: &str =
    include_str!("../../../../skills/desktop-control/references/commands-observation.md");
const SKILL_DESKTOP_REF_INTERACTION: &str =
    include_str!("../../../../skills/desktop-control/references/commands-interaction.md");
const SKILL_DESKTOP_REF_SYSTEM: &str =
    include_str!("../../../../skills/desktop-control/references/commands-system.md");
const SKILL_DESKTOP_REF_WORKFLOWS: &str =
    include_str!("../../../../skills/desktop-control/references/workflows.md");

const SKILL_MACOS_MAIN: &str = include_str!("../../../../skills/desktop-control-macos/SKILL.md");
const SKILL_MACOS_REF_TROUBLESHOOTING: &str =
    include_str!("../../../../skills/desktop-control-macos/references/troubleshooting.md");

const SKILL_WINDOWS_MAIN: &str =
    include_str!("../../../../skills/desktop-control-windows/SKILL.md");
const SKILL_WINDOWS_REF_PERMISSIONS: &str = include_str!(
    "../../../../skills/desktop-control-windows/references/permissions-and-elevation.md"
);
const SKILL_WINDOWS_REF_CHROMIUM: &str =
    include_str!("../../../../skills/desktop-control-windows/references/chromium-and-electron.md");
const SKILL_WINDOWS_REF_TROUBLESHOOTING: &str =
    include_str!("../../../../skills/desktop-control-windows/references/troubleshooting.md");
const SKILL_WINDOWS_REF_SHELL: &str =
    include_str!("../../../../skills/desktop-control-windows/references/shell-and-overlay.md");

const SKILL_LINUX_MAIN: &str = include_str!("../../../../skills/desktop-control-linux/SKILL.md");
const SKILL_LINUX_REF_BUS: &str =
    include_str!("../../../../skills/desktop-control-linux/references/bus-and-permissions.md");
const SKILL_LINUX_REF_DISPLAY: &str = include_str!(
    "../../../../skills/desktop-control-linux/references/display-servers-and-input.md"
);
const SKILL_LINUX_REF_WINDOWS: &str =
    include_str!("../../../../skills/desktop-control-linux/references/windows-and-lifecycle.md");
const SKILL_LINUX_REF_CAPTURE: &str =
    include_str!("../../../../skills/desktop-control-linux/references/capture-and-clipboard.md");
const SKILL_LINUX_REF_SHELL: &str = include_str!(
    "../../../../skills/desktop-control-linux/references/shell-tray-and-notifications.md"
);
const SKILL_LINUX_REF_TROUBLESHOOTING: &str =
    include_str!("../../../../skills/desktop-control-linux/references/troubleshooting.md");

const SKILL_FFI_MAIN: &str = include_str!("../../../../skills/desktop-control-ffi/SKILL.md");
const SKILL_FFI_REF_BUILD: &str =
    include_str!("../../../../skills/desktop-control-ffi/references/build-and-link.md");
const SKILL_FFI_REF_ERRORS: &str =
    include_str!("../../../../skills/desktop-control-ffi/references/error-handling.md");
const SKILL_FFI_REF_OWNERSHIP: &str =
    include_str!("../../../../skills/desktop-control-ffi/references/ownership.md");
const SKILL_FFI_REF_THREADING: &str =
    include_str!("../../../../skills/desktop-control-ffi/references/threading.md");

struct SkillRef {
    rel_path: &'static str,
    body: &'static str,
}

struct Skill {
    canonical: &'static str,
    aliases: &'static [&'static str],
    summary: &'static str,
    platform: Option<&'static str>,
    main: &'static str,
    refs: &'static [SkillRef],
}

const PLATFORM_ALIAS: &str = "platform";

const CURRENT_PLATFORM: Option<&str> = if cfg!(target_os = "macos") {
    Some("macos")
} else if cfg!(target_os = "windows") {
    Some("windows")
} else if cfg!(target_os = "linux") {
    Some("linux")
} else {
    None
};

const SKILL_DESKTOP_REFS: &[SkillRef] = &[
    SkillRef {
        rel_path: "references/commands-observation.md",
        body: SKILL_DESKTOP_REF_OBSERVATION,
    },
    SkillRef {
        rel_path: "references/commands-interaction.md",
        body: SKILL_DESKTOP_REF_INTERACTION,
    },
    SkillRef {
        rel_path: "references/commands-system.md",
        body: SKILL_DESKTOP_REF_SYSTEM,
    },
    SkillRef {
        rel_path: "references/workflows.md",
        body: SKILL_DESKTOP_REF_WORKFLOWS,
    },
];

const SKILL_MACOS_REFS: &[SkillRef] = &[SkillRef {
    rel_path: "references/troubleshooting.md",
    body: SKILL_MACOS_REF_TROUBLESHOOTING,
}];

const SKILL_FFI_REFS: &[SkillRef] = &[
    SkillRef {
        rel_path: "references/build-and-link.md",
        body: SKILL_FFI_REF_BUILD,
    },
    SkillRef {
        rel_path: "references/error-handling.md",
        body: SKILL_FFI_REF_ERRORS,
    },
    SkillRef {
        rel_path: "references/ownership.md",
        body: SKILL_FFI_REF_OWNERSHIP,
    },
    SkillRef {
        rel_path: "references/threading.md",
        body: SKILL_FFI_REF_THREADING,
    },
];

const SKILL_WINDOWS_REFS: &[SkillRef] = &[
    SkillRef {
        rel_path: "references/permissions-and-elevation.md",
        body: SKILL_WINDOWS_REF_PERMISSIONS,
    },
    SkillRef {
        rel_path: "references/chromium-and-electron.md",
        body: SKILL_WINDOWS_REF_CHROMIUM,
    },
    SkillRef {
        rel_path: "references/troubleshooting.md",
        body: SKILL_WINDOWS_REF_TROUBLESHOOTING,
    },
    SkillRef {
        rel_path: "references/shell-and-overlay.md",
        body: SKILL_WINDOWS_REF_SHELL,
    },
];

const SKILL_LINUX_REFS: &[SkillRef] = &[
    SkillRef {
        rel_path: "references/bus-and-permissions.md",
        body: SKILL_LINUX_REF_BUS,
    },
    SkillRef {
        rel_path: "references/display-servers-and-input.md",
        body: SKILL_LINUX_REF_DISPLAY,
    },
    SkillRef {
        rel_path: "references/windows-and-lifecycle.md",
        body: SKILL_LINUX_REF_WINDOWS,
    },
    SkillRef {
        rel_path: "references/capture-and-clipboard.md",
        body: SKILL_LINUX_REF_CAPTURE,
    },
    SkillRef {
        rel_path: "references/shell-tray-and-notifications.md",
        body: SKILL_LINUX_REF_SHELL,
    },
    SkillRef {
        rel_path: "references/troubleshooting.md",
        body: SKILL_LINUX_REF_TROUBLESHOOTING,
    },
];

const SKILLS: &[Skill] = &[
    Skill {
        canonical: "desktop-control",
        aliases: &["desktop", "desktop-control"],
        summary: "Core guide for every OS: the snapshot/ref loop, verification and retry rules, and when to open each reference. Load this first, then `skills get platform`.",
        platform: None,
        main: SKILL_DESKTOP_MAIN,
        refs: SKILL_DESKTOP_REFS,
    },
    Skill {
        canonical: "desktop-control-macos",
        aliases: &["macos", "desktop-control-macos"],
        summary: "macOS platform guide: Accessibility and Screen Recording permissions, what differs on macOS, Notification Center, troubleshooting.",
        platform: Some("macos"),
        main: SKILL_MACOS_MAIN,
        refs: SKILL_MACOS_REFS,
    },
    Skill {
        canonical: "desktop-control-windows",
        aliases: &["windows", "desktop-control-windows"],
        summary: "Windows platform guide: capability table, PowerShell quoting, supported sessions, shell surfaces and Action Center, UIPI/elevation, Chromium/Electron, troubleshooting.",
        platform: Some("windows"),
        main: SKILL_WINDOWS_MAIN,
        refs: SKILL_WINDOWS_REFS,
    },
    Skill {
        canonical: "desktop-control-linux",
        aliases: &["linux", "desktop-control-linux"],
        summary: "Linux platform guide: AT-SPI bus and permissions, X11 versus Wayland, window and app lifecycle, screenshot and clipboard, shell tray and notifications, troubleshooting.",
        platform: Some("linux"),
        main: SKILL_LINUX_MAIN,
        refs: SKILL_LINUX_REFS,
    },
    Skill {
        canonical: "desktop-control-ffi",
        aliases: &["ffi", "desktop-control-ffi"],
        summary: "Embedding the desktop control core in another process via the C ABI (the library is not shipped with Sprint Coder). Build/link, error propagation, handle ownership, threading rules.",
        platform: None,
        main: SKILL_FFI_MAIN,
        refs: SKILL_FFI_REFS,
    },
];

pub struct GetArgs {
    pub name: String,
    pub full: bool,
    pub reference: Option<String>,
}

pub fn list() -> Result<Value, AppError> {
    let entries: Vec<Value> = SKILLS
        .iter()
        .map(|s| {
            let mut entry = json!({
                "name": s.canonical,
                "aliases": s.aliases,
                "summary": s.summary,
                "references": s.refs.iter().map(|r| r.rel_path).collect::<Vec<_>>(),
            });
            if let Some(platform) = s.platform {
                entry["platform"] = json!(platform);
                entry["current"] = json!(CURRENT_PLATFORM == Some(platform));
            }
            entry
        })
        .collect();
    Ok(json!({ "skills": entries }))
}

pub fn get(args: GetArgs) -> Result<Value, AppError> {
    let skill = find_skill(&args.name)?;

    if let Some(rel) = args.reference {
        let refs = skill.refs;
        let r = refs
            .iter()
            .find(|r| matches_ref(r.rel_path, &rel))
            .ok_or_else(|| {
                let available: Vec<&str> = refs.iter().map(|r| r.rel_path).collect();
                AppError::invalid_input(format!(
                    "Unknown reference '{rel}' for skill '{}'. Available: {}",
                    skill.canonical,
                    available.join(", ")
                ))
            })?;
        return Ok(json!({
            "skill": skill.canonical,
            "reference": r.rel_path,
            "content": r.body,
        }));
    }

    let content = if args.full {
        render_full(skill)
    } else {
        skill.main.to_string()
    };

    Ok(json!({
        "skill": skill.canonical,
        "full": args.full,
        "content": content,
    }))
}

pub fn path() -> Result<Value, AppError> {
    Ok(json!({
        "location": "embedded",
        "note": "Skills are compiled into this binary and are always version-matched. Run `sprint-coder-desktop-control skills get <name>` to print a skill, or redirect into a file to extract a copy.",
        "available": SKILLS.iter().map(|s| s.canonical).collect::<Vec<_>>(),
    }))
}

fn find_skill(name: &str) -> Result<&'static Skill, AppError> {
    let needle = name.trim();
    if needle.eq_ignore_ascii_case(PLATFORM_ALIAS) {
        return platform_skill();
    }
    SKILLS
        .iter()
        .find(|s| s.aliases.iter().any(|a| a.eq_ignore_ascii_case(needle)))
        .ok_or_else(|| {
            let known: Vec<&str> = SKILLS
                .iter()
                .flat_map(|s| s.aliases.iter().copied())
                .collect();
            AppError::invalid_input(format!(
                "Unknown skill '{name}'. Known: {}",
                known.join(", ")
            ))
        })
}

fn platform_skill() -> Result<&'static Skill, AppError> {
    SKILLS
        .iter()
        .find(|s| s.platform.is_some() && s.platform == CURRENT_PLATFORM)
        .ok_or_else(|| {
            AppError::invalid_input_with_suggestion(
                "This build's operating system has no platform skill yet",
                "Use `sprint-coder-desktop-control skills get desktop`; it covers the loop on every OS",
            )
        })
}

fn matches_ref(rel_path: &str, query: &str) -> bool {
    if rel_path.eq_ignore_ascii_case(query) {
        return true;
    }
    let file = rel_path.rsplit('/').next().unwrap_or(rel_path);
    let stem = file.strip_suffix(".md").unwrap_or(file);
    file.eq_ignore_ascii_case(query) || stem.eq_ignore_ascii_case(query)
}

fn render_full(skill: &Skill) -> String {
    let refs = skill.refs;
    let mut out = String::with_capacity(
        skill.main.len() + refs.iter().map(|r| r.body.len() + 64).sum::<usize>(),
    );
    out.push_str(skill.main);
    for r in refs {
        if !out.ends_with('\n') {
            out.push('\n');
        }
        out.push_str("\n--- ");
        out.push_str(r.rel_path);
        out.push_str(" ---\n\n");
        out.push_str(r.body);
    }
    out
}

#[cfg(test)]
#[path = "skills_tests.rs"]
mod tests;
