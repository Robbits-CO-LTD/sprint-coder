// Changed by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
//! The window-wide prover must give, for every entry, exactly the answer the
//! entry-by-entry rule gives; only its cost differs.

use super::{AncestryProver, distinguishing_ancestors, parents};
use crate::locator::live_locator::{LocatorField, ObservationRoot, ObservedTree};
use crate::{AccessibilityNode, ElementIdentifier, IdentifierKind, RefEntry};

fn node(role: &str, name: &str) -> AccessibilityNode {
    crate::adapter::minimal_accessibility_node(role, name)
}

fn window() -> crate::WindowInfo {
    crate::WindowInfo {
        id: "w-1".into(),
        title: "Fixture".into(),
        app: "Fixture".into(),
        pid: crate::ProcessId::new(1),
        process_instance: Some("test-instance".into()),
        bounds: None,
        state: crate::WindowState::default(),
    }
}

fn observe(root: AccessibilityNode) -> ObservedTree {
    crate::adapter::observed_tree(&ObservationRoot::Window(&window()), root)
        .expect("the fixture observes")
}

/// The entry a capture would publish for a node, from its own evidence.
fn entry_for(observed: &ObservedTree, index: usize) -> RefEntry {
    let evidence = &observed.nodes[index].evidence;
    let mut entry = crate::adapter::minimal_ref_entry(
        evidence
            .role
            .known()
            .map(String::as_str)
            .unwrap_or("unknown"),
        evidence.name.known().map(String::as_str),
    );
    entry.identity.value = evidence.value.known().cloned();
    entry.identity.description = evidence.description.known().cloned();
    entry.identity.native_id = evidence.identifiers.preferred_identifier().cloned();
    entry.identity.unique_at_capture = false;
    entry
}

/// Every node's answer from both, side by side; returns how many nodes the
/// ancestors proved.
fn assert_agree(observed: &ObservedTree) -> usize {
    let parents = parents(observed);
    let mut prover = AncestryProver::new(observed);
    let mut proven = 0;
    for index in 0..observed.nodes.len() {
        let entry = entry_for(observed, index);
        let expected = distinguishing_ancestors(observed, &parents, &entry, index);
        let actual = prover.prove(&entry, index);
        assert_eq!(actual, expected, "node {index} answers differently");
        proven += usize::from(actual.is_some());
    }
    proven
}

/// A small deterministic generator, so a failure names a reproducible seed.
struct Lcg(u64);

impl Lcg {
    fn next(&mut self) -> u64 {
        self.0 = self
            .0
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        self.0 >> 33
    }

    fn pick<'a>(&mut self, from: &[&'a str]) -> &'a str {
        from[(self.next() as usize) % from.len()]
    }
}

fn random_tree(random: &mut Lcg, depth: u32) -> AccessibilityNode {
    let mut parent = node(
        random.pick(&["group", "button", "list", "window"]),
        random.pick(&["", "", "A", "B", "Run"]),
    );
    if random.next() % 5 == 0 {
        parent.identity.native_id = Some(ElementIdentifier {
            kind: IdentifierKind::AutomationId,
            value: random.pick(&["x", "y"]).into(),
        });
    }
    if random.next() % 7 == 0 {
        parent.identity.description = Some(random.pick(&["d", "e"]).into());
    }
    if depth > 0 {
        let children = random.next() % 4;
        for _ in 0..children {
            parent.children.push(random_tree(random, depth - 1));
        }
    }
    parent
}

/// Clouds a few fields, so the unknown branches are compared too.
fn cloud(random: &mut Lcg, observed: &mut ObservedTree) {
    for node in &mut observed.nodes {
        match random.next() % 40 {
            0 => node.evidence.name = LocatorField::Unknown,
            1 => node.evidence.role = LocatorField::Unknown,
            2 => node.evidence.identifiers = crate::IdentifierEvidence::unknown(),
            _ => {}
        }
    }
}

