// Changed by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
use super::*;
use crate::{ActionOps, InputOps, ObservationOps, SystemOps};

fn item(text: &str, id: u32) -> NativeMenuItem {
    NativeMenuItem {
        text: Some(text.to_owned()),
        command_id: id,
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
        ..item(text, 0)
    }
}

/// The test application's menu bar (`F:\work\ad-e2e\menu\menuapp.cpp`), as
/// the Windows read returns it.
pub(crate) fn sample_bar() -> NativeMenuBar {
    NativeMenuBar {
        items: vec![
            submenu(
                "ファイル(&F)",
                vec![
                    item("開く(&O)...\tCtrl+O", 1001),
                    NativeMenuItem {
                        disabled: true,
                        ..item("無効の項目(&D)", 1003)
                    },
                    separator(),
                    submenu(
                        "入れ子(&N)",
                        vec![submenu("孫(&G)", vec![item("孫 1(&1)", 1211)])],
                    ),
                ],
            ),
            submenu(
                "編集(&E)",
                vec![
                    NativeMenuItem {
                        checked: true,
                        ..item("折り返し(&W)", 2001)
                    },
                    NativeMenuItem {
                        text: None,
                        owner_drawn: true,
                        command_id: 2003,
                        ..NativeMenuItem::default()
                    },
                    NativeMenuItem {
                        checked: true,
                        radio: true,
                        ..item("左(&L)", 2004)
                    },
                ],
            ),
        ],
        complete: true,
        window_disabled: false,
    }
}

fn names(node: &AccessibilityNode) -> Vec<Option<String>> {
    node.children
        .iter()
        .map(|child| child.identity.name.clone())
        .collect()
}

pub(crate) fn window() -> WindowInfo {
    WindowInfo {
        id: "w-42".to_owned(),
        title: "menu 試験アプリ".to_owned(),
        app: "menuapp.exe".to_owned(),
        pid: crate::ProcessId::new(7),
        process_instance: Some("windows-proc-v1:1:1".to_owned()),
        bounds: None,
        state: Default::default(),
    }
}

fn with_refs(bar: &NativeMenuBar, depth: u8) -> (AccessibilityNode, RefMap) {
    let window = window();
    let mut refmap = RefMap::new();
    let (tree, _) = build_tree(
        bar,
        depth,
        Some(&mut MenuRefs {
            window: &window,
            refmap: &mut refmap,
        }),
    );
    (tree, refmap)
}

fn entry_of<'a>(refmap: &'a RefMap, node: &AccessibilityNode) -> &'a RefEntry {
    refmap
        .get(node.ref_id.as_deref().expect("the item has a ref"))
        .expect("the ref is in the map")
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
fn without_refs_the_tree_lists_items_without_separators_refs_or_actions() {
    let (tree, count) = build_tree(&sample_bar(), 10, None);
    assert_eq!(tree.role, "menubar");
    assert_eq!(
        names(&tree),
        vec![Some("ファイル(F)".to_owned()), Some("編集(E)".to_owned())]
    );
    assert_eq!(
        names(&tree.children[0]),
        vec![
            Some("開く(O)...".to_owned()),
            Some("無効の項目(D)".to_owned()),
            Some("入れ子(N)".to_owned()),
        ]
    );
    assert_eq!(count, 10);
    fn walk(node: &AccessibilityNode) {
        assert!(node.ref_id.is_none());
        assert!(node.presentation.available_actions.is_empty());
        crate::tree::state::assert_states_in_vocabulary(&node.presentation.states);
        node.children.iter().for_each(walk);
    }
    walk(&tree);
}

#[test]
fn only_runnable_items_get_a_ref_and_the_click_action() {
    let (tree, refmap) = with_refs(&sample_bar(), 10);
    let file = &tree.children[0];
    let edit = &tree.children[1];
    let with_ref = |node: &AccessibilityNode| {
        node.ref_id.is_some()
            && node.presentation.available_actions == vec![crate::actions::capability::CLICK]
    };
    // A submenu, a disabled item and an item drawn by the application get none.
    assert!(!with_ref(file));
    assert!(with_ref(&file.children[0]));
    assert!(!with_ref(&file.children[1]));
    assert!(!with_ref(&file.children[2]));
    assert!(with_ref(&file.children[2].children[0].children[0]));
    assert!(with_ref(&edit.children[0]));
    assert!(!with_ref(&edit.children[1]));
    assert!(with_ref(&edit.children[2]));
    assert_eq!(refmap.len(), 4);
}

