// Changed by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
use crate::{AppError, RefEntry};

/// The most ancestors an entry may record: a whole-window walk descends at most
/// 50 levels, so a longer list was never written by a capture.
pub const MAX_RECORDED_ANCESTORS: usize = 64;

/// The most parts a recorded runtime identifier may have (providers use a
/// handful: a kind marker, a window or process part, a node number).
const MAX_RUNTIME_ID_PARTS: usize = 32;

pub(crate) fn validate_ref_entry(entry: &RefEntry) -> Result<(), AppError> {
    const MAX_FIELD_BYTES: usize = 65_536;
    const MAX_PATH_DEPTH: usize = 256;
    if entry.process.pid.get() == 0
        || entry
            .process
            .process_instance
            .as_deref()
            .is_none_or(str::is_empty)
    {
        return Err(AppError::invalid_input(
            "RefEntry requires a positive pid and process instance",
        ));
    }
    if !crate::Role::is_canonical(&entry.identity.role) || entry.identity.role == "unknown" {
        return Err(AppError::invalid_input("RefEntry contains an invalid role"));
    }
    for field in [
        entry.identity.name.as_deref(),
        entry.identity.value.as_deref(),
        entry.identity.description.as_deref(),
        entry.source.source_app.as_deref(),
        entry.source.source_window_id.as_deref(),
        entry.source.source_window_title.as_deref(),
        entry.process.process_instance.as_deref(),
    ]
    .into_iter()
    .flatten()
    {
        if field.len() > MAX_FIELD_BYTES {
            return Err(AppError::invalid_input(
                "RefEntry string evidence exceeds the field limit",
            ));
        }
    }
    if let Some(identifier) = &entry.identity.native_id
        && (identifier.value.trim().is_empty()
            || identifier.value.len() > MAX_FIELD_BYTES
            || identifier.kind == crate::IdentifierKind::Unknown)
    {
        return Err(AppError::invalid_input(
            "RefEntry contains invalid typed identifier evidence",
        ));
    }
    let view = entry.identity.in_view.as_ref();
    if view.is_some_and(|view| {
        view.path.len() > MAX_PATH_DEPTH
            || view.bounds.validate().is_err()
            || view.bounds.width <= 0.0
            || view.bounds.height <= 0.0
            || view.runtime_id.is_empty()
            || view.runtime_id.len() > MAX_RUNTIME_ID_PARTS
    }) {
        return Err(AppError::invalid_input(
            "RefEntry view proof exceeds its limit",
        ));
    }
    let recorded = [
        Some(entry.identity.ancestors.as_slice()),
        view.map(|view| view.ancestors.as_slice()),
    ];
    for ancestors in recorded.into_iter().flatten() {
        validate_ancestors(ancestors)?;
    }
    if entry.scope.path.len() > MAX_PATH_DEPTH {
        return Err(AppError::invalid_input("RefEntry path is too deep"));
    }
    crate::refs::ref_menu::validate_menu_proof(entry)?;
    validate_rest(entry)
}

fn validate_ancestors(ancestors: &[crate::RefAncestorIdentity]) -> Result<(), AppError> {
    const MAX_FIELD_BYTES: usize = 65_536;
    if ancestors.len() > MAX_RECORDED_ANCESTORS
        || ancestors.iter().any(|ancestor| {
            ancestor.role.trim().is_empty()
                || ancestor.role.len() > 256
                || [ancestor.name.as_deref(), ancestor.description.as_deref()]
                    .into_iter()
                    .flatten()
                    .any(|field| field.len() > MAX_FIELD_BYTES)
                || ancestor.native_id.as_ref().is_some_and(|identifier| {
                    identifier.value.trim().is_empty()
                        || identifier.value.len() > MAX_FIELD_BYTES
                        || identifier.kind == crate::IdentifierKind::Unknown
                })
        })
    {
        return Err(AppError::invalid_input(
            "RefEntry ancestor evidence exceeds its limit",
        ));
    }
    Ok(())
}

fn validate_rest(entry: &RefEntry) -> Result<(), AppError> {
    if let Some(bounds) = entry.geometry.bounds {
        bounds.validate()?;
        if entry.geometry.bounds_hash != bounds.bounds_hash() {
            return Err(AppError::invalid_input(
                "RefEntry bounds hash does not match its geometry",
            ));
        }
    }
    if entry.capabilities.states.len() > 256
        || entry.capabilities.available_actions.len() > 256
        || entry
            .capabilities
            .states
            .iter()
            .chain(entry.capabilities.available_actions.iter())
            .any(|value| value.len() > 256)
    {
        return Err(AppError::invalid_input(
            "RefEntry state or action evidence exceeds its limit",
        ));
    }
    Ok(())
}
