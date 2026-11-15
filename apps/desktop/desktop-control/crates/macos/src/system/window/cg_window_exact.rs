// Changed by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
use agent_desktop_core::AdapterError;
use core_foundation::array::CFArray;
use std::time::Instant;

use super::cg_window::{WindowDictionary, WindowRecord, WindowRecordScope};

pub(crate) fn exact_window_record_until(
    window_number: i64,
    deadline: Instant,
) -> Result<Option<WindowRecord>, AdapterError> {
    exact_window_record_until_with(window_number, deadline, || {
        let dictionaries = exact_window_dictionaries(window_number)?;
        let mut records = super::cg_window::records_from_dictionaries(
            dictionaries,
            WindowRecordScope::Window(window_number),
        )?;
        super::cg_window::capture_process_instances(&mut records, deadline)?;
        Ok(records)
    })
}

fn exact_window_record_until_with(
    window_number: i64,
    deadline: Instant,
    capture: impl FnOnce() -> Result<Vec<WindowRecord>, AdapterError>,
) -> Result<Option<WindowRecord>, AdapterError> {
    super::cg_window::ensure_before_deadline(deadline)?;
    let mut records = capture()?;
    super::cg_window::ensure_before_deadline(deadline)?;
    if records.len() > 1 {
        return Err(exact_window_source_error(
            "CoreGraphics returned multiple records for one exact window ID",
            window_number,
        ));
    }
    let record = records.pop();
    if record
        .as_ref()
        .is_some_and(|record| record.window_number != window_number)
    {
        return Err(exact_window_source_error(
            "CoreGraphics returned a different record for one exact window ID",
            window_number,
        ));
    }
    Ok(record)
}

/// The owner PID and CoreGraphics layer of one window, read for that window
/// alone and at any layer. `Ok(None)` means CoreGraphics has no such window.
pub(in crate::system) fn exact_window_owner_layer_until(
    window_number: i64,
    deadline: Instant,
) -> Result<Option<(i32, i64)>, AdapterError> {
    super::cg_window::ensure_before_deadline(deadline)?;
    let dictionaries = exact_window_dictionaries(window_number)?;
    super::cg_window::ensure_before_deadline(deadline)?;
    exact_owner_layer(
        window_number,
        dictionaries.iter().map(|dictionary| {
            let field = |key: &str| super::cg_window::int_field(dictionary, key);
            (
                field("kCGWindowNumber"),
                field("kCGWindowOwnerPID"),
                field("kCGWindowLayer"),
            )
        }),
    )
}

type ExactOwnerLayerFields = (Option<i64>, Option<i64>, Option<i64>);

fn exact_owner_layer(
    window_number: i64,
    mut fields: impl Iterator<Item = ExactOwnerLayerFields>,
) -> Result<Option<(i32, i64)>, AdapterError> {
    let Some((number, pid, layer)) = fields.next() else {
        return Ok(None);
    };
    let source_error = |message| Err(exact_window_source_error(message, window_number));
    if fields.next().is_some() {
        return source_error("CoreGraphics returned multiple records for one exact window ID");
    }
    if number != Some(window_number) {
        return source_error("CoreGraphics returned a different record for one exact window ID");
    }
    let (Some(pid), Some(layer)) = (pid.and_then(|pid| i32::try_from(pid).ok()), layer) else {
        return source_error("CoreGraphics omitted the owner or layer of one exact window ID");
    };
    Ok(Some((pid, layer)))
}

fn exact_window_dictionaries(window_number: i64) -> Result<Vec<WindowDictionary>, AdapterError> {
    let window_id = u32::try_from(window_number).map_err(|_| {
        exact_window_source_error("Window ID is outside the CoreGraphics range", window_number)
    })?;
    let requested = CFArray::from_copyable(&[window_id]);
    let descriptions =
        core_graphics::window::create_description_from_array(requested).ok_or_else(|| {
            exact_window_source_error(
                "CGWindowListCreateDescriptionFromArray returned null",
                window_number,
            )
        })?;
    Ok(descriptions.iter().map(|record| record.clone()).collect())
}

fn exact_window_source_error(message: &str, window_number: i64) -> AdapterError {
    super::cg_window::inventory_error(message).with_details(serde_json::json!({
        "kind": "exact_window_inventory_source",
        "source": "core_graphics_exact_window",
        "window_id": format!("w-{window_number}"),
        "complete": false,
        "retryable": true,
    }))
}

#[cfg(test)]
#[path = "cg_window_exact_tests.rs"]
mod tests;
