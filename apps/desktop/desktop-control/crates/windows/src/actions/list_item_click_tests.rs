// Added by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
use super::{
    ClickCheck, FrameworkRead, LIST_ITEM_CONTROL_TYPE, LIST_ITEM_DEPTH, ListRead, TypeRead,
    WindowRead, button_read, decide_click, framework_read_of, is_foreground_taking_list_class,
    is_win32_button_class, list_read, needs_control_type,
};
use crate::actions::foreground_hold::ButtonRead;

#[test]
fn the_standard_lists_and_their_winforms_superclasses_are_recognised() {
    for class in [
        "ListBox",
        "LISTBOX",
        "ComboLBox",
        "SysListView32",
        "WindowsForms10.LISTBOX.app.0.141b42a_r6_ad1",
        "WindowsForms10.SysListView32.app.0.141b42a_r6_ad1",
    ] {
        assert!(is_foreground_taking_list_class(class), "{class}");
    }
}

#[test]
fn other_classes_keep_their_click_path() {
    for class in [
        "",
        "Button",
        "ComboBox",
        "SysTreeView32",
        "SysTabControl32",
        "SysHeader32",
        "WindowsForms10.BUTTON.app.0.141b42a_r6_ad1",
        "WindowsForms10.Window.8.app.0.141b42a_r6_ad1",
        "HwndWrapper[powershell.exe;;0f1e]",
        "Chrome_RenderWidgetHostHWND",
        "MyListBoxHost",
    ] {
        assert!(!is_foreground_taking_list_class(class), "{class}");
    }
}

#[test]
fn only_the_system_button_class_is_a_win32_button() {
    assert!(is_win32_button_class("Button"));
    assert!(is_win32_button_class("BUTTON"));
    for class in ["", "ButtonHost", "WindowsForms10.BUTTON.app.0.1", "Static"] {
        assert!(!is_win32_button_class(class), "{class}");
    }
}

#[test]
fn an_item_of_a_win32_list_is_refused_whatever_it_offers() {
    for invoke in [true, false] {
        for control_type in [
            TypeRead::Known(LIST_ITEM_CONTROL_TYPE),
            TypeRead::Unread,
            TypeRead::NotAsked,
        ] {
            assert_eq!(
                decide_click(ListRead::Item, control_type, invoke),
                ClickCheck::Refuse
            );
        }
    }
}

#[test]
fn a_list_item_without_invoke_is_refused_and_one_with_invoke_is_not() {
    let list_item = TypeRead::Known(LIST_ITEM_CONTROL_TYPE);
    assert_eq!(
        decide_click(ListRead::NotItem, list_item, false),
        ClickCheck::Refuse
    );
    assert_eq!(
        decide_click(ListRead::NotItem, TypeRead::NotAsked, true),
        ClickCheck::Proceed
    );
}

#[test]
fn other_controls_read_as_such_keep_their_click_path() {
    // Button, check box, hyperlink, data item: not list items.
    for control_type in [50_000, 50_002, 50_005, 50_029] {
        assert_eq!(
            decide_click(ListRead::NotItem, TypeRead::Known(control_type), false),
            ClickCheck::Proceed
        );
    }
    assert_eq!(
        decide_click(ListRead::NotItem, TypeRead::Absent, false),
        ClickCheck::Proceed
    );
}

#[test]
fn what_could_not_be_read_is_never_taken_for_not_an_item() {
    for invoke in [true, false] {
        assert_eq!(
            decide_click(ListRead::Unread, TypeRead::NotAsked, invoke),
            ClickCheck::Unread
        );
    }
    assert_eq!(
        decide_click(ListRead::NotItem, TypeRead::Unread, false),
        ClickCheck::Unread
    );
    // A control type that was needed but not asked counts as unread too.
    assert_eq!(
        decide_click(ListRead::NotItem, TypeRead::NotAsked, false),
        ClickCheck::Unread
    );
}

#[test]
fn the_control_type_is_asked_only_when_it_decides() {
    assert!(needs_control_type(ListRead::NotItem, false));
    assert!(!needs_control_type(ListRead::NotItem, true));
    assert!(!needs_control_type(ListRead::Item, false));
    assert!(!needs_control_type(ListRead::Unread, false));
}

