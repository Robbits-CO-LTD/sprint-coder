// Added by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
use super::{click_takes_foreground, is_foreground_taking_list_class};

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
fn an_item_of_a_win32_list_is_refused_whatever_it_offers() {
    assert!(click_takes_foreground(true, None, true));
    assert!(click_takes_foreground(true, Some(50_000), false));
}

#[test]
fn a_list_item_without_invoke_is_refused_and_one_with_invoke_is_not() {
    assert!(click_takes_foreground(false, Some(50_007), false));
    assert!(!click_takes_foreground(false, Some(50_007), true));
}

#[test]
fn other_controls_and_unread_control_types_keep_their_click_path() {
    // Button, check box, hyperlink, data item: not list items.
    for control_type in [50_000, 50_002, 50_005, 50_029] {
        assert!(!click_takes_foreground(false, Some(control_type), false));
    }
    assert!(!click_takes_foreground(false, None, false));
}

#[cfg(target_os = "windows")]
#[test]
fn the_refusal_sends_nothing_and_says_how_to_go_on() {
    let error = super::background_click_refusal(agent_desktop_core::InteractionPolicy::headless());
    assert_eq!(error.code, agent_desktop_core::ErrorCode::PolicyDenied);
    let suggestion = error.suggestion.as_deref().unwrap_or("");
    assert!(suggestion.contains("'select'"), "{suggestion}");
    assert!(suggestion.contains("--headed"), "{suggestion}");
    let details = error.details.expect("details");
    assert_eq!(details["kind"], "list_item_click_takes_foreground");
}

#[cfg(target_os = "windows")]
#[test]
fn a_background_click_asks_before_it_reaches_the_click_chain() {
    let source = include_str!("dispatch.rs");
    let click = source
        .split("fn execute_click(")
        .nth(1)
        .expect("execute_click");
    let refusal = click
        .find("background_click_takes_foreground")
        .expect("the list item check");
    let chain = click
        .find("click_chain_judged_for(")
        .expect("the click chain");
    assert!(
        refusal < chain,
        "the check must come before anything is sent"
    );
    assert!(click[..chain].contains("!policy.allow_focus_steal"));
}
