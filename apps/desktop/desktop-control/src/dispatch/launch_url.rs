// Changed by Sprint Coder (new file); see VENDORED.md in apps/desktop/desktop-control.
//! `launch <browser> --url <URL>`: a known browser started with a fixed switch that opens one
//! http or https page in a new window, and nothing else on its command line.
//!
//! Sprint Coder's Main reads the URL first, refuses what it may not open and seals the canonical
//! form (WHATWG `URL.href`, so a Japanese host is already punycode and a Japanese path already
//! percent-encoded) into the argv its approval card shows. This side takes only that canonical
//! form, checked by its shape alone, so every value it accepts is plain printable ASCII that no
//! browser reads as a switch and the command line passes as one argument. The cases both sides
//! are tested against live in `launch_url_cases.json`.
//!
//! On macOS the browser is named as `launch` names any app there (the bundle's file name without
//! `.app`, or its bundle id), and the switch and URL reach it as the launch's arguments
//! (`NSWorkspaceOpenConfiguration.arguments`) of a new instance.

use agent_desktop_core::AppError;

/// The longest URL taken, in characters (the canonical form is ASCII, so bytes too).
pub(crate) const MAX_URL_CHARS: usize = 2048;
/// The longest host (without a trailing dot) and host label taken, as DNS bounds them, so the
/// approval card can always show the whole host.
const MAX_HOST_CHARS: usize = 253;
const MAX_LABEL_CHARS: usize = 63;

/// The browsers `--url` is for, by executable name without `.exe`, in lower case.
const CHROMIUM_BROWSERS: &[&str] = &[
    "chrome", "msedge", "brave", "vivaldi", "opera", "chromium", "thorium",
];
const FIREFOX_BROWSERS: &[&str] = &["firefox", "librewolf", "waterfox"];

/// The browsers `--url` is for on macOS: the bundle's file name without `.app` and its bundle id
/// (`CFBundleIdentifier`), as `launch` takes an app there. A browser whose id is not known is left
/// out. Main judges the bundles the name may resolve to by their ids against the same table
/// (`launch_url_mac_apps.json`), and the macOS adapter judges the one it opens by its id
/// (`launch_url_bundle_ids`), so an id listed wrongly refuses that browser rather than passing
/// another app.
const MAC_URL_BROWSER_TABLE: &[(&str, &str, BrowserFamily)] = &[
    (
        "Google Chrome",
        "com.google.Chrome",
        BrowserFamily::Chromium,
    ),
    (
        "Microsoft Edge",
        "com.microsoft.edgemac",
        BrowserFamily::Chromium,
    ),
    (
        "Brave Browser",
        "com.brave.Browser",
        BrowserFamily::Chromium,
    ),
    ("Vivaldi", "com.vivaldi.Vivaldi", BrowserFamily::Chromium),
    ("Opera", "com.operasoftware.Opera", BrowserFamily::Chromium),
    ("Chromium", "org.chromium.Chromium", BrowserFamily::Chromium),
    ("Firefox", "org.mozilla.firefox", BrowserFamily::Firefox),
];

/// How a browser is told to open a page in a new window of its own.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum BrowserFamily {
    /// `--new-window <URL>` (Chromium's `switches::kNewWindow`).
    Chromium,
    /// `-new-window <URL>` (Firefox's command-line options).
    Firefox,
}

impl BrowserFamily {
    fn switch(self) -> &'static str {
        match self {
            Self::Chromium => "--new-window",
            Self::Firefox => "-new-window",
        }
    }
}

/// The browser an app id (a bare name or an absolute path) names, by its file name alone.
pub(crate) fn browser_family(app: &str) -> Option<BrowserFamily> {
    let file = app.rsplit(['\\', '/']).next().unwrap_or(app);
    let lower = file.to_ascii_lowercase();
    let stem = lower.strip_suffix(".exe").unwrap_or(&lower);
    if CHROMIUM_BROWSERS.contains(&stem) {
        Some(BrowserFamily::Chromium)
    } else if FIREFOX_BROWSERS.contains(&stem) {
        Some(BrowserFamily::Firefox)
    } else {
        None
    }
}

