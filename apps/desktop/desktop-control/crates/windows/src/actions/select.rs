// Changed by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
//! SelectionItemPattern select with bounded descendant search (A19-7).
//!
//! Self-match uses SelectionItem on the target; an empty value means the
//! target item itself. A standard Win32 combo box (or an item of its list) is
//! chosen through `win32_combo`, which tells the box's owner of the change.
//! Otherwise a container that publishes ItemContainer is asked for the named
//! item first, and the item is selected without opening the list; failing
//! that, a walker DFS finds a named SelectionItem. Collapsed ExpandCollapse
//! containers expand first and best-effort collapse after failure; after a
//! successful select an open combo-box list is closed and the close is
//! recorded as its own step. Descendant search always scroll-to-realizes
//! (A18-1), re-searching after every scroll step and retaining the first match
//! so an intermediate or below-fold duplicate still surfaces as
//! AMBIGUOUS_TARGET. Container Value verification routes through the
//! IsPassword-gated value helpers.

use agent_desktop_core::{ActionStep, AdapterError, Deadline, ErrorCode};
use std::cell::{Cell, RefCell};
use std::time::{Duration, Instant};

use crate::actions::chain::{DeliveryOutcome, build_step};
use crate::tree::element::UIAElement;

pub(crate) const SELECT_LABEL: &str = "SelectionItemPattern.Select";

const VERIFY_TIMEOUT: Duration = Duration::from_millis(600);
const POLL_SLICE: Duration = Duration::from_millis(25);

/// Pure verification precedence: container Value outranks `is_selected` when
/// the gate produced a comparison; withheld / absent Value falls back.
pub(crate) fn resolve_select_verification(
    container_value: Option<Option<bool>>,
    is_selected: Option<bool>,
) -> Option<bool> {
    match container_value {
        Some(Some(matched)) => Some(matched),
        Some(None) | None => is_selected,
    }
}

/// Injected select plan flags — unit-test seam and live path.
pub(crate) struct SelectPlan {
    pub(crate) self_match: bool,
    pub(crate) needs_expand: bool,
    pub(crate) value_chars: usize,
}

/// Test-only call-order recorder shared by `select_tests.rs` and
/// `select_flow_tests.rs`: appends `label` to the `Cell`-held order vec
/// without each call site repeating the take/push/set dance.
#[cfg(test)]
pub(crate) fn push_order(order: &Cell<Vec<&'static str>>, label: &'static str) {
    let mut recorded = order.take();
    recorded.push(label);
    order.set(recorded);
}

/// Injected select operations — unit-test seam and live path.
pub(crate) struct SelectOps<'a> {
    pub(crate) expand: &'a mut dyn FnMut() -> Result<(), AdapterError>,
    pub(crate) collapse: &'a mut dyn FnMut(),
    pub(crate) find: &'a mut dyn FnMut() -> Result<bool, AdapterError>,
    pub(crate) realize: &'a mut dyn FnMut() -> Result<(), AdapterError>,
    pub(crate) select_item: &'a mut dyn FnMut() -> Result<DeliveryOutcome, AdapterError>,
}

#[cfg(target_os = "windows")]
mod imp {
    use super::{
        ActionStep, AdapterError, Cell, Deadline, DeliveryOutcome, ErrorCode, Instant, POLL_SLICE,
        RefCell, SELECT_LABEL, SelectOps, SelectPlan, UIAElement, VERIFY_TIMEOUT, build_step,
        resolve_select_verification,
    };
    use crate::actions::chain::{after_delivery, capped_verification_end};
    use crate::actions::disclosure::{COLLAPSE_LABEL, EXPAND_LABEL, ExpandKind};
    use crate::actions::mutation::{classify_success, classify_write};
    use crate::actions::select_search::{
        find_listed_item, find_named_selection_item, name_matches, scroll_to_realize,
        selection_item_available,
    };
    use crate::actions::value_write::gated_pattern_value_equals;
    use crate::actions::win32_combo::{WIN32_COMBO_SELECT_LABEL, owning_combo};
    use crate::tree::automation::automation_client;
    use crate::tree::properties::property_ids::TreeProperty;
    use crate::tree::properties::read_one;
    use crate::tree::walk::walker_source::parent_step;
    use agent_desktop_core::{DeliverySemantics, LocatorField};
    use uiautomation::patterns::{UIExpandCollapsePattern, UISelectionItemPattern};
    use windows::Win32::UI::Accessibility::UIA_ComboBoxControlTypeId;

