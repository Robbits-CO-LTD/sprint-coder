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

    // The count gets room here: every navigation is bounded by what is left
    // of its share, and a freshly started fixture under a parallel test run
    // can take most of the default share for its first answer, which leaves
    // the count unproven and the walk per node (the case tested below).
    let (prefetched_tree, prefetched) =
        walk_with(&root, 1_000, Duration::from_millis(2_000), calling);
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

    assert_eq!(count_within(&client, &walker, &root, 1, deadline()), None);
    let counted =
        count_within(&client, &walker, &root, 10_000, deadline()).expect("a small tree counts");
    assert!(counted > 1, "the fixture root has children");
    assert_eq!(
        count_within(&client, &walker, &root, counted, deadline()),
        Some(counted)
    );
    assert_eq!(
        count_within(&client, &walker, &root, counted - 1, deadline()),
        None
    );
}

#[test]
fn a_count_whose_last_answer_came_after_the_deadline_is_no_count() {
    use super::{CountStep, count_nodes};
    let short = deadline().capped(Duration::from_millis(30));
    // A root with no children, whose one slow "no child" answer comes after
    // the deadline: the count must not report success.
    let counted = count_nodes(
        0u8,
        10,
        short,
        |_| {
            std::thread::sleep(Duration::from_millis(60));
            CountStep::End
        },
        |_| CountStep::End,
    );
    assert_eq!(counted, None);
    let counted = count_nodes(0u8, 10, deadline(), |_| CountStep::End, |_| CountStep::End);
    assert_eq!(counted, Some(1), "the same answer in time is a count");
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

#[test]
fn a_lowered_call_bound_is_put_back_as_it_was_even_when_nested_or_panicking() {
    use super::with_transaction_timeout;
    use windows::Win32::UI::Accessibility::{IUIAutomation, IUIAutomation2};
    use windows::core::Interface;
    crate::tree::fixture::ensure_test_apartment();
    let client = automation_client().expect("a UIA client");
    let bound = || -> u32 {
        let raw: IUIAutomation2 = AsRef::<IUIAutomation>::as_ref(&client)
            .cast()
            .expect("IUIAutomation2");
        // SAFETY: this thread's live client.
        unsafe { raw.TransactionTimeout() }.expect("the bound reads")
    };
    let before = bound();
    let outer = deadline().capped(Duration::from_millis(4_000));
    let (inside_outer, inside_inner, after_inner) =
        with_transaction_timeout(&client, outer, || {
            let inside_outer = bound();
            let inner =
                with_transaction_timeout(&client, deadline(), bound).expect("the inner call");
            (inside_outer, inner, bound())
        })
        .expect("the outer call");
    assert!(inside_outer <= 4_000, "the outer call lowered the bound");
    assert!(
        inside_inner <= inside_outer,
        "a nested call with more time left never raises the outer bound"
    );
    assert_eq!(
        after_inner, inside_outer,
        "the nested call put the outer bound back"
    );
    assert_eq!(
        bound(),
        before,
        "the outer call put the client's own bound back"
    );

    let panicked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        with_transaction_timeout(&client, outer, || panic!("the call failed"))
    }));
    assert!(panicked.is_err());
    assert_eq!(
        bound(),
        before,
        "a panicking call leaves no lowered bound behind"
    );
}