/// The browser a macOS app id names: a bundle's file name (with or without a lower-case `.app`,
/// the only suffix the macOS adapter reads as a file name) or a bundle id of
/// `MAC_URL_BROWSER_TABLE`, ASCII letters in any case otherwise, nothing trimmed.
pub(crate) fn mac_browser_family(app: &str) -> Option<BrowserFamily> {
    let lower = app.to_ascii_lowercase();
    let name = app.strip_suffix(".app").unwrap_or(app).to_ascii_lowercase();
    MAC_URL_BROWSER_TABLE
        .iter()
        .find(|(file, id, _)| name == file.to_ascii_lowercase() || lower == id.to_ascii_lowercase())
        .map(|(_, _, family)| *family)
}

/// On macOS, the bundle ids the bundle a `--url` launch of `app` opens may have: those of the
/// browsers of the same kind (`mac_browser_family`), whose switch it is given. The macOS adapter
/// reads the id of the bundle it resolved right before opening it and refuses any other, so the
/// app that starts is judged by its id there too, not only by the name it was given. Empty on
/// other OSes, where nothing reads it.
pub(crate) fn launch_url_bundle_ids(app: &str) -> Vec<String> {
    if !cfg!(target_os = "macos") {
        return Vec::new();
    }
    mac_family_bundle_ids(app)
}

pub(crate) fn mac_family_bundle_ids(app: &str) -> Vec<String> {
    let Some(family) = mac_browser_family(app) else {
        return Vec::new();
    };
    MAC_URL_BROWSER_TABLE
        .iter()
        .filter(|(_, _, of)| *of == family)
        .map(|(_, id, _)| (*id).to_owned())
        .collect()
}

/// The whole command line a `--url` launch passes after the executable: the browser's fixed
/// switch, then the URL as one argument. Refused unless `app` is a known browser of this OS
/// (`browser_family`, or `mac_browser_family` on macOS) and `url` is in the canonical shape
/// (`url_shape_refusal`).
pub(crate) fn launch_url_args(app: &str, url: &str) -> Result<Vec<String>, AppError> {
    launch_url_args_on(cfg!(target_os = "macos"), app, url)
}

/// `launch_url_args` as on macOS (`macos`) or on Windows, whichever OS this runs on.
pub(crate) fn launch_url_args_on(
    macos: bool,
    app: &str,
    url: &str,
) -> Result<Vec<String>, AppError> {
    let family = if macos {
        mac_browser_family(app)
    } else {
        browser_family(app)
    };
    let family = family.ok_or_else(|| {
        let known: Vec<&str> = if macos {
            MAC_URL_BROWSER_TABLE
                .iter()
                .flat_map(|(file, id, _)| [*file, *id])
                .collect()
        } else {
            CHROMIUM_BROWSERS
                .iter()
                .chain(FIREFOX_BROWSERS)
                .copied()
                .collect()
        };
        AppError::invalid_input(format!(
            "--url is only for a known browser ({}); nothing was launched",
            known.join(", ")
        ))
    })?;
    if let Some(reason) = url_shape_refusal(url) {
        return Err(AppError::invalid_input(format!(
            "--url refused: {reason}; nothing was launched"
        )));
    }
    Ok(vec![family.switch().to_owned(), url.to_owned()])
}

