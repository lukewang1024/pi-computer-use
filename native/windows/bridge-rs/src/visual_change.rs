//! Bounded visual evidence, never an application-effect acknowledgement.
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::Value;

pub const MAX_SAMPLES: u32 = 6;
pub const SOFT_DEADLINE_MS: u128 = 2500;

pub fn followup_status(
    changed: Option<bool>,
    samples: u32,
    elapsed_ms: u128,
) -> Option<&'static str> {
    match changed {
        Some(true) => Some("change_observed"),
        None => Some("incomparable"),
        Some(false) if samples >= MAX_SAMPLES || elapsed_ms >= SOFT_DEADLINE_MS => {
            Some("unchanged_at_limit")
        }
        Some(false) => None,
    }
}

#[derive(Clone, Debug)]
pub struct VisualSample {
    width: u32,
    height: u32,
    pixels: Vec<u8>,
    bounds: (i32, i32, i32, i32),
    cursor: Option<(i32, i32)>,
}

impl VisualSample {
    /// Private sample from the native source bitmap, before output resizing.
    pub fn source_value(
        pixels: &[u8],
        width: u32,
        height: u32,
        bounds: (i32, i32, i32, i32),
    ) -> Option<Value> {
        if width == 0
            || height == 0
            || (width as usize)
                .checked_mul(height as usize)?
                .checked_mul(4)?
                != pixels.len()
        {
            return None;
        }
        let source = image::RgbaImage::from_raw(width, height, pixels.to_vec())?;
        let scale = 512.0 / f64::from(width.max(height));
        let (w, h) = if scale < 1.0 {
            (
                (f64::from(width) * scale).round().max(1.0) as u32,
                (f64::from(height) * scale).round().max(1.0) as u32,
            )
        } else {
            (width, height)
        };
        let resized = image::imageops::resize(&source, w, h, image::imageops::FilterType::Triangle);
        Some(
            serde_json::json!({"width":w,"height":h,"rgbaBase64":STANDARD.encode(resized.as_raw()),
            "sourceBounds":{"x":bounds.0,"y":bounds.1,"width":bounds.2,"height":bounds.3}}),
        )
    }

    pub fn from_shot(shot: &Value, cursor: &Value) -> Option<Self> {
        let private = shot.get("visualSource").filter(|value| value.is_object());
        let c = private.or_else(|| shot.get("capture"))?;
        let width = u32::try_from(c.get("width")?.as_u64()?).ok()?;
        let height = u32::try_from(c.get("height")?.as_u64()?).ok()?;
        if width == 0 || height == 0 || u64::from(width) * u64::from(height) > 4_000_000 {
            return None;
        }
        let pixels = if private.is_some() {
            if width > 512 || height > 512 {
                return None;
            }
            let bytes = STANDARD.decode(c.get("rgbaBase64")?.as_str()?).ok()?;
            if bytes.len() != (width as usize) * (height as usize) * 4 {
                return None;
            }
            bytes
        } else {
            let bytes = STANDARD.decode(c.get("imageBase64")?.as_str()?).ok()?;
            let image = image::load_from_memory(&bytes).ok()?.into_rgba8();
            if image.dimensions() != (width, height) {
                return None;
            }
            image.into_raw()
        };
        let b = c.get("sourceBounds")?;
        let bounds = (
            i32::try_from(b.get("x")?.as_i64()?).ok()?,
            i32::try_from(b.get("y")?.as_i64()?).ok()?,
            i32::try_from(b.get("width")?.as_i64()?).ok()?,
            i32::try_from(b.get("height")?.as_i64()?).ok()?,
        );
        if bounds.2 <= 0 || bounds.3 <= 0 {
            return None;
        }
        let cursor = if cursor.get("visible")?.as_bool()? {
            Some((
                i32::try_from(cursor.get("x")?.as_i64()?).ok()?,
                i32::try_from(cursor.get("y")?.as_i64()?).ok()?,
            ))
        } else {
            None
        };
        Some(Self {
            width,
            height,
            pixels,
            bounds,
            cursor,
        })
    }

    fn cursor_masks(&self, x: u32, y: u32) -> bool {
        let Some((cx, cy)) = self.cursor else {
            return false;
        };
        let sx =
            self.bounds.0 as f64 + f64::from(x) * f64::from(self.bounds.2) / f64::from(self.width);
        let sy =
            self.bounds.1 as f64 + f64::from(y) * f64::from(self.bounds.3) / f64::from(self.height);
        // Conservative union of both samples' synthetic cursor footprints.
        (sx - f64::from(cx)).abs() <= 64.0 && (sy - f64::from(cy)).abs() <= 64.0
    }

    /// None means incomparable geometry. Small/caret-only changes are ignored.
    /// A true value is visual evidence only, not proof of text or paint readiness.
    pub fn changed_from(&self, before: &Self) -> Option<bool> {
        self.changed_near(before, None)
    }

