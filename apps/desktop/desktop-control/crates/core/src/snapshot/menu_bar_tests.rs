// Changed by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
use super::*;
use crate::{ActionOps, InputOps, ObservationOps, SystemOps};

fn item(text: &str) -> NativeMenuItem {
    NativeMenuItem {
        text: Some(text.to_owned()),
        ..NativeMenuItem::default()
    }
}

fn separator() -> NativeMenuItem {
    NativeMenuItem {
        separator: true,
        ..NativeMenuItem::default()
    }
}

fn submenu(text: &str, items: Vec<NativeMenuItem>) -> NativeMenuItem {
    NativeMenuItem {
        submenu: Some(items),
        ..item(text)
    }
}

/// The test application's menu bar (`F:\work\ad-e2e\menu\menuapp.cpp`), as
/// the Windows read returns it.
fn sample_bar() -> NativeMenuBar {
    NativeMenuBar {
        items: vec![
            submenu(
                "ファイル(&F)",
                vec![
                    item("開く(&O)...\tCtrl+O"),
                    NativeMenuItem {
                        disabled: true,
                        ..item("無効の項目(&D)")
                    },
                    separator(),
                    submenu(
                        "入れ子(&N)",
                        vec![submenu("孫(&G)", vec![item("孫 1(&1)")])],
                    ),
                ],
            ),
            submenu(
                "編集(&E)",
                vec![
                    NativeMenuItem {
                        checked: true,
                        ..item("折り返し(&W)")
                    },
                    NativeMenuItem {
                        text: None,
                        owner_drawn: true,
                        ..NativeMenuItem::default()
                    },
                    NativeMenuItem {
                        checked: true,
                        radio: true,
                        ..item("左(&L)")
                    },
                ],
            ),
        ],
        complete: true,
    }
}

fn names(node: &AccessibilityNode) -> Vec<Option<String>> {
    node.children
        .iter()
        .map(|child| child.identity.name.clone())
        .collect()
}

#[test]
fn item_names_drop_access_key_markers_and_the_shortcut() {
    assert_eq!(menu_item_name("ファイル(&F)"), "ファイル(F)");
    assert_eq!(menu_item_name("&Open...\tCtrl+O"), "Open...");
    assert_eq!(menu_item_name("Save && Close"), "Save & Close");
    assert_eq!(
        menu_item_shortcut("開く(&O)...\tCtrl+O"),
        Some("Ctrl+O".to_owned())
    );
    assert_eq!(menu_item_shortcut("開く(&O)"), None);
    assert_eq!(menu_item_shortcut("開く\t "), None);
}

#[test]
fn the_tree_lists_items_without_separators_refs_or_actions() {
    let (tree, count) = build_tree(&sample_bar(), 10);
    assert_eq!(tree.role, "menubar");
    assert_eq!(
        names(&tree),
        vec![Some("ファイル(F)".to_owned()), Some("編集(E)".to_owned())]
    );
    let file = &tree.children[0];
    assert_eq!(
        names(file),
        vec![
            Some("開く(O)...".to_owned()),
            Some("無効の項目(D)".to_owned()),
            Some("入れ子(N)".to_owned()),
        ]
    );
    assert_eq!(count, 10);
    fn walk(node: &AccessibilityNode) {
        assert!(node.ref_id.is_none(), "a menu bar item carries no ref");
        assert!(
            node.presentation.available_actions.is_empty(),
            "a menu bar item offers no action"
        );
        crate::tree::state::assert_states_in_vocabulary(&node.presentation.states);
        node.children.iter().for_each(walk);
    }
    walk(&tree);
}

