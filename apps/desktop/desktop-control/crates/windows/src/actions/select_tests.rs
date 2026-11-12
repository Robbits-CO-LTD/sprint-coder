// Changed by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
use super::{
    SELECT_LABEL, SelectOps, SelectPlan, push_order, resolve_select_verification, select_judged_for,
};
use crate::actions::chain::DeliveryOutcome;
use crate::system::fixture::test_time::deadline;
use agent_desktop_core::{ActionStepOutcome, AdapterError, ErrorCode};
use std::cell::Cell;

fn plan(self_match: bool, needs_expand: bool, value_chars: usize) -> SelectPlan {
    SelectPlan {
        self_match,
        needs_expand,
        value_chars,
    }
}

#[test]
fn self_match_selects_and_verifies_is_selected() {
    let select = Cell::new(0u8);
    let mut expand = || Ok(());
    let mut collapse = || {};
    let mut find = || Ok(false);
    let mut realize = || Ok(());
    let mut select_item = || {
        select.set(select.get() + 1);
        Ok(DeliveryOutcome::DeliveredVerified)
    };
    let steps = select_judged_for(
        deadline(5_000),
        plan(true, false, 3),
        SelectOps {
            expand: &mut expand,
            collapse: &mut collapse,
            find: &mut find,
            realize: &mut realize,
            select_item: &mut select_item,
        },
    )
    .expect("self select");
    assert_eq!(select.get(), 1);
    assert_eq!(steps[0].label(), "SelectionItemPattern.Select");
    assert_eq!(steps[0].verified(), Some(true));
    assert!(matches!(steps[0].outcome, ActionStepOutcome::Succeeded));
}

#[test]
fn value_mismatch_is_element_not_found_with_char_count_not_text() {
    let marker = "secret-select-marker-zz";
    let mut expand = || Ok(());
    let mut collapse = || {};
    let mut find = || Ok(false);
    let mut realize = || Ok(());
    let mut select_item = || Ok(DeliveryOutcome::DeliveredVerified);
    let error = select_judged_for(
        deadline(5_000),
        plan(false, false, marker.chars().count()),
        SelectOps {
            expand: &mut expand,
            collapse: &mut collapse,
            find: &mut find,
            realize: &mut realize,
            select_item: &mut select_item,
        },
    )
    .expect_err("miss");
    assert_eq!(error.code, ErrorCode::ElementNotFound);
    assert!(
        error
            .message
            .contains(&format!("{} chars", marker.chars().count()))
    );
    assert!(
        !error.message.contains(marker),
        "must never echo the requested value text"
    );
}

#[test]
fn container_search_selects_when_find_hits() {
    let select = Cell::new(0u8);
    let find_calls = Cell::new(0u8);
    let mut expand = || Ok(());
    let mut collapse = || {};
    let mut find = || {
        find_calls.set(find_calls.get() + 1);
        Ok(true)
    };
    let mut realize = || Ok(());
    let mut select_item = || {
        select.set(select.get() + 1);
        Ok(DeliveryOutcome::DeliveredVerified)
    };
    let steps = select_judged_for(
        deadline(5_000),
        plan(false, false, 4),
        SelectOps {
            expand: &mut expand,
            collapse: &mut collapse,
            find: &mut find,
            realize: &mut realize,
            select_item: &mut select_item,
        },
    )
    .expect("found");
    assert_eq!(find_calls.get(), 2);
    assert_eq!(select.get(), 1);
    assert_eq!(steps[0].label(), SELECT_LABEL);
}

#[test]
fn budget_exhaustion_surfaces_honest_error() {
    let mut expand = || Ok(());
    let mut collapse = || {};
    let mut find = || {
        Err(AdapterError::new(
            ErrorCode::AppUnresponsive,
            "Select search exceeded its accessibility-node budget",
        )
        .with_details(serde_json::json!({
            "kind": "select_node_limit",
            "limit": 2048,
            "complete": false,
        })))
    };
    let mut realize = || Ok(());
    let mut select_item = || Ok(DeliveryOutcome::DeliveredVerified);
    let error = select_judged_for(
        deadline(5_000),
        plan(false, false, 1),
        SelectOps {
            expand: &mut expand,
            collapse: &mut collapse,
            find: &mut find,
            realize: &mut realize,
            select_item: &mut select_item,
        },
    )
    .expect_err("budget");
    assert_eq!(error.code, ErrorCode::AppUnresponsive);
    assert_eq!(
        error.details.as_ref().and_then(|d| d.get("kind")),
        Some(&serde_json::json!("select_node_limit"))
    );
}