    pub fn changed_near(&self, before: &Self, anchor: Option<(f64, f64)>) -> Option<bool> {
        if (self.width, self.height, self.bounds) != (before.width, before.height, before.bounds) {
            return None;
        }
        let mut tiles = [false; 32 * 18];
        let mut count = 0;
        for y in 0..self.height {
            for x in 0..self.width {
                if let Some((ax, ay)) = anchor {
                    let sx = self.bounds.0 as f64
                        + f64::from(x) * f64::from(self.bounds.2) / f64::from(self.width);
                    let sy = self.bounds.1 as f64
                        + f64::from(y) * f64::from(self.bounds.3) / f64::from(self.height);
                    if (sx - ax).abs() > 768.0 || (sy - ay).abs() > 96.0 {
                        continue;
                    }
                }
                if self.cursor_masks(x, y) || before.cursor_masks(x, y) {
                    continue;
                }
                let offset = ((y * self.width + x) * 4) as usize;
                if (0..3).any(|c| self.pixels[offset + c].abs_diff(before.pixels[offset + c]) > 32)
                {
                    count += 1;
                    tiles[((y * 18 / self.height) * 32 + x * 32 / self.width) as usize] = true;
                }
            }
        }
        Some(count >= 64 && tiles.iter().filter(|t| **t).count() >= 3)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn blank() -> VisualSample {
        VisualSample {
            width: 320,
            height: 180,
            pixels: vec![255; 320 * 180 * 4],
            bounds: (0, 0, 320, 180),
            cursor: None,
        }
    }
    fn ink(s: &mut VisualSample, x: u32, y: u32, w: u32, h: u32) {
        for row in y..y + h {
            for col in x..x + w {
                let i = ((row * 320 + col) * 4) as usize;
                s.pixels[i..i + 3].fill(0);
            }
        }
    }
    #[test]
    fn unchanged_caret_cursor_and_geometry_are_not_content_evidence() {
        let a = blank();
        let mut b = a.clone();
        assert_eq!(b.changed_from(&a), Some(false));
        ink(&mut b, 20, 20, 1, 18);
        assert_eq!(b.changed_from(&a), Some(false));
        b = a.clone();
        b.cursor = Some((100, 80));
        ink(&mut b, 80, 60, 40, 40);
        assert_eq!(b.changed_from(&a), Some(false));
        assert_eq!(a.changed_from(&b), Some(false));
        b.bounds.0 = 1;
        assert_eq!(b.changed_from(&a), None);
    }
    #[test]
    fn distributed_change_is_observed_but_small_change_is_not() {
        let a = blank();
        let mut b = a.clone();
        ink(&mut b, 180, 50, 45, 8);
        assert_eq!(b.changed_from(&a), Some(true));
        b = a.clone();
        ink(&mut b, 180, 50, 2, 2);
        assert_eq!(b.changed_from(&a), Some(false));
    }

    #[test]
    fn delayed_change_no_change_and_deadline_are_bounded() {
        assert_eq!(followup_status(Some(false), 1, 10), None);
        assert_eq!(followup_status(Some(false), 2, 200), None);
        assert_eq!(followup_status(Some(true), 3, 400), Some("change_observed"));
        assert_eq!(
            followup_status(Some(false), 6, 600),
            Some("unchanged_at_limit")
        );
        assert_eq!(
            followup_status(Some(false), 1, 2500),
            Some("unchanged_at_limit")
        );
        assert_eq!(followup_status(None, 1, 10), Some("incomparable"));
    }

    #[test]
    fn malformed_or_mismatched_image_is_not_visual_evidence() {
        let cursor = serde_json::json!({"visible":false});
        assert!(VisualSample::from_shot(&serde_json::json!({}), &cursor).is_none());
        let shot = serde_json::json!({"capture":{"width":1,"height":1,"imageBase64":"bad"}});
        assert!(VisualSample::from_shot(&shot, &cursor).is_none());
        let large = serde_json::json!({"capture":{"width":16384,"height":16384}});
        assert!(VisualSample::from_shot(&large, &cursor).is_none());
    }
    #[test]
    fn toolbar_changes_outside_input_band_do_not_signal_editor_change() {
        let a = blank();
        let mut b = a.clone();
        ink(&mut b, 20, 0, 100, 8);
        assert_eq!(b.changed_near(&a, Some((180.0, 150.0))), Some(false));
        ink(&mut b, 180, 140, 45, 8);
        assert_eq!(b.changed_near(&a, Some((180.0, 150.0))), Some(true));
    }
    #[test]
    fn source_sample_does_not_depend_on_transport_image_dimensions() {
        let a = blank();
        let value = VisualSample::source_value(&a.pixels, a.width, a.height, a.bounds).unwrap();
        let cursor = serde_json::json!({"visible":false});
        let mut shot =
            serde_json::json!({"visualSource":value,"capture":{"width":1600,"height":860}});
        let before = VisualSample::from_shot(&shot, &cursor).unwrap();
        shot["capture"] = serde_json::json!({"width":900,"height":484});
        let after = VisualSample::from_shot(&shot, &cursor).unwrap();
        assert_eq!(after.changed_from(&before), Some(false));
        shot["visualSource"]["rgbaBase64"] = serde_json::json!("bad");
        assert!(VisualSample::from_shot(&shot, &cursor).is_none());
        assert!(VisualSample::source_value(&[], 320, 180, a.bounds).is_none());
    }
}