#[test]
fn items_carry_their_state_shortcut_and_submenu() {
    let (tree, _) = build_tree(&sample_bar(), 10);
    let file = &tree.children[0];
    assert_eq!(file.presentation.states, vec!["haspopup"]);
    assert_eq!(
        file.children[0].presentation.hint.as_deref(),
        Some("Shortcut: Ctrl+O")
    );
    assert_eq!(file.children[1].presentation.states, vec!["disabled"]);
    let grandchild = &file.children[2].children[0].children[0];
    assert_eq!(grandchild.identity.name.as_deref(), Some("孫 1(1)"));
    let edit = &tree.children[1];
    assert_eq!(edit.children[0].presentation.states, vec!["checked"]);
    assert_eq!(edit.children[0].presentation.descriptors.subrole, None);
    assert_eq!(
        edit.children[2].presentation.descriptors.subrole.as_deref(),
        Some("radio")
    );
}

#[test]
fn an_item_drawn_by_the_application_says_its_name_cannot_be_read() {
    let (tree, _) = build_tree(&sample_bar(), 10);
    let drawn = &tree.children[1].children[1];
    assert_eq!(drawn.identity.name, None);
    assert_eq!(drawn.presentation.hint.as_deref(), Some(OWNER_DRAWN_HINT));
}

#[test]
fn submenus_below_the_depth_limit_carry_their_item_count() {
    let (tree, count) = build_tree(&sample_bar(), 1);
    let file = &tree.children[0];
    assert!(file.children.is_empty());
    assert_eq!(file.children_count, Some(3), "the separator is not counted");
    assert_eq!(count, 2);
}

#[test]
fn an_unread_submenu_is_marked_cut_short() {
    let bar = NativeMenuBar {
        items: vec![NativeMenuItem {
            submenu_unread: true,
            ..item("ファイル(&F)")
        }],
        complete: false,
    };
    let (tree, _) = build_tree(&bar, 10);
    let file = &tree.children[0];
    assert!(file.subtree_truncated);
    assert_eq!(file.presentation.states, vec!["haspopup"]);
    assert_eq!(file.presentation.hint.as_deref(), Some(UNREAD_HINT));
}

fn window() -> WindowInfo {
    WindowInfo {
        id: "w-42".to_owned(),
        title: "menu 試験アプリ".to_owned(),
        app: "menuapp".to_owned(),
        pid: crate::ProcessId::new(7),
        process_instance: None,
        bounds: None,
        state: Default::default(),
    }
}

#[test]
fn the_envelope_says_it_is_the_menu_bar_and_holds_no_refs() {
    let body = present(&window(), &sample_bar(), 10);
    assert_eq!(body["surface"], "menubar");
    assert_eq!(body["menu_hint"], MENU_BAR_HINT);
    assert_eq!(body["ref_count"], 0);
    assert!(body["snapshot_id"].is_null());
    assert_eq!(body["complete"], true);
    assert_eq!(body["window"]["id"], "w-42");
    assert_eq!(body["tree"]["role"], "menubar");
    assert!(body.get("depth_hint").is_none());
}

#[test]
fn a_cut_read_says_so_with_the_menu_bar_depth_hint() {
    let body = present(&window(), &sample_bar(), 1);
    assert_eq!(body["depth_limited"], true);
    assert_eq!(body["depth_hint"], MENU_BAR_DEPTH_HINT);
    let mut bar = sample_bar();
    bar.complete = false;
    let body = present(&window(), &bar, 10);
    assert_eq!(body["complete"], false);
    assert_eq!(body["truncated"], true);
}

struct Bar;
impl ObservationOps for Bar {
    fn list_windows(
        &self,
        _filter: &crate::WindowFilter,
        _deadline: crate::Deadline,
    ) -> Result<Vec<WindowInfo>, AdapterError> {
        Ok(vec![window()])
    }

    fn read_menu_bar(
        &self,
        window: &WindowInfo,
        _deadline: crate::Deadline,
    ) -> Result<NativeMenuBar, AdapterError> {
        assert_eq!(window.id, "w-42");
        Ok(sample_bar())
    }
}
impl ActionOps for Bar {}
impl InputOps for Bar {}
impl SystemOps for Bar {}