#[test]
fn a_ref_records_its_place_by_name_and_position_and_its_command() {
    let (tree, refmap) = with_refs(&sample_bar(), 10);
    let grandchild = &tree.children[0].children[2].children[0].children[0];
    let entry = entry_of(&refmap, grandchild);
    let proof = entry.identity.in_menu.as_ref().unwrap();
    let steps: Vec<(&str, u32, bool)> = proof
        .steps
        .iter()
        .map(|step| (step.name.as_str(), step.position, step.submenu))
        .collect();
    // Positions count every item of the menu, separators included.
    assert_eq!(
        steps,
        vec![
            ("ファイル(F)", 0, true),
            ("入れ子(N)", 3, true),
            ("孫(G)", 0, true),
            ("孫 1(1)", 0, false),
        ]
    );
    assert_eq!(proof.command_id, 1211);
    assert_eq!(entry.identity.role, "menuitem");
    assert_eq!(entry.identity.name.as_deref(), Some("孫 1(1)"));
    assert!(!entry.identity.unique_at_capture);
    assert!(entry.identity.ancestors.is_empty() && entry.identity.in_view.is_none());
    assert_eq!(entry.source.source_surface, crate::SnapshotSurface::Menubar);
    assert_eq!(entry.source.source_window_id.as_deref(), Some("w-42"));
    assert_eq!(
        crate::refs::ref_ancestry::proof_of(entry),
        crate::refs::ref_ancestry::Proof::InMenu
    );
    let open = entry_of(&refmap, &tree.children[0].children[0]);
    assert_eq!(
        open.identity.in_menu.as_ref().unwrap().shortcut.as_deref(),
        Some("Ctrl+O")
    );
}

#[test]
fn an_item_with_a_twin_name_on_its_way_gets_no_ref_and_says_why() {
    let bar = NativeMenuBar {
        items: vec![
            submenu(
                "ファイル(&F)",
                vec![item("保存(&S)", 1), item("保存(S)", 2)],
            ),
            submenu("編集(&E)", vec![item("元に戻す", 3)]),
            submenu("編集(E)", vec![item("やり直す", 4)]),
        ],
        complete: true,
        window_disabled: false,
    };
    let (tree, refmap) = with_refs(&bar, 10);
    assert!(refmap.is_empty());
    for node in [
        &tree.children[0].children[0],
        &tree.children[0].children[1],
        &tree.children[1].children[0],
        &tree.children[2].children[0],
    ] {
        assert!(node.ref_id.is_none());
        assert!(
            node.presentation
                .hint
                .as_deref()
                .unwrap_or_default()
                .contains("same name")
        );
    }
}

#[test]
fn an_item_without_a_command_under_a_disabled_menu_or_reported_by_position_gets_no_ref() {
    let notify = NativeMenuItem {
        in_notify_by_position_menu: true,
        ..item("位置で知らせる", 7)
    };
    let bar = NativeMenuBar {
        items: vec![
            submenu("A", vec![item("ID 無し", 0), item("大きな ID", 70_000)]),
            NativeMenuItem {
                disabled: true,
                ..submenu("B", vec![item("無効の下", 5)])
            },
            submenu("C", vec![notify]),
        ],
        complete: true,
        window_disabled: false,
    };
    let (tree, refmap) = with_refs(&bar, 10);
    assert!(refmap.is_empty());
    let hint = |node: &AccessibilityNode| node.presentation.hint.clone().unwrap_or_default();
    assert!(hint(&tree.children[0].children[0]).contains("sends no command"));
    assert!(hint(&tree.children[0].children[1]).contains("wider than the 16 bits"));
    assert!(hint(&tree.children[1].children[0]).contains("menu is disabled"));
    // Its menu reports by position, the bar above it by command.
    assert!(hint(&tree.children[2].children[0]).contains("different ways"));
}

