// Changed by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
use super::*;

#[test]
fn frontmost_owner_reporting_no_focused_window_lists_windows_unfocused() {
    let owners = owners(&[(10, 100.0), (20, 200.0)], Some(10));
    let records = vec![record(10, 1, "Front"), record(20, 2, "Background")];

    let windows = assemble_global_windows(records, &owners, false, |_| Ok(ax_state(None))).unwrap();

    assert_eq!(windows.len(), 2);
    assert!(windows.iter().all(|window| !window.state.is_focused));
}

#[test]
fn focused_only_is_empty_when_the_frontmost_owner_reports_no_focused_window() {
    let owners = owners(&[(10, 100.0)], Some(10));

    let windows = assemble_global_windows(vec![record(10, 1, "Front")], &owners, true, |_| {
        Ok(ax_state(None))
    })
    .unwrap();

    assert!(windows.is_empty());
}

const DIALOG: i64 = 25801;

type OwnerLayer = Result<Option<(i32, i64)>, AdapterError>;

fn assemble_with_dialog_focus(
    focused_only: bool,
    focused_number: Option<i64>,
    owner_layer: impl Fn(i64) -> OwnerLayer,
) -> Result<Vec<WindowInfo>, AdapterError> {
    let owners = owners(&[(10, 100.0), (20, 200.0)], Some(10));
    let records = vec![record(10, 10771, "Offscreen"), record(20, 2, "Editor")];
    assemble_global_windows(records, &owners, focused_only, |pid| {
        focus_layer::read_frontmost_in_inventory(
            pid,
            |_| Ok(ax_state(Some((None, focused_number)))),
            &owner_layer,
        )
    })
}

#[test]
fn a_frontmost_system_dialog_above_layer_zero_lists_every_window_unfocused() {
    let windows = assemble_with_dialog_focus(false, Some(DIALOG), |number| {
        assert_eq!(number, DIALOG);
        Ok(Some((10, 8)))
    })
    .unwrap();

    assert_eq!(windows.len(), 2);
    assert!(windows.iter().all(|window| !window.state.is_focused));
}

#[test]
fn focused_only_is_empty_while_a_system_dialog_holds_the_focus() {
    let windows = assemble_with_dialog_focus(true, Some(DIALOG), |_| Ok(Some((10, 8)))).unwrap();

    assert!(windows.is_empty());
}

#[test]
fn focus_outside_the_inventory_still_retries_unless_coregraphics_confirms_it() {
    let unconfirmed: [&dyn Fn(i64) -> OwnerLayer; 4] = [
        &|_| Ok(None),
        &|_| Ok(Some((10, 0))),
        &|_| Ok(Some((20, 8))),
        &|_| {
            Err(AdapterError::timeout(
                "CoreGraphics window inventory timed out",
            ))
        },
    ];
    for owner_layer in unconfirmed {
        let error = assemble_with_dialog_focus(false, Some(DIALOG), owner_layer).unwrap_err();

        assert_eq!(error.details.unwrap()["kind"], "frontmost_window_join");
    }
}

#[test]
fn a_focused_window_without_a_number_is_never_looked_up() {
    let state = focus_layer::read_frontmost_in_inventory(
        10,
        |_| Ok(ax_state(Some((Some("Dialog".into()), None)))),
        |_| -> OwnerLayer { panic!("a window without a number has nothing to look up") },
    )
    .unwrap();

    assert_eq!(state.focused, Some((Some("Dialog".into()), None)));
}

#[test]
fn only_a_confirmed_same_owner_non_zero_layer_clears_the_focus() {
    let read = |owner_layer: OwnerLayer| {
        focus_layer::read_frontmost_in_inventory(
            10,
            |_| Ok(ax_state(Some((None, Some(DIALOG))))),
            |_| owner_layer,
        )
        .unwrap()
        .focused
    };

    assert_eq!(read(Ok(Some((10, 8)))), None);
    assert_eq!(read(Ok(Some((10, -1)))), None);
    for kept in [
        Ok(None),
        Ok(Some((10, 0))),
        Ok(Some((20, 8))),
        Err(AdapterError::timeout("busy")),
    ] {
        assert_eq!(read(kept), Some((None, Some(DIALOG))));
    }
}

#[test]
fn a_failed_accessibility_read_is_not_masked_by_the_layer_lookup() {
    let error = focus_layer::read_frontmost_in_inventory(
        10,
        |_| Err(AdapterError::timeout("AX busy")),
        |_| -> OwnerLayer { panic!("no focus was read") },
    )
    .unwrap_err();

    assert_eq!(error.code, ErrorCode::Timeout);
}

#[test]
fn a_layer_zero_focus_still_joins_to_its_record() {
    let windows = assemble_with_dialog_focus(false, Some(10771), |_| Ok(Some((10, 0)))).unwrap();

    let focused = windows
        .iter()
        .filter(|window| window.state.is_focused)
        .map(|window| window.id.as_str())
        .collect::<Vec<_>>();
    assert_eq!(focused, ["w-10771"]);
}