#[test]
fn the_named_window_is_read_through_the_adapter() {
    let body = run(&Bar, &TreeOptions::default(), None, Some("w-42"), 1_000).unwrap();
    assert_eq!(body["surface"], "menubar");
    assert_eq!(body["tree"]["children"][0]["name"], "ファイル(F)");
    let error = run(&Bar, &TreeOptions::default(), None, Some("w-9"), 1_000).unwrap_err();
    assert_eq!(error.code(), "WINDOW_NOT_FOUND");
}

struct Kind(MenuBarKind);
impl ObservationOps for Kind {
    fn menu_bar_kind(&self, _entry: &RefEntry, _deadline: crate::Deadline) -> MenuBarKind {
        self.0
    }
}
impl ActionOps for Kind {}
impl InputOps for Kind {}
impl SystemOps for Kind {}

fn menu_entry() -> RefEntry {
    let mut entry = crate::adapter::minimal_ref_entry("menuitem", Some("ファイル(F)"));
    entry.source.source_window_id = Some("w-42".to_owned());
    entry
}

fn denied() -> AdapterError {
    AdapterError::new(
        ErrorCode::PolicyDenied,
        "Target is not actionable: direct semantic delivery is unavailable and physical fallback is denied",
    )
    .with_suggestion("Allow the cursor to move.")
    .with_disposition(crate::DeliverySemantics::not_delivered())
}

#[test]
fn a_standard_menu_bar_item_points_at_the_menubar_surface() {
    let error = annotate_action_error(
        &Kind(MenuBarKind::StandardItem),
        &menu_entry(),
        &Action::Click,
        denied(),
    );
    assert_eq!(error.code, ErrorCode::PolicyDenied);
    assert_eq!(error.disposition, crate::DeliverySemantics::not_delivered());
    let suggestion = error.suggestion.unwrap_or_default();
    assert!(suggestion.starts_with("Allow the cursor to move. "));
    assert!(suggestion.contains("snapshot --surface menubar --window-id w-42"));
    assert_eq!(error.details.unwrap()["menu_bar"], "standard");
}

#[test]
fn a_menu_of_a_window_without_a_standard_menu_bar_says_it_needs_the_front() {
    let error = AdapterError::new(ErrorCode::ActionNotSupported, "expand is not available");
    let error = annotate_action_error(
        &Kind(MenuBarKind::NotStandard),
        &menu_entry(),
        &Action::Expand,
        error,
    );
    assert_eq!(error.code, ErrorCode::ActionNotSupported);
    assert_eq!(error.message, "expand is not available");
    assert!(
        error
            .suggestion
            .unwrap_or_default()
            .contains("not a standard Windows menu")
    );
    assert_eq!(error.details.unwrap()["menu_bar"], "not_standard");
}

#[test]
fn other_failures_are_left_as_they_are() {
    let unchanged = |adapter: &Kind, entry: &RefEntry, action: Action, error: AdapterError| {
        let before = error.clone();
        let after = annotate_action_error(adapter, entry, &action, error);
        assert_eq!(after.suggestion, before.suggestion);
        assert_eq!(after.details, before.details);
    };
    let standard = Kind(MenuBarKind::StandardItem);
    unchanged(
        &Kind(MenuBarKind::Unknown),
        &menu_entry(),
        Action::Click,
        denied(),
    );
    unchanged(
        &standard,
        &crate::adapter::minimal_ref_entry("button", Some("ファイル(F)")),
        Action::Click,
        denied(),
    );
    unchanged(&standard, &menu_entry(), Action::Toggle, denied());
    // A minimized window is refused for that reason alone.
    unchanged(
        &Kind(MenuBarKind::NotStandard),
        &menu_entry(),
        Action::Expand,
        AdapterError::new(ErrorCode::ActionFailed, "minimized")
            .with_details(serde_json::json!({ "kind": "window_minimized" })),
    );
    unchanged(
        &standard,
        &menu_entry(),
        Action::Click,
        AdapterError::new(ErrorCode::StaleRef, "gone"),
    );
}
