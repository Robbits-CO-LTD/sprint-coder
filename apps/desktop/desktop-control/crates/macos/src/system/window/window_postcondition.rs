// Changed by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
use agent_desktop_core::{AdapterError, Deadline, DeliverySemantics, Rect};

pub(crate) const TOLERANCE: f64 = 2.0;

pub(crate) fn wait_for_geometry(
    element: &crate::tree::AXElement,
    expected: Rect,
    position: bool,
    deadline: Deadline,
) -> Result<(), AdapterError> {
    wait_until(deadline, || {
        let bounds = crate::tree::element_bounds::read_bounds_with_deadline(
            element,
            deadline_instant(deadline)?,
        )?;
        Ok(bounds.is_some_and(|actual| geometry_matches(actual, expected, position)))
    })
}

pub(crate) fn wait_for_minimized(
    element: &crate::tree::AXElement,
    expected: bool,
    deadline: Deadline,
) -> Result<(), AdapterError> {
    wait_until(deadline, || {
        Ok(
            crate::tree::surface_read::boolean(
                element,
                "AXMinimized",
                deadline_instant(deadline)?,
            )? == Some(expected),
        )
    })
}

fn wait_until(
    deadline: Deadline,
    mut complete: impl FnMut() -> Result<bool, AdapterError>,
) -> Result<(), AdapterError> {
    loop {
        match complete() {
            Ok(true) => return Ok(()),
            Ok(false) => {}
            // While the app animates the change (a window going to the Dock, or coming back
            // from it), it answers a read with "cannot complete". The change was delivered and
            // is still happening, so that read is tried again until the deadline: measured on
            // macOS 27, a minimize and a restore each failed this way at the first read and
            // had happened by the time the window was listed again.
            Err(error) if app_is_busy(&error) && !deadline.is_expired() => {}
            Err(error) => return Err(after_delivery(error)),
        }
        if deadline.is_expired() {
            return Err(after_delivery(AdapterError::timeout(
                "Window operation did not reach its requested postcondition",
            )));
        }
        let pause = deadline
            .remaining_slice(std::time::Duration::from_millis(10))
            .map_err(after_delivery)?;
        std::thread::sleep(pause.min(std::time::Duration::from_millis(10)));
    }
}

/// Whether `error` is a read the app could not answer for now (`surface_read` marks an
/// accessibility "cannot complete" as retryable), as opposed to a read that says the element
/// is gone, the permission is missing, or the deadline has come.
fn app_is_busy(error: &AdapterError) -> bool {
    error
        .details
        .as_ref()
        .and_then(|details| details.get("retryable"))
        .and_then(serde_json::Value::as_bool)
        == Some(true)
}

fn geometry_matches(actual: Rect, expected: Rect, position: bool) -> bool {
    let values = if position {
        [(actual.x, expected.x), (actual.y, expected.y)]
    } else {
        [
            (actual.width, expected.width),
            (actual.height, expected.height),
        ]
    };
    values
        .into_iter()
        .all(|(actual, expected)| (actual - expected).abs() <= TOLERANCE)
}

fn deadline_instant(deadline: Deadline) -> Result<std::time::Instant, AdapterError> {
    std::time::Instant::now()
        .checked_add(deadline.remaining())
        .ok_or_else(|| AdapterError::internal("Window operation deadline is out of range"))
}

fn after_delivery(error: AdapterError) -> AdapterError {
    error.with_disposition(DeliverySemantics::delivered_unverified())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn busy() -> AdapterError {
        crate::tree::surface_read::map_error(
            "AXMinimized",
            accessibility_sys::kAXErrorCannotComplete,
        )
    }

    #[test]
    fn a_read_the_app_cannot_answer_while_it_animates_is_tried_again() {
        // Two reads fail while the window goes to the Dock; the third sees it minimized.
        let mut reads = 0;
        let result = wait_until(Deadline::after(2_000).unwrap(), || {
            reads += 1;
            if reads < 3 { Err(busy()) } else { Ok(true) }
        });
        assert!(result.is_ok());
        assert_eq!(reads, 3);
    }

    #[test]
    fn a_read_that_says_the_element_is_gone_ends_the_wait_at_once() {
        let mut reads = 0;
        let gone = || {
            crate::tree::surface_read::map_error(
                "AXMinimized",
                accessibility_sys::kAXErrorInvalidUIElement,
            )
        };
        let error = wait_until(Deadline::after(2_000).unwrap(), || {
            reads += 1;
            Err(gone())
        })
        .unwrap_err();
        assert_eq!(reads, 1);
        assert_eq!(error.code, agent_desktop_core::ErrorCode::ElementNotFound);
        assert_eq!(error.disposition, DeliverySemantics::delivered_unverified());
    }

    #[test]
    fn an_app_that_stays_busy_until_the_deadline_is_a_postcondition_timeout() {
        let error = wait_until(Deadline::after(60).unwrap(), || Err(busy())).unwrap_err();
        assert_eq!(error.code, agent_desktop_core::ErrorCode::Timeout);
        assert_eq!(error.disposition, DeliverySemantics::delivered_unverified());
    }

    #[test]
    fn geometry_verification_tolerates_ax_rounding_only() {
        let expected = Rect {
            x: 10.0,
            y: 20.0,
            width: 100.0,
            height: 80.0,
        };
        let rounded = Rect {
            x: 11.0,
            y: 19.0,
            width: 99.0,
            height: 81.0,
        };
        let wrong = Rect {
            width: 90.0,
            ..rounded
        };

        assert!(geometry_matches(rounded, expected, true));
        assert!(geometry_matches(rounded, expected, false));
        assert!(!geometry_matches(wrong, expected, false));
    }
}
