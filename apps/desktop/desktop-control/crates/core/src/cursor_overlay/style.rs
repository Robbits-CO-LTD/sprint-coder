// Changed by Sprint Coder; see VENDORED.md in apps/desktop/desktop-control.
use super::{CURSOR_IDLE_REST_MS, CursorImage, CursorImages};
use crate::{AdapterError, ErrorCode};
use serde::{Deserialize, Serialize};

const DEFAULT_RIM: &str = "#111318";
const DEFAULT_ACCENT: &str = "#4299FF";
const MIN_SIZE: f64 = 0.5;
const MAX_SIZE: f64 = 4.0;
/// The bounds of `linger_ms`. Bounded above so a cursor left over the user's
/// own windows always goes away by itself.
pub const MIN_CURSOR_LINGER_MS: u64 = 1_000;
pub const MAX_CURSOR_LINGER_MS: u64 = 120_000;

#[derive(Debug, Clone, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CursorOverlayStyle {
    /// The cursor body's colour; without one it takes the accent, so a single
    /// `--accent` colours the whole cursor.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    fill: Option<String>,
    #[serde(default = "default_rim")]
    rim: String,
    #[serde(default = "default_accent")]
    accent: String,
    #[serde(default = "default_size")]
    size: f64,
    #[serde(default = "enabled_effect")]
    ripple: bool,
    #[serde(default = "enabled_effect")]
    highlight: bool,
    #[serde(default, skip_serializing_if = "CursorImages::is_empty")]
    images: CursorImages,
    /// How long the cursor stays drawn after its last control before it
    /// rests (fades away). Without one, `CURSOR_IDLE_REST_MS`; left out of
    /// the wire then, so a style that never set it reads exactly as before.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    linger_ms: Option<u64>,
}

impl CursorOverlayStyle {
    pub fn take(&mut self) -> Self {
        std::mem::take(self)
    }

    pub fn validated(mut self) -> Result<Self, AdapterError> {
        for color in [self.fill.as_ref(), Some(&self.rim), Some(&self.accent)]
            .into_iter()
            .flatten()
        {
            rgb(color).ok_or_else(|| {
                AdapterError::new(
                    ErrorCode::InvalidArgs,
                    format!("Cursor overlay color '{color}' must be a hex value like #FFFFFF"),
                )
            })?;
        }
        if !(MIN_SIZE..=MAX_SIZE).contains(&self.size) {
            return Err(AdapterError::new(
                ErrorCode::InvalidArgs,
                format!("Cursor overlay size must be between {MIN_SIZE} and {MAX_SIZE}"),
            ));
        }
        if let Some(linger_ms) = self.linger_ms {
            if !(MIN_CURSOR_LINGER_MS..=MAX_CURSOR_LINGER_MS).contains(&linger_ms) {
                return Err(AdapterError::new(
                    ErrorCode::InvalidArgs,
                    format!(
                        "Cursor overlay linger must be between {MIN_CURSOR_LINGER_MS} and {MAX_CURSOR_LINGER_MS} ms"
                    ),
                ));
            }
        }
        self.images = std::mem::take(&mut self.images).validated()?;
        Ok(self)
    }

    pub fn set_linger_ms(&mut self, linger_ms: Option<u64>) {
        self.linger_ms = linger_ms;
    }

    pub const fn linger_ms(&self) -> Option<u64> {
        self.linger_ms
    }

    /// How long the overlay stays drawn with no control before it rests.
    pub fn rest_after_ms(&self) -> u64 {
        self.linger_ms.unwrap_or(CURSOR_IDLE_REST_MS)
    }

    pub fn set_fill(&mut self, fill: String) {
        self.fill = Some(fill);
    }

    pub fn set_rim(&mut self, rim: String) {
        self.rim = rim;
    }

    pub fn set_accent(&mut self, accent: String) {
        self.accent = accent;
    }

    pub fn set_size(&mut self, size: f64) {
        self.size = size;
    }

    pub fn set_effects(&mut self, ripple: bool, highlight: bool) {
        self.ripple = ripple;
        self.highlight = highlight;
    }

    pub fn set_image(&mut self, image: Option<CursorImage>) {
        self.images.set_arrow(image);
    }

    pub fn set_pointer_image(&mut self, image: Option<CursorImage>) {
        self.images.set_pointer(image);
    }

    pub const fn image(&self) -> Option<&CursorImage> {
        self.images.arrow()
    }

    pub const fn pointer_image(&self) -> Option<&CursorImage> {
        self.images.pointer()
    }

    pub const fn images(&self) -> &CursorImages {
        &self.images
    }

    pub fn fill_rgb(&self) -> [f64; 3] {
        self.fill
            .as_deref()
            .and_then(rgb)
            .unwrap_or_else(|| self.accent_rgb())
    }

    pub fn rim_rgb(&self) -> [f64; 3] {
        rgb(&self.rim).unwrap_or([0.07, 0.07, 0.09])
    }

    pub fn accent_rgb(&self) -> [f64; 3] {
        rgb(&self.accent).unwrap_or([0.26, 0.60, 1.0])
    }

    pub const fn size(&self) -> f64 {
        self.size
    }

    pub const fn ripple(&self) -> bool {
        self.ripple
    }

    pub const fn highlight(&self) -> bool {
        self.highlight
    }
}

impl Default for CursorOverlayStyle {
    fn default() -> Self {
        Self {
            fill: None,
            rim: default_rim(),
            accent: default_accent(),
            size: default_size(),
            ripple: true,
            highlight: true,
            images: CursorImages::default(),
            linger_ms: None,
        }
    }
}

fn default_rim() -> String {
    DEFAULT_RIM.into()
}

fn default_accent() -> String {
    DEFAULT_ACCENT.into()
}

const fn default_size() -> f64 {
    1.0
}

const fn enabled_effect() -> bool {
    true
}

fn rgb(value: &str) -> Option<[f64; 3]> {
    let digits = value.strip_prefix('#').unwrap_or(value);
    let expanded = match digits.len() {
        3 => digits.chars().flat_map(|c| [c, c]).collect::<String>(),
        6 => digits.to_owned(),
        _ => return None,
    };
    let channel = |index: usize| {
        u8::from_str_radix(expanded.get(index..index + 2)?, 16)
            .ok()
            .map(|byte| f64::from(byte) / 255.0)
    };
    Some([channel(0)?, channel(2)?, channel(4)?])
}

#[cfg(test)]
#[path = "style_tests.rs"]
mod tests;
