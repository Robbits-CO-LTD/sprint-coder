// Changed by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
use super::*;
use crate::refs::ref_ancestry::{Proof, proof_of};

fn item(text: &str, id: u32) -> NativeMenuItem {
    NativeMenuItem {
        text: Some(text.to_owned()),
        command_id: id,
        ..NativeMenuItem::default()
    }
}

fn opens(text: &str) -> NativeMenuItem {
    NativeMenuItem {
        submenu_unread: true,
        ..item(text, 0)
    }
}

fn step(name: &str, position: u32, submenu: bool) -> RefMenuStep {
    RefMenuStep {
        name: name.to_owned(),
        position,
        submenu,
    }
}

fn proof() -> RefMenuProof {
    RefMenuProof {
        steps: vec![
            step("ファイル(F)", 0, true),
            step("上書き保存(S)", 1, false),
        ],
        command_id: 1002,
        shortcut: Some("Ctrl+S".to_owned()),
    }
}

pub(crate) fn menu_entry() -> RefEntry {
    let mut entry = crate::adapter::minimal_ref_entry("menuitem", Some("上書き保存(S)"));
    entry.identity.unique_at_capture = false;
    entry.identity.in_menu = Some(proof());
    entry.source.source_window_id = Some("w-42".to_owned());
    entry.source.source_surface = crate::SnapshotSurface::Menubar;
    entry
}

#[test]
fn a_level_is_matched_by_its_one_item_of_the_recorded_name_wherever_it_moved() {
    let recorded = step("上書き保存(S)", 1, false);
    // The application rebuilt the menu on opening: the item moved down.
    let live = vec![
        item("開く(&O)\tCtrl+O", 1001),
        item("新規(&N)", 1000),
        NativeMenuItem {
            separator: true,
            ..NativeMenuItem::default()
        },
        item("上書き保存(&S)\tCtrl+S", 1002),
    ];
    assert_eq!(match_step(&live, &recorded), Ok(3));
}

#[test]
fn two_items_of_the_recorded_name_in_a_level_stop_the_match() {
    let live = vec![item("上書き保存(&S)", 1002), item("上書き保存(S)", 1009)];
    assert_eq!(
        match_step(&live, &step("上書き保存(S)", 0, false)),
        Err(MenuMismatch::Ambiguous)
    );
}

#[test]
fn a_missing_renamed_disabled_or_changed_item_stops_the_match() {
    let recorded = step("上書き保存(S)", 0, false);
    assert_eq!(
        match_step(&[item("名前を付けて保存(&A)", 1002)], &recorded),
        Err(MenuMismatch::Missing)
    );
    assert_eq!(
        match_step(
            &[NativeMenuItem {
                disabled: true,
                ..item("上書き保存(&S)", 1002)
            }],
            &recorded
        ),
        Err(MenuMismatch::Disabled)
    );
    assert_eq!(
        match_step(&[opens("上書き保存(&S)")], &recorded),
        Err(MenuMismatch::KindChanged)
    );
    assert_eq!(
        match_step(&[item("ファイル(&F)", 9)], &step("ファイル(F)", 0, true)),
        Err(MenuMismatch::KindChanged)
    );
    assert_eq!(
        match_step(
            &[NativeMenuItem {
                in_notify_by_position_menu: true,
                ..item("上書き保存(&S)", 1002)
            }],
            &recorded
        ),
        Err(MenuMismatch::NotifyByPosition)
    );
    // An item drawn by the application cannot be read, so it never matches.
    assert_eq!(
        match_step(
            &[NativeMenuItem {
                owner_drawn: true,
                ..item("上書き保存(&S)", 1002)
            }],
            &recorded
        ),
        Err(MenuMismatch::Missing)
    );
}