    /// Ancestors searched for the combo box an item's list belongs to.
    const MAX_LIST_CLIMB: usize = 3;
    const CLOSE_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(200);

    pub(crate) fn select_steps(
        element: &UIAElement,
        value: &str,
        deadline: Deadline,
    ) -> Result<Vec<ActionStep>, AdapterError> {
        let is_item = selection_item_available(element);
        if value.is_empty() && !is_item {
            return Err(value_required_error());
        }
        if let Some(steps) = win32_combo_select(element, value, deadline)? {
            return Ok(steps);
        }
        let self_match = is_item && (value.is_empty() || name_matches(element, value));
        let listed = if self_match {
            None
        } else {
            find_listed_item(element, value, deadline)?
        };
        let needs_expand = listed.is_none() && is_collapsed_container(element);
        let expanded = Cell::new(false);
        let mut expand = || {
            deadline.ensure_remaining()?;
            expand_container(element)?;
            expanded.set(true);
            Ok(())
        };
        let mut collapse = || {
            if expanded.get() {
                let _ = collapse_container(element);
            }
        };
        let pre_found = self_match || listed.is_some();
        let found_holder = RefCell::new(if self_match {
            Some(element.clone())
        } else {
            listed
        });
        let mut find = || {
            let prior = found_holder.borrow().clone();
            match find_named_selection_item(element, value, deadline, prior.as_ref())? {
                Some(found) => {
                    *found_holder.borrow_mut() = Some(found);
                    Ok(true)
                }
                None => Ok(false),
            }
        };
        let mut realize = || {
            deadline.ensure_remaining()?;
            scroll_to_realize(element, deadline, || {
                let prior = found_holder.borrow().clone();
                if let Some(found) =
                    find_named_selection_item(element, value, deadline, prior.as_ref())?
                {
                    *found_holder.borrow_mut() = Some(found);
                }
                Ok(())
            })
        };
        let mut select_item = || {
            let borrowed = found_holder.borrow();
            let target = borrowed
                .as_ref()
                .ok_or_else(|| not_found_chars(value.chars().count()))?;
            delivered_select(element, target, value, deadline)
        };
        let mut steps = select_judged_for(
            deadline,
            SelectPlan {
                // An item the container's ItemContainer provider already
                // named is selected directly, like a self-match.
                self_match: pre_found,
                needs_expand,
                value_chars: value.chars().count(),
            },
            SelectOps {
                expand: &mut expand,
                collapse: &mut collapse,
                find: &mut find,
                realize: &mut realize,
                select_item: &mut select_item,
            },
        )?;
        if let Some(step) = close_open_list(element, deadline) {
            steps.push(step);
        }
        Ok(steps)
    }

    /// Chooses the item in the standard Win32 combo box `element` is, or
    /// belongs to. `None` when there is no such box, or the box keeps no item
    /// text, so the caller goes on with UI Automation. An empty `value` means
    /// the item `element` itself.
    pub(crate) fn win32_combo_select(
        element: &UIAElement,
        value: &str,
        deadline: Deadline,
    ) -> Result<Option<Vec<ActionStep>>, AdapterError> {
        let Some(combo) = owning_combo(element, deadline)? else {
            return Ok(None);
        };
        let text = if value.is_empty() {
            match read_one(element, TreeProperty::Name).text() {
                LocatorField::Known(name) if !name.is_empty() => name,
                _ => return Ok(None),
            }
        } else {
            value.to_owned()
        };
        Ok(combo
            .select_text(&text, deadline)?
            .map(|outcome| vec![build_step(WIN32_COMBO_SELECT_LABEL, outcome)]))
    }

    /// Closes the combo box list `element` is, or whose item it is, when that
    /// list is open. The close is reported as a step whose verification is
    /// the list's state afterwards; `None` when no open combo-box list is
    /// involved.
    fn close_open_list(element: &UIAElement, deadline: Deadline) -> Option<ActionStep> {
        let combo = open_combo_box(element, deadline)?;
        let delivered = matches!(collapse_container(&combo), Ok(true));
        let closed = delivered && poll_collapsed(&combo, deadline);
        Some(build_step(
            COLLAPSE_LABEL,
            DeliveryOutcome::from_delivery(delivered, closed),
        ))
    }