/// A bar that reports chosen items by position, with every submenu reporting
/// so too (`MNS_NOTIFYBYPOS` applied to the submenus): its items get refs
/// that record it. One whose menu's style could not be read gets none.
#[test]
fn an_item_of_a_menu_reporting_by_position_throughout_records_it_in_its_ref() {
    let by_position = |item: NativeMenuItem| NativeMenuItem {
        in_notify_by_position_menu: true,
        ..item
    };
    let bar = NativeMenuBar {
        items: vec![
            by_position(submenu(
                "ファイル(&F)",
                vec![
                    by_position(item("開く(&O)", 1001)),
                    NativeMenuItem {
                        notify_style_unread: true,
                        ..item("読めない(&U)", 1002)
                    },
                ],
            )),
            by_position(item("直下(&T)", 1003)),
        ],
        complete: true,
        window_disabled: false,
    };
    let (tree, refmap) = with_refs(&bar, 10);
    let open = entry_of(&refmap, &tree.children[0].children[0]);
    assert!(open.identity.in_menu.as_ref().unwrap().by_position);
    let top = entry_of(&refmap, &tree.children[1]);
    assert!(top.identity.in_menu.as_ref().unwrap().by_position);
    let unread = &tree.children[0].children[1];
    assert!(unread.ref_id.is_none());
    assert!(
        unread
            .presentation
            .hint
            .as_deref()
            .unwrap_or_default()
            .contains("could not be read")
    );
    // A menu that sends commands records nothing of it.
    let (tree, refmap) = with_refs(&sample_bar(), 10);
    let save = entry_of(&refmap, &tree.children[0].children[0]);
    assert!(!save.identity.in_menu.as_ref().unwrap().by_position);
}

#[test]
fn a_window_without_a_process_instance_gets_no_refs() {
    let mut window = window();
    window.process_instance = None;
    let result = capture(&window, &sample_bar(), 10);
    assert!(result.refmap.is_empty());
}

#[test]
fn items_carry_their_state_shortcut_and_submenu() {
    let (tree, _) = build_tree(&sample_bar(), 10, None);
    let file = &tree.children[0];
    assert_eq!(file.presentation.states, vec!["haspopup"]);
    assert_eq!(
        file.children[0].presentation.hint.as_deref(),
        Some("Shortcut: Ctrl+O.")
    );
    assert_eq!(file.children[1].presentation.states, vec!["disabled"]);
    let edit = &tree.children[1];
    assert_eq!(edit.children[0].presentation.states, vec!["checked"]);
    assert_eq!(
        edit.children[2].presentation.descriptors.subrole.as_deref(),
        Some("radio")
    );
}

#[test]
fn an_item_drawn_by_the_application_says_its_name_cannot_be_read() {
    let (tree, _) = build_tree(&sample_bar(), 10, None);
    let drawn = &tree.children[1].children[1];
    assert_eq!(drawn.identity.name, None);
    assert_eq!(drawn.presentation.hint.as_deref(), Some(OWNER_DRAWN_HINT));
}

fn drawn(id: u32) -> NativeMenuItem {
    NativeMenuItem {
        text: None,
        owner_drawn: true,
        command_id: id,
        ..NativeMenuItem::default()
    }
}

