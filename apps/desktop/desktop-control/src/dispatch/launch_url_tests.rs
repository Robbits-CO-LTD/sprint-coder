// Changed by Sprint Coder (new file); see VENDORED.md in apps/desktop/desktop-control.
use super::*;

/// The table Main's `desktopControlLaunchUrl` is tested against too
/// (`apps/desktop/src/main/desktop-control-launch-url.test.ts`).
const CASES: &str = include_str!("launch_url_cases.json");

#[derive(serde::Deserialize)]
struct Case {
    url: String,
    canonical: Option<String>,
}

fn cases() -> Vec<Case> {
    serde_json::from_str(CASES).expect("the shared table reads")
}

#[test]
fn every_canonical_url_main_seals_is_taken_unchanged() {
    for case in &cases() {
        let Some(canonical) = &case.canonical else {
            continue;
        };
        assert_eq!(
            url_shape_refusal(canonical),
            None,
            "{canonical:?} (from {:?})",
            case.url
        );
        assert_eq!(
            launch_url_args("C:\\Fake\\chrome.exe", canonical).unwrap(),
            vec!["--new-window".to_owned(), canonical.clone()]
        );
    }
}

#[test]
fn every_url_main_refuses_is_refused_here_as_given() {
    for case in cases().iter().filter(|case| case.canonical.is_none()) {
        assert!(
            url_shape_refusal(&case.url).is_some(),
            "{:?} must be refused",
            case.url
        );
        assert_eq!(
            launch_url_args("chrome", &case.url).unwrap_err().code(),
            "INVALID_ARGS"
        );
    }
}

#[test]
fn a_url_main_would_rewrite_is_not_taken_in_its_raw_form() {
    for raw in [
        "HTTPS://Example.COM/Path",
        "https://example.com",
        "https://example.com:443/",
        "https://日本語.jp/",
        "https://example.com/検索",
        "http://0x7f.1/",
        "http://0177.0.0.1/",
        "http://127.1/",
        "https://example.com/a/../b",
        "https://example.com/a/%2E%2e/b",
        "https://example.com/./b",
    ] {
        assert!(url_shape_refusal(raw).is_some(), "{raw:?}");
    }
}

#[test]
fn the_length_is_bounded() {
    let head = "https://example.com/";
    let longest = format!("{head}{}", "a".repeat(MAX_URL_CHARS - head.len()));
    assert_eq!(url_shape_refusal(&longest), None);
    assert!(url_shape_refusal(&format!("{longest}a")).is_some());
}

#[test]
fn ports_are_taken_only_in_their_canonical_form() {
    assert_eq!(url_shape_refusal("http://localhost:65535/"), None);
    assert_eq!(url_shape_refusal("https://example.com:80/"), None);
    for url in [
        "http://localhost:65536/",
        "http://localhost:08080/",
        "http://localhost:/",
        "http://localhost:a/",
        "http://example.com:80/",
        "https://example.com:443/",
    ] {
        assert!(url_shape_refusal(url).is_some(), "{url:?}");
    }
}

#[test]
fn only_known_browsers_take_a_url_by_their_file_name() {
    for app in [
        "chrome",
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "C:/x/MSEDGE.EXE",
        "brave.exe",
        "vivaldi",
        "opera.exe",
        "chromium",
        "thorium.exe",
    ] {
        assert_eq!(browser_family(app), Some(BrowserFamily::Chromium), "{app}");
    }
    for app in [
        "firefox",
        "C:\\Mozilla Firefox\\firefox.exe",
        "librewolf.exe",
        "waterfox",
    ] {
        assert_eq!(browser_family(app), Some(BrowserFamily::Firefox), "{app}");
    }
    for app in [
        "notepad",
        "C:\\x\\chrome.bat",
        "chrome.exe.lnk",
        "chrome.com",
        "msedgewebview2.exe",
        "iexplore.exe",
        "C:\\chrome\\evil.exe",
        "Google Chrome",
        "",
    ] {
        assert_eq!(browser_family(app), None, "{app}");
        assert_eq!(
            launch_url_args(app, "https://example.com/")
                .unwrap_err()
                .code(),
            "INVALID_ARGS"
        );
    }
}

/// The app names Main's `desktopControlUrlBrowser` is tested against too: read the same way,
/// nothing trimmed (Start menu names, which only Main takes, are not in it).
#[test]
fn every_app_of_the_shared_table_is_judged_as_main_judges_it() {
    #[derive(serde::Deserialize)]
    struct App {
        app: String,
        browser: bool,
    }
    let apps: Vec<App> =
        serde_json::from_str(include_str!("launch_url_apps.json")).expect("the table reads");
    assert!(apps.len() > 15);
    for App { app, browser } in &apps {
        assert_eq!(browser_family(app).is_some(), *browser, "{app:?}");
    }
}

#[test]
fn the_host_and_its_labels_are_bounded_as_dns_bounds_them() {
    let label = |n: usize| "a".repeat(n);
    let longest = [label(63), label(63), label(63), label(61)].join(".");
    assert_eq!(longest.len(), MAX_HOST_CHARS);
    assert_eq!(url_shape_refusal(&format!("https://{longest}/")), None);
    assert_eq!(url_shape_refusal(&format!("https://{longest}./")), None);
    assert!(url_shape_refusal(&format!("https://{longest}a/")).is_some());
    assert!(url_shape_refusal(&format!("https://{}.com/", label(64))).is_some());
    assert!(url_shape_refusal("https://example..com/").is_some());
}

#[test]
fn firefox_gets_its_own_new_window_switch() {
    assert_eq!(
        launch_url_args("C:\\Fake\\firefox.exe", "https://example.com/").unwrap(),
        vec!["-new-window".to_owned(), "https://example.com/".to_owned()]
    );
}