    fn open_combo_box(element: &UIAElement, deadline: Deadline) -> Option<UIAElement> {
        let walker = automation_client().ok()?.get_raw_view_walker().ok()?;
        let mut current = element.clone();
        for _ in 0..=MAX_LIST_CLIMB {
            if deadline.is_expired() {
                return None;
            }
            if is_combo_box(&current) {
                return is_expanded(&current).then_some(current);
            }
            current = parent_step(&walker, &current).ok().flatten()?;
        }
        None
    }

    fn is_combo_box(element: &UIAElement) -> bool {
        read_one(element, TreeProperty::ControlType).number() == Some(UIA_ComboBoxControlTypeId.0)
    }

    fn is_expanded(element: &UIAElement) -> bool {
        read_expand_kind(element) == Some(ExpandKind::Expanded)
    }

    fn read_expand_kind(element: &UIAElement) -> Option<ExpandKind> {
        if read_one(element, TreeProperty::ExpandCollapseAvailable).flag() != Some(true) {
            return None;
        }
        read_one(element, TreeProperty::ExpandCollapseState)
            .number()
            .and_then(ExpandKind::from_i32)
    }

    fn poll_collapsed(element: &UIAElement, deadline: Deadline) -> bool {
        let Ok(end) = capped_verification_end(deadline, CLOSE_TIMEOUT) else {
            return false;
        };
        loop {
            if read_expand_kind(element) == Some(ExpandKind::Collapsed) {
                return true;
            }
            if Instant::now() >= end {
                return false;
            }
            match deadline.remaining_slice(POLL_SLICE) {
                Ok(slice) => std::thread::sleep(slice),
                Err(_) => return false,
            }
        }
    }

    fn value_required_error() -> AdapterError {
        AdapterError::new(
            ErrorCode::InvalidArgs,
            "select needs the name of the item to choose when the ref is a list or combo box",
        )
        .with_disposition(DeliverySemantics::not_delivered())
        .with_suggestion(
            "Pass the item's name: select <list or combo box ref> <item name>. \
             To choose an item by its own ref, pass that item's ref with no name: select <item ref>.",
        )
    }

    pub(crate) fn select_judged_for(
        deadline: Deadline,
        plan: SelectPlan,
        ops: SelectOps<'_>,
    ) -> Result<Vec<ActionStep>, AdapterError> {
        deadline.ensure_remaining()?;
        if plan.self_match {
            return match (ops.select_item)() {
                Ok(outcome) => Ok(vec![build_step(SELECT_LABEL, outcome)]),
                Err(error) => {
                    (ops.collapse)();
                    Err(error)
                }
            };
        }
        if plan.needs_expand {
            (ops.expand)()?;
        }
        let _ = (ops.find)().inspect_err(|_| (ops.collapse)())?;
        (ops.realize)().inspect_err(|_| (ops.collapse)())?;
        let found = (ops.find)().inspect_err(|_| (ops.collapse)())?;
        if !found {
            (ops.collapse)();
            return Err(not_found_chars(plan.value_chars));
        }
        match (ops.select_item)() {
            Ok(outcome) => Ok(vec![build_step(SELECT_LABEL, outcome)]),
            Err(error) => {
                (ops.collapse)();
                Err(error)
            }
        }
    }

    fn delivered_select(
        container: &UIAElement,
        target: &UIAElement,
        value: &str,
        deadline: Deadline,
    ) -> Result<DeliveryOutcome, AdapterError> {
        let delivered = match target.0.get_pattern::<UISelectionItemPattern>() {
            Ok(pattern) => match pattern.select() {
                Ok(()) => classify_success()?,
                Err(error) => classify_write("Select", SELECT_LABEL, &error)?,
            },
            Err(error) => classify_write("get_pattern", SELECT_LABEL, &error)?,
        };
        if !delivered {
            return Ok(DeliveryOutcome::NotDelivered);
        }
        let verified = poll_verified(container, target, value, deadline).map_err(after_delivery)?;
        Ok(DeliveryOutcome::from_observation(verified))
    }