/// A Tcl/Tk menu: the bar's items are text, every item below them is drawn
/// by the application. The item opening such a menu says that nothing in it
/// can be run from behind the window, and so does the envelope; a menu with
/// one readable item, or with no item at all, says nothing of the kind.
#[test]
fn a_menu_the_application_draws_throughout_says_none_of_it_can_be_run() {
    let bar = NativeMenuBar {
        items: vec![
            submenu("Repository", vec![drawn(5001), separator(), drawn(5002)]),
            submenu("Mixed", vec![drawn(5003), item("Readable", 5004)]),
            submenu("Empty", vec![separator()]),
        ],
        complete: true,
        window_disabled: false,
    };
    let (tree, refmap) = with_refs(&bar, 10);
    assert_eq!(refmap.len(), 1, "only the readable item gets a ref");
    let hint = |node: &AccessibilityNode| node.presentation.hint.clone().unwrap_or_default();
    assert_eq!(hint(&tree.children[0]), DRAWN_MENU_HINT);
    assert!(DRAWN_MENU_HINT.contains("none of them can be run from behind the window"));
    assert!(!DRAWN_MENU_HINT.contains("click <ref>"));
    assert!(
        tree.children[0]
            .children
            .iter()
            .all(|child| child.ref_id.is_none())
    );
    assert_eq!(hint(&tree.children[1]), "");
    assert_eq!(hint(&tree.children[2]), "");
    let body = present(&capture(&window(), &bar, 10), false);
    let menu_hint = body["menu_hint"].as_str().unwrap_or_default();
    assert!(menu_hint.starts_with(DRAWN_MENUS_BAR_HINT), "{menu_hint}");
    // Cut at the depth limit, the item still says so.
    let (tree, _) = with_refs(&bar, 1);
    assert_eq!(hint(&tree.children[0]), DRAWN_MENU_HINT);
    // A bar with no such menu keeps the plain envelope hint.
    assert_eq!(
        present(&capture(&window(), &sample_bar(), 10), false)["menu_hint"],
        MENU_BAR_HINT
    );
    assert!(every_item_unnamed(&[drawn(1)]));
    assert!(!every_item_unnamed(&[]));
    assert!(!every_item_unnamed(&[separator()]));
    assert!(!every_item_unnamed(&[drawn(1), item("x", 2)]));
}

/// The identifiers wxWidgets gives menu items are negative and kept in 16
/// bits (-31000 is 0x86E8): such an item gets a ref recording that value as
/// it is. The same identifier kept in 32 bits gets none, and says why.
#[test]
fn an_item_with_an_identifier_from_0x8000_gets_a_ref_recording_it_as_it_is() {
    let bar = NativeMenuBar {
        items: vec![submenu(
            "ヘルプ(&H)",
            vec![
                item("負の ID -31000(&A)", 0x86E8),
                item("ID 0xFFFF(&F)", 0xFFFF),
                item("32 bit に広げた(&E)", 0xFFFF_86E7),
            ],
        )],
        complete: true,
        window_disabled: false,
    };
    let (tree, refmap) = with_refs(&bar, 10);
    let help = &tree.children[0];
    let recorded = |node: &AccessibilityNode| {
        entry_of(&refmap, node)
            .identity
            .in_menu
            .as_ref()
            .unwrap()
            .command_id
    };
    assert_eq!(recorded(&help.children[0]), 0x86E8);
    assert_eq!(recorded(&help.children[1]), 0xFFFF);
    assert!(help.children[2].ref_id.is_none());
    assert!(
        help.children[2]
            .presentation
            .hint
            .as_deref()
            .unwrap_or_default()
            .contains("wider than the 16 bits")
    );
}

#[test]
fn submenus_below_the_depth_limit_carry_their_item_count_and_no_refs() {
    let (tree, refmap) = with_refs(&sample_bar(), 1);
    let file = &tree.children[0];
    assert!(file.children.is_empty());
    assert_eq!(file.children_count, Some(3), "the separator is not counted");
    assert!(refmap.is_empty());
}

#[test]
fn an_unread_submenu_is_marked_cut_short() {
    let bar = NativeMenuBar {
        items: vec![NativeMenuItem {
            submenu_unread: true,
            ..item("ファイル(&F)", 0)
        }],
        complete: false,
        window_disabled: false,
    };
    let (tree, _) = build_tree(&bar, 10, None);
    let file = &tree.children[0];
    assert!(file.subtree_truncated);
    assert_eq!(file.presentation.states, vec!["haspopup"]);
    assert_eq!(file.presentation.hint.as_deref(), Some(UNREAD_HINT));
}

#[test]
fn the_envelope_says_it_is_the_menu_bar_and_how_to_run_an_item() {
    let body = present(&capture(&window(), &sample_bar(), 10), false);
    assert_eq!(body["surface"], "menubar");
    assert_eq!(body["menu_hint"], MENU_BAR_HINT);
    assert!(MENU_BAR_HINT.contains("click <ref>"));
    assert_eq!(body["ref_count"], 4);
    assert_eq!(body["complete"], true);
    assert_eq!(body["window"]["id"], "w-42");
    assert_eq!(body["tree"]["role"], "menubar");
    assert!(body.get("depth_hint").is_none());
}