#[test]
fn the_last_item_must_still_send_the_recorded_command() {
    let proof = proof();
    assert_eq!(confirm_leaf(&item("上書き保存(&S)", 1002), &proof), Ok(()));
    assert_eq!(
        confirm_leaf(&item("上書き保存(&S)", 1104), &proof),
        Err(MenuMismatch::CommandChanged)
    );
    assert_eq!(
        confirm_leaf(
            &NativeMenuItem {
                disabled: true,
                ..item("上書き保存(&S)", 1002)
            },
            &proof
        ),
        Err(MenuMismatch::Disabled)
    );
    assert_eq!(
        confirm_leaf(&opens("上書き保存(&S)"), &proof),
        Err(MenuMismatch::KindChanged)
    );
}

#[test]
fn a_menu_proof_stands_alone() {
    assert_eq!(proof_of(&menu_entry()), Proof::InMenu);
    let mut unique = menu_entry();
    unique.identity.unique_at_capture = true;
    assert_eq!(proof_of(&unique), Proof::None);
    let mut ancestors = menu_entry();
    ancestors.identity.ancestors = vec![crate::RefAncestorIdentity {
        role: "menu".to_owned(),
        ..Default::default()
    }];
    assert_eq!(proof_of(&ancestors), Proof::None);
    let mut token = menu_entry();
    token.identity.retained_object = Some("uia:1".to_owned());
    assert_eq!(proof_of(&token), Proof::None);
}

#[test]
fn a_stored_menu_proof_must_have_its_shape() {
    assert!(validate_menu_proof(&menu_entry()).is_ok());
    let broken = |change: fn(&mut RefEntry)| {
        let mut entry = menu_entry();
        change(&mut entry);
        validate_menu_proof(&entry).is_err()
    };
    assert!(broken(|entry| entry
        .identity
        .in_menu
        .as_mut()
        .unwrap()
        .steps
        .clear()));
    assert!(broken(|entry| entry
        .identity
        .in_menu
        .as_mut()
        .unwrap()
        .command_id = 0));
    assert!(broken(|entry| {
        entry.identity.in_menu.as_mut().unwrap().steps[1].submenu = true;
    }));
    assert!(broken(|entry| {
        entry.identity.in_menu.as_mut().unwrap().steps[0].submenu = false;
    }));
    assert!(broken(|entry| {
        entry.identity.in_menu.as_mut().unwrap().steps[0].name = " ".to_owned();
    }));
    assert!(broken(|entry| {
        let steps = &mut entry.identity.in_menu.as_mut().unwrap().steps;
        let last = steps.pop().unwrap();
        for _ in 0..MAX_MENU_STEPS {
            steps.push(step("x", 0, true));
        }
        steps.push(last);
    }));
    assert!(broken(|entry| entry.identity.role = "button".to_owned()));
    assert!(broken(|entry| {
        entry.source.source_surface = crate::SnapshotSurface::Window;
    }));
    assert!(broken(|entry| entry.source.source_window_id = None));
}

#[test]
fn an_older_reader_sees_an_unproven_entry() {
    // The key an older reader does not know is dropped; what is left is an
    // entry proven by nothing, which it refuses.
    let mut stored = serde_json::to_value(menu_entry()).unwrap();
    assert!(stored.get("proven_in_menu").is_some());
    assert!(stored.get("unique_at_capture").is_none());
    stored.as_object_mut().unwrap().remove("proven_in_menu");
    let older: RefEntry = serde_json::from_value(stored).unwrap();
    assert_eq!(proof_of(&older), Proof::None);
}

#[test]
fn a_menu_item_ref_is_refused_where_refs_resolve_to_elements() {
    let error = menu_ref_refused(&menu_entry());
    assert_eq!(error.code, ErrorCode::ActionNotSupported);
    assert_eq!(error.disposition, DeliverySemantics::not_delivered());
    let mismatch = menu_mismatch_error(&menu_entry(), MenuMismatch::Ambiguous);
    assert_eq!(mismatch.code, ErrorCode::StaleRef);
    assert_eq!(mismatch.disposition, DeliverySemantics::not_delivered());
    assert_eq!(mismatch.details.unwrap()["reason"], "ambiguous");
    assert!(
        mismatch
            .suggestion
            .unwrap_or_default()
            .contains("snapshot --surface menubar --window-id w-42")
    );
}