#[test]
fn collapsed_combobox_expands_first_and_collapses_on_failure() {
    let order = Cell::new(Vec::<&'static str>::new());
    let mut expand = || {
        push_order(&order, "expand");
        Ok(())
    };
    let mut collapse = || {
        push_order(&order, "collapse");
    };
    let mut find = || {
        push_order(&order, "find");
        Ok(true)
    };
    let mut realize = || {
        push_order(&order, "realize");
        Ok(())
    };
    let mut select_item = || {
        push_order(&order, "select");
        Err(
            AdapterError::new(ErrorCode::ActionFailed, "select failed after expand")
                .with_disposition(agent_desktop_core::DeliverySemantics::delivered_unverified()),
        )
    };
    let error = select_judged_for(
        deadline(5_000),
        plan(false, true, 2),
        SelectOps {
            expand: &mut expand,
            collapse: &mut collapse,
            find: &mut find,
            realize: &mut realize,
            select_item: &mut select_item,
        },
    )
    .expect_err("select failed");
    assert_eq!(error.code, ErrorCode::ActionFailed);
    assert_eq!(
        order.take(),
        vec!["expand", "find", "realize", "find", "select", "collapse"]
    );
}

#[test]
fn container_value_verification_outranks_is_selected() {
    assert_eq!(
        resolve_select_verification(Some(Some(true)), Some(false)),
        Some(true)
    );
    assert_eq!(
        resolve_select_verification(Some(Some(false)), Some(true)),
        Some(false)
    );
    assert_eq!(
        resolve_select_verification(Some(None), Some(true)),
        Some(true),
        "a withheld container value falls back to the is-selected read"
    );
}

#[test]
fn a_closed_list_never_makes_an_unverified_selection_look_verified() {
    use super::close_outcome;
    use crate::actions::chain::build_step;
    use crate::actions::disclosure::COLLAPSE_LABEL;
    use agent_desktop_core::{Action, ActionResult, DeliverySemantics};

    let summary = |selection: DeliveryOutcome, closed: bool| {
        let verified = build_step(SELECT_LABEL, selection).verified();
        let steps = vec![
            build_step(SELECT_LABEL, selection),
            build_step(
                COLLAPSE_LABEL,
                close_outcome(verified, true, closed, Some(true)),
            ),
        ];
        ActionResult::from_execution(&Action::Select("v".into()), steps).disposition()
    };
    assert_eq!(
        summary(DeliveryOutcome::DeliveredUnobserved, true),
        DeliverySemantics::delivered_unverified(),
        "an unobserved selection stays unverified after a successful close"
    );
    assert_eq!(
        summary(DeliveryOutcome::DeliveredUnverified, true),
        DeliverySemantics::delivered_unverified()
    );
    assert_eq!(
        summary(DeliveryOutcome::DeliveredVerified, true),
        DeliverySemantics::delivered_verified(),
        "a verified selection with a closed list is verified, as before"
    );
    assert_eq!(
        summary(DeliveryOutcome::DeliveredVerified, false),
        DeliverySemantics::delivered_unverified(),
        "a list left open is still reported"
    );
    assert_eq!(
        close_outcome(Some(true), false, false, None),
        DeliveryOutcome::NotDelivered
    );
}

#[test]
fn a_selection_the_app_puts_back_when_the_list_closes_is_not_verified() {
    use super::close_outcome;
    assert_eq!(
        close_outcome(Some(true), true, true, Some(true)),
        DeliveryOutcome::DeliveredVerified,
        "the selection still held after the close"
    );
    assert_eq!(
        close_outcome(Some(true), true, true, Some(false)),
        DeliveryOutcome::DeliveredUnverified,
        "the app changed the selection when told the list closed"
    );
    assert_eq!(
        close_outcome(Some(true), true, true, None),
        DeliveryOutcome::DeliveredUnverified,
        "a selection that could not be read again is not verified"
    );
}