#[test]
fn a_cut_read_says_so_with_the_menu_bar_depth_hint() {
    let body = present(&capture(&window(), &sample_bar(), 1), false);
    assert_eq!(body["depth_limited"], true);
    assert_eq!(body["depth_hint"], MENU_BAR_DEPTH_HINT);
    let mut bar = sample_bar();
    bar.complete = false;
    let body = present(&capture(&window(), &bar, 10), false);
    assert_eq!(body["complete"], false);
    assert_eq!(body["truncated"], true);
}

#[test]
fn a_disabled_window_gets_no_refs_and_says_so() {
    let mut bar = sample_bar();
    bar.window_disabled = true;
    let result = capture(&window(), &bar, 10);
    assert!(result.refmap.is_empty());
    let body = present(&result, bar.window_disabled);
    assert_eq!(body["window_disabled"], true);
    assert!(
        body["menu_hint"]
            .as_str()
            .unwrap_or_default()
            .starts_with(MENU_BAR_DISABLED_HINT)
    );
    assert!(body.get("window_disabled").is_some());
    assert!(
        present(&capture(&window(), &sample_bar(), 10), false)
            .get("window_disabled")
            .is_none()
    );
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
fn the_named_window_is_read_and_its_refs_saved() {
    let _home = crate::refs::refs_test_support::HomeGuard::new();
    let context = CommandContext::default();
    let body = run(
        &Bar,
        &TreeOptions::default(),
        None,
        Some("w-42"),
        1_000,
        &context,
    )
    .unwrap();
    assert_eq!(body["surface"], "menubar");
    assert_eq!(body["tree"]["children"][0]["name"], "ファイル(F)");
    let snapshot_id = body["snapshot_id"].as_str().expect("the refs are saved");
    let open = body["tree"]["children"][0]["children"][0]["ref_id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(open.starts_with(&format!("@{snapshot_id}:")));
    let entry = crate::commands::helpers::load_ref_entry(&open, &context).unwrap();
    assert_eq!(entry.identity.in_menu.unwrap().command_id, 1001);
    let error = run(
        &Bar,
        &TreeOptions::default(),
        None,
        Some("w-9"),
        1_000,
        &context,
    )
    .unwrap_err();
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
fn a_standard_menu_bar_item_points_at_reading_and_running_it_from_the_menubar_surface() {
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
    assert!(suggestion.contains("then click the item's ref"));
    assert_eq!(error.details.unwrap()["menu_bar"], "standard");
}

/// An item of the bar whose menu the application draws throughout (Tcl/Tk):
/// the guidance never points at running its items from the menubar surface.
#[test]
fn a_menu_bar_item_whose_menu_is_drawn_throughout_says_it_cannot_be_run_from_behind() {
    let error = annotate_action_error(
        &Kind(MenuBarKind::DrawnItems),
        &menu_entry(),
        &Action::Expand,
        denied(),
    );
    assert_eq!(error.code, ErrorCode::PolicyDenied);
    assert_eq!(error.disposition, crate::DeliverySemantics::not_delivered());
    let suggestion = error.suggestion.unwrap_or_default();
    assert!(suggestion.starts_with("Allow the cursor to move. "));
    assert!(suggestion.contains("cannot be run from behind the window"));
    assert!(suggestion.contains("brings the window to the front"));
    assert!(!suggestion.contains("then click the item's ref"));
    assert_eq!(error.details.unwrap()["menu_bar"], "owner_drawn");
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
    let suggestion = error.suggestion.unwrap_or_default();
    assert!(suggestion.contains("not a standard Windows menu"));
    // A Qt window (VLC, for one): never pointed at the menubar surface.
    assert!(suggestion.contains("cannot be opened or run from behind the window"));
    assert!(suggestion.contains("brings the window to the front"));
    assert!(!suggestion.contains("--surface menubar"));
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
    // A menu item ref read from the menu itself is never told to read the menu.
    let (_, refmap) = with_refs(&sample_bar(), 10);
    let menu_ref = refmap.get("@e1").unwrap().clone();
    unchanged(&standard, &menu_ref, Action::Click, denied());
}