    /// Reads container `ValueAvailable` once before the loop rather than on
    /// every tick: it cannot legitimately flip mid-verification, so
    /// re-checking it every 25ms bought nothing.
    fn poll_verified(
        container: &UIAElement,
        target: &UIAElement,
        value: &str,
        deadline: Deadline,
    ) -> Result<Option<bool>, AdapterError> {
        deadline.ensure_remaining()?;
        let end = capped_verification_end(deadline, VERIFY_TIMEOUT)?;
        // An empty value selects the target itself; there is no requested
        // text for the container to hold.
        let container_value_available = !value.is_empty() && value_available(container);
        loop {
            let verified = verify_once(container, target, value, container_value_available)?;
            if verified == Some(true) {
                return Ok(Some(true));
            }
            if Instant::now() >= end {
                return Ok(verified);
            }
            std::thread::sleep(deadline.remaining_slice(POLL_SLICE)?);
        }
    }

    fn verify_once(
        container: &UIAElement,
        target: &UIAElement,
        value: &str,
        container_value_available: bool,
    ) -> Result<Option<bool>, AdapterError> {
        let container_value = if container_value_available {
            Some(gated_pattern_value_equals(container, value)?)
        } else {
            None
        };
        let selected = read_one(target, TreeProperty::SelectionItemIsSelected).flag();
        Ok(resolve_select_verification(container_value, selected))
    }

    fn expand_container(element: &UIAElement) -> Result<(), AdapterError> {
        match element.0.get_pattern::<UIExpandCollapsePattern>() {
            Ok(pattern) => match pattern.expand() {
                Ok(()) => Ok(()),
                Err(error) => {
                    let _ = classify_write("Expand", EXPAND_LABEL, &error)?;
                    Ok(())
                }
            },
            Err(error) => {
                let _ = classify_write("get_pattern", EXPAND_LABEL, &error)?;
                Ok(())
            }
        }
    }

    /// Best-effort collapse; `Ok(true)` when the provider accepted it.
    fn collapse_container(element: &UIAElement) -> Result<bool, AdapterError> {
        match element.0.get_pattern::<UIExpandCollapsePattern>() {
            Ok(pattern) => Ok(pattern.collapse().is_ok()),
            Err(_) => Ok(false),
        }
    }

    fn is_collapsed_container(element: &UIAElement) -> bool {
        if read_one(element, TreeProperty::ExpandCollapseAvailable).flag() != Some(true) {
            return false;
        }
        matches!(
            read_one(element, TreeProperty::ExpandCollapseState)
                .number()
                .and_then(ExpandKind::from_i32),
            Some(ExpandKind::Collapsed)
        )
    }

    fn value_available(element: &UIAElement) -> bool {
        read_one(element, TreeProperty::ValueAvailable).flag() == Some(true)
    }

    fn not_found_chars(chars: usize) -> AdapterError {
        AdapterError::new(
            ErrorCode::ElementNotFound,
            format!("No selection item matched the requested value ({chars} chars)"),
        )
        .with_disposition(DeliverySemantics::not_delivered())
        .with_suggestion("Use find or snapshot to inspect the available selection items.")
    }
}

#[cfg(not(target_os = "windows"))]
mod imp {
    use super::{ActionStep, AdapterError, Deadline, SelectOps, SelectPlan, UIAElement};

    pub(crate) fn select_steps(
        _element: &UIAElement,
        _value: &str,
        _deadline: Deadline,
    ) -> Result<Vec<ActionStep>, AdapterError> {
        Err(AdapterError::not_supported("Select"))
    }

    pub(crate) fn select_judged_for(
        _deadline: Deadline,
        _plan: SelectPlan,
        _ops: SelectOps<'_>,
    ) -> Result<Vec<ActionStep>, AdapterError> {
        Err(AdapterError::not_supported("Select"))
    }
}

pub(crate) use imp::select_steps;

#[cfg(target_os = "windows")]
pub(crate) use imp::win32_combo_select;

#[cfg(all(test, target_os = "windows"))]
pub(crate) use imp::select_judged_for;

#[cfg(all(test, target_os = "windows"))]
#[path = "select_tests.rs"]
mod tests;

#[cfg(all(test, target_os = "windows"))]
#[path = "select_flow_tests.rs"]
mod flow_tests;