/// Why `url` is not an http or https URL in the canonical shape this takes, or `None`.
///
/// Only `http://` or `https://` in lower case, then a host of lower-case letters, digits, `.`,
/// `-` and `_` (at most 253 characters besides a trailing dot, each label 1 to 63; a host ending
/// in a number must be a dotted-decimal IPv4 address; no IPv6), an
/// optional port that is not the scheme's default, and a path that starts with `/`. No user name
/// or password, nothing outside printable ASCII, no quote, backtick, backslash or angle bracket,
/// every `%` followed by two hex digits, and no `.` or `..` path segment.
pub(crate) fn url_shape_refusal(url: &str) -> Option<&'static str> {
    if url.is_empty() || url.len() > MAX_URL_CHARS {
        return Some("the URL must be 1 to 2048 characters");
    }
    if url
        .bytes()
        .any(|byte| !(0x21..=0x7e).contains(&byte) || b"\"'`\\<>".contains(&byte))
    {
        return Some(
            "the URL has a space, a control or non-ASCII character, a quote, a backtick, a backslash or an angle bracket",
        );
    }
    let (rest, default_port) = if let Some(rest) = url.strip_prefix("https://") {
        (rest, "443")
    } else if let Some(rest) = url.strip_prefix("http://") {
        (rest, "80")
    } else {
        return Some("only http:// and https:// URLs open");
    };
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let (authority, tail) = rest.split_at(end);
    if !tail.starts_with('/') {
        return Some("the URL has no path");
    }
    if authority.contains('@') {
        return Some("the URL names a user or password");
    }
    let (host, port) = match authority.rsplit_once(':') {
        Some((host, port)) => (host, Some(port)),
        None => (authority, None),
    };
    if let Some(reason) = host_refusal(host) {
        return Some(reason);
    }
    if let Some(port) = port {
        let digits =
            !port.is_empty() && port.len() <= 5 && port.bytes().all(|b| b.is_ascii_digit());
        if !digits
            || (port.len() > 1 && port.starts_with('0'))
            || port.parse::<u32>().map_or(true, |value| value > 65_535)
            || port == default_port
        {
            return Some("the port is not a canonical port number");
        }
    }
    tail_refusal(tail)
}

fn host_refusal(host: &str) -> Option<&'static str> {
    if host.is_empty() {
        return Some("the URL has no host");
    }
    if !host
        .bytes()
        .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || b".-_".contains(&byte))
    {
        return Some("the host is not a lower-case name or a dotted-decimal IPv4 address");
    }
    // A trailing dot is kept in the canonical form (`example.com.`) and is not counted.
    let name = host.strip_suffix('.').unwrap_or(host);
    if name.len() > MAX_HOST_CHARS {
        return Some("the host is longer than 253 characters");
    }
    let labels: Vec<&str> = name.split('.').collect();
    if labels.iter().any(|label| label.is_empty()) {
        return Some("the host has an empty label");
    }
    if labels.iter().any(|label| label.len() > MAX_LABEL_CHARS) {
        return Some("a label of the host is longer than 63 characters");
    }
    let last = labels[labels.len() - 1];
    // As the URL standard reads a host that ends in a number: an IPv4 address.
    let numeric = last.bytes().all(|byte| byte.is_ascii_digit()) || last.starts_with("0x");
    if numeric && !canonical_ipv4(host) {
        return Some("the host is not a lower-case name or a dotted-decimal IPv4 address");
    }
    None
}

fn canonical_ipv4(host: &str) -> bool {
    let parts: Vec<&str> = host.split('.').collect();
    parts.len() == 4
        && parts.iter().all(|part| {
            !part.is_empty()
                && part.len() <= 3
                && part.bytes().all(|byte| byte.is_ascii_digit())
                && !(part.len() > 1 && part.starts_with('0'))
                && part.parse::<u16>().is_ok_and(|value| value <= 255)
        })
}

fn tail_refusal(tail: &str) -> Option<&'static str> {
    let bytes = tail.as_bytes();
    for (index, byte) in bytes.iter().enumerate() {
        if *byte == b'%'
            && !(bytes.get(index + 1).is_some_and(u8::is_ascii_hexdigit)
                && bytes.get(index + 2).is_some_and(u8::is_ascii_hexdigit))
        {
            return Some("a % in the URL is not followed by two hex digits");
        }
    }
    let path_end = tail.find(['?', '#']).unwrap_or(tail.len());
    let dot_segment = tail[..path_end].split('/').any(|segment| {
        let lower = segment.to_ascii_lowercase().replace("%2e", ".");
        lower == "." || lower == ".."
    });
    if dot_segment {
        return Some("the path has a . or .. segment");
    }
    None
}

#[cfg(test)]
#[path = "launch_url_tests.rs"]
mod tests;
