// Changed by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
//! The whole-tree prefetch is an optimisation only: whichever way it is left
//! out - the tree counted over the limit, or no time for the call - the walk
//! falls back to reading node by node, still reads the root, and returns the
//! same tree the prefetched walk returns.

use std::time::Duration;

use agent_desktop_core::ObservationRoot;

use super::{UiaTreeSource, count_within, prefetch_shares};
use crate::tree::automation::{automation_client, root_from_hwnd};
use crate::tree::element::UIAElement;
use crate::tree::fixture::HostedFixture;
use crate::tree::walk::walker::walk_from_root;
use crate::tree::walk::walker_fake::{budget, deadline, window};

/// Walks the fixture's whole window through the prefetch path with the given
/// limit and time shares; reports the projected tree and whether the
/// prefetch was used.
fn walk_with(
    root: &UIAElement,
    limit: usize,
    counting: Duration,
    calling: Duration,
) -> (String, bool) {
    let window = window();
    let source = UiaTreeSource::for_whole_root(root, false)
        .and_then(UiaTreeSource::with_subtree_request)
        .expect("a whole-window source");
    let prepared = source
        .prepare_whole_root_with(root, deadline(), limit, counting, calling)
        .expect("the root is read with or without the prefetch");
    let outcome = walk_from_root(
        &source,
        &prepared,
        &ObservationRoot::Window(&window),
        budget(50),
    )
    .expect("the walk reads the root and assembles an observation");
    assert!(
        outcome.failures.is_empty(),
        "the walk raised an enumeration failure"
    );
    assert!(
        outcome.tree.is_complete(),
        "the walk reported an incomplete tree"
    );
    let tree = outcome
        .tree
        .into_accessibility_tree()
        .expect("core accepts a complete observation");
    (format!("{tree:?}"), source.prefetched())
}

fn fixture_root(fixture: &HostedFixture) -> UIAElement {
    root_from_hwnd(fixture.handle(), deadline()).expect("the fixture window resolves")
}

#[test]
fn a_prefetch_left_out_by_the_limit_or_by_time_walks_per_node_to_the_same_tree() {
    crate::tree::fixture::ensure_test_apartment();
    let fixture = HostedFixture::spawn().expect("the fixture host starts");
    let root = fixture_root(&fixture);
    let (counting, calling) = prefetch_shares(deadline().remaining());

    let (prefetched_tree, prefetched) = walk_with(&root, 1_000, counting, calling);
    assert!(prefetched, "the small fixture tree is prefetched");

    let (over_limit, used) = walk_with(&root, 1, counting, calling);
    assert!(!used, "a tree counted over the limit is not prefetched");
    assert_eq!(over_limit, prefetched_tree);

    let (no_time, used) = walk_with(&root, 1_000, counting, Duration::ZERO);
    assert!(!used, "a prefetch call with no time left is not made");
    assert_eq!(no_time, prefetched_tree);

    let (no_count_time, used) = walk_with(&root, 1_000, Duration::ZERO, calling);
    assert!(
        !used,
        "a count that ran out of time does not license the prefetch"
    );
    assert_eq!(no_count_time, prefetched_tree);
}

#[test]
fn the_count_stops_at_its_limit() {
    crate::tree::fixture::ensure_test_apartment();
    let fixture = HostedFixture::spawn().expect("the fixture host starts");
    let root = fixture_root(&fixture);
    let client = automation_client().expect("a UIA client");
    let walker = client.get_raw_view_walker().expect("the raw view walker");

    assert_eq!(count_within(&walker, &root, 1, deadline()), None);
    let counted = count_within(&walker, &root, 10_000, deadline()).expect("a small tree counts");
    assert!(counted > 1, "the fixture root has children");
    assert_eq!(
        count_within(&walker, &root, counted, deadline()),
        Some(counted)
    );
    assert_eq!(count_within(&walker, &root, counted - 1, deadline()), None);
}

#[test]
fn the_prefetch_never_takes_more_than_half_of_the_deadline() {
    for remaining_ms in [0, 1, 40, 400, 2_000, 3_750, 4_000, 30_000] {
        let remaining = Duration::from_millis(remaining_ms);
        let (counting, calling) = prefetch_shares(remaining);
        assert!(counting + calling <= remaining / 2, "{remaining_ms} ms");
        assert!(counting <= Duration::from_millis(500));
        assert!(calling <= Duration::from_millis(1_000));
    }
}
