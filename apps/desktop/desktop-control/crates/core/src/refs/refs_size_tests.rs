// Changed by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
use super::tests::entry;
use super::*;

/// The size check a capture makes before saving agrees with the write's own
/// refusal on both sides of the limit.
#[test]
fn test_exceeds_size_limit_matches_the_write_refusal() {
    let mut map = RefMap::new();
    let big_name = "x".repeat(2048);
    let (mut kept, mut refused_seen) = (false, false);
    for _ in 0..600 {
        map.allocate(entry("button", Some(&big_name)));
        if map.len() % 20 != 0 {
            continue;
        }
        let refused = map.serialize_with_size_check().is_err();
        assert_eq!(map.exceeds_size_limit(), refused, "at {} refs", map.len());
        kept |= !refused;
        refused_seen |= refused;
    }
    assert!(kept && refused_seen, "the map was checked on both sides");
}

#[test]
fn test_serialize_with_size_check_rejects_oversized() {
    let mut map = RefMap::new();
    let big_name = "x".repeat(2048);
    for _ in 0..600 {
        map.allocate(entry("button", Some(&big_name)));
    }

    let err = map.serialize_with_size_check().unwrap_err();
    assert_eq!(err.code(), "INTERNAL");
    assert!(err.to_string().contains("1MB"), "got: {err}");
    let suggestion = err.suggestion().unwrap_or_default();
    assert!(suggestion.contains("--skeleton") && suggestion.contains("find"));

    let payload = crate::response::output::ErrorPayload::from_app_error(&err);
    assert_eq!(payload.code, "INTERNAL");
    assert!(payload.recovery.is_none());
    assert_eq!(payload.disposition, crate::DeliverySemantics::unknown());
}

#[test]
fn test_serialize_with_size_check_accepts_normal() {
    let mut map = RefMap::new();
    for _ in 0..50 {
        map.allocate(entry("button", Some("OK")));
    }

    let result = map.serialize_with_size_check();
    let value: serde_json::Value = serde_json::from_str(&result.unwrap()).unwrap();
    assert_eq!(value["inner"]["@e1"]["role"], "button");
    assert_eq!(value["inner"]["@e1"]["name"], "OK");
}