#[test]
fn the_prover_agrees_with_the_rule_on_random_windows() {
    let mut proven = 0;
    for seed in 0..300 {
        let mut random = Lcg(seed);
        let mut root = node("window", "Fixture");
        for _ in 0..(2 + random.next() % 4) {
            root.children.push(random_tree(&mut random, 5));
        }
        let mut observed = observe(root);
        if seed % 2 == 1 {
            cloud(&mut random, &mut observed);
        }
        proven += assert_agree(&observed);
    }
    assert!(
        proven > 50,
        "the random windows exercise ancestor proofs: {proven}"
    );
}

fn rows(count: usize, depth: usize, named: bool) -> AccessibilityNode {
    let mut list = node("list", "Mail");
    for row in 0..count {
        let name = if named {
            format!("Row {row}")
        } else {
            String::new()
        };
        let mut item = node("group", &name);
        item.children.push(node("button", "Delete"));
        list.children.push(item);
    }
    let mut top = list;
    for _ in 0..depth.saturating_sub(2) {
        let mut wrapper = node("group", "");
        wrapper.children.push(top);
        top = wrapper;
    }
    let mut root = node("window", "Fixture");
    root.children.push(top);
    root
}

#[test]
fn the_prover_agrees_with_the_rule_on_rows_of_the_same_button() {
    for named in [false, true] {
        assert_agree(&observe(rows(40, 8, named)));
    }
    let mut mixed = rows(20, 6, true);
    mixed.children.push(rows(20, 6, false).children.remove(0));
    assert_agree(&observe(mixed));
}

#[test]
fn identical_rows_stay_unproven_and_named_rows_are_proven_by_their_row() {
    for (named, proven) in [(false, false), (true, true)] {
        let observed = observe(rows(200, 30, named));
        let mut prover = AncestryProver::new(&observed);
        for index in 0..observed.nodes.len() {
            if observed.nodes[index]
                .evidence
                .name
                .known()
                .map(String::as_str)
                != Some("Delete")
            {
                continue;
            }
            let answer = prover.prove(&entry_for(&observed, index), index);
            assert_eq!(answer.is_some(), proven, "named rows: {named}");
            if let Some(ancestors) = answer {
                assert_eq!(ancestors.len(), 1);
            }
        }
    }
}

#[test]
fn a_spent_limit_leaves_entries_unproven_and_never_proves_one() {
    let observed = observe(rows(200, 10, true));
    let mut prover = AncestryProver::with_limit(&observed, 50);
    for index in 0..observed.nodes.len() {
        if observed.nodes[index]
            .evidence
            .name
            .known()
            .map(String::as_str)
            == Some("Delete")
        {
            assert_eq!(prover.prove(&entry_for(&observed, index), index), None);
        }
    }
}

/// The cost of proving every Delete button of a window, for the record:
/// `cargo test ancestry_cost -- --ignored --nocapture`.
#[test]
#[ignore = "a measurement, not a gate"]
fn ancestry_cost() {
    for (count, named) in [(1_000, false), (5_000, false), (1_000, true), (5_000, true)] {
        let observed = observe(rows(count, 30, named));
        let deletes: Vec<usize> = (0..observed.nodes.len())
            .filter(|index| {
                observed.nodes[*index]
                    .evidence
                    .name
                    .known()
                    .map(String::as_str)
                    == Some("Delete")
            })
            .collect();
        let started = std::time::Instant::now();
        let mut prover = AncestryProver::new(&observed);
        let proven = deletes
            .iter()
            .filter(|index| {
                prover
                    .prove(&entry_for(&observed, **index), **index)
                    .is_some()
            })
            .count();
        let new_ms = started.elapsed().as_secs_f64() * 1000.0;
        // The entry-by-entry rule, on a sample of entries, scaled to all.
        let sample = deletes.len().min(20);
        let parents = parents(&observed);
        let started = std::time::Instant::now();
        for index in deletes.iter().take(sample) {
            let _ = distinguishing_ancestors(
                &observed,
                &parents,
                &entry_for(&observed, *index),
                *index,
            );
        }
        let old_ms =
            started.elapsed().as_secs_f64() * 1000.0 / sample as f64 * deletes.len() as f64;
        println!(
            "rows={count} named={named} depth=30 proven={proven}/{} new={new_ms:.1}ms rule(est)={old_ms:.0}ms",
            deletes.len()
        );
    }
}