#[cfg(target_os = "windows")]
#[test]
fn the_refusals_send_nothing_and_say_how_to_go_on() {
    let policy = agent_desktop_core::InteractionPolicy::headless();
    let error = super::background_click_refusal(policy, ClickCheck::Refuse);
    assert_eq!(error.code, agent_desktop_core::ErrorCode::PolicyDenied);
    let suggestion = error.suggestion.as_deref().unwrap_or("");
    assert!(suggestion.contains("'select'"), "{suggestion}");
    assert!(suggestion.contains("--headed"), "{suggestion}");
    let details = error.details.expect("details");
    assert_eq!(details["kind"], "list_item_click_takes_foreground");
    assert_eq!(details["retryable"], false);
    let unread = super::background_click_refusal(policy, ClickCheck::Unread);
    assert_eq!(unread.code, agent_desktop_core::ErrorCode::PolicyDenied);
    let details = unread.details.expect("details");
    assert_eq!(details["kind"], "list_item_click_unreadable");
    assert_eq!(details["retryable"], true);
}

#[cfg(target_os = "windows")]
#[test]
fn a_background_click_is_refused_before_it_reaches_the_click_chain() {
    let source = include_str!("dispatch.rs");
    let click = source
        .split("fn execute_click(")
        .nth(1)
        .expect("execute_click");
    let refusal = click
        .find("background_click_refusal(")
        .expect("the refusal");
    let chain = click
        .find("click_chain_judged_for(")
        .expect("the click chain");
    assert!(
        refusal < chain,
        "the check must come before anything is sent"
    );
    assert!(click[..chain].contains("!policy.allow_focus_steal"));
    // Without a decision made before the lock, a background click is refused.
    assert!(click[..chain].contains("map_or(ClickCheck::Unread"));
}

#[cfg(target_os = "windows")]
#[test]
fn every_read_of_the_check_is_bounded() {
    let source = include_str!("list_item_click.rs");
    let code = source.split("#[cfg(test)]").next().expect("code");
    let reads = [
        "client.get_raw_view_walker()",
        "current.0.get_native_window_handle()",
        "walker.get_parent(&current.0)",
        "read_one(element, TreeProperty::ControlType)",
        "element.0.get_framework_id()",
    ];
    for read in reads {
        let at = code.find(read).unwrap_or_else(|| panic!("{read}"));
        let before = &code[at.saturating_sub(120)..at];
        assert!(
            before.contains("with_transaction_timeout("),
            "{read} is not bounded"
        );
    }
}

fn found(depth: usize, list: bool, button: bool) -> WindowRead {
    WindowRead::Found {
        depth,
        list,
        button,
    }
}

#[test]
fn a_list_window_up_to_three_levels_above_makes_an_item() {
    // Sub-item under a row under a group: three levels below the list view.
    for depth in 1..=LIST_ITEM_DEPTH {
        assert_eq!(
            list_read(found(depth, true, false), FrameworkRead::NotAsked),
            ListRead::Item,
            "{depth}"
        );
    }
    assert_eq!(LIST_ITEM_DEPTH, 3);
}

#[test]
fn the_list_itself_a_far_list_and_other_windows_are_not_items() {
    assert_eq!(
        list_read(found(0, true, false), FrameworkRead::NotAsked),
        ListRead::NotItem
    );
    assert_eq!(
        list_read(
            found(LIST_ITEM_DEPTH + 1, true, false),
            FrameworkRead::NotAsked
        ),
        ListRead::NotItem
    );
    assert_eq!(
        list_read(found(1, false, false), FrameworkRead::NotAsked),
        ListRead::NotItem
    );
}

#[test]
fn with_no_window_only_frameworks_without_win32_proxies_pass() {
    assert_eq!(
        list_read(WindowRead::NotFound, FrameworkRead::Other),
        ListRead::NotItem
    );
    for framework in [
        FrameworkRead::Win32Like,
        FrameworkRead::Unread,
        FrameworkRead::NotAsked,
    ] {
        assert_eq!(list_read(WindowRead::NotFound, framework), ListRead::Unread);
    }
    assert_eq!(
        list_read(WindowRead::Unread, FrameworkRead::Other),
        ListRead::Unread
    );
}

#[test]
fn the_win32_frameworks_are_told_apart_from_the_rest() {
    for id in ["Win32", "win32", "WinForm"] {
        assert_eq!(framework_read_of(id), FrameworkRead::Win32Like, "{id}");
    }
    for id in ["", "WPF", "Chrome", "DirectUI", "XAML", "WinUI"] {
        assert_eq!(framework_read_of(id), FrameworkRead::Other, "{id}");
    }
}

#[test]
fn only_an_element_with_its_own_button_window_is_a_win32_button() {
    assert_eq!(button_read(found(0, false, true)), ButtonRead::Button);
    assert_eq!(button_read(found(1, false, true)), ButtonRead::NotButton);
    assert_eq!(button_read(found(0, false, false)), ButtonRead::NotButton);
    assert_eq!(button_read(WindowRead::NotFound), ButtonRead::NotButton);
    assert_eq!(button_read(WindowRead::Unread), ButtonRead::Unread);
}
