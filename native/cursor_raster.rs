// Shared premultiplied ARGB artwork for the Windows and X11 overlays.
// Compile the design into the helper; no runtime file or network dependency.
use serde::Deserialize;
#[derive(Deserialize)]
struct Layer {
    color: String,
    points: Vec<[f64; 2]>,
}
#[derive(Deserialize)]
struct Stop {
    offset: f64,
    color: String,
    opacity: f64,
}
#[derive(Deserialize)]
struct Glow {
    radius: f64,
    center: [f64; 2],
    padding: usize,
    stops: Vec<Stop>,
}
#[derive(Deserialize)]
struct Style {
    width: usize,
    height: usize,
    hotspot: [i32; 2],
    layers: Vec<Layer>,
    glow: Glow,
}
pub struct Raster {
    pub width: u16,
    pub height: u16,
    pub hotspot: [i32; 2],
    pub pixels: Vec<u32>,
}
fn rgb(color: &str) -> [f64; 3] {
    let value = u32::from_str_radix(&color[1..], 16).expect("cursor color");
    [
        ((value >> 16) & 255) as f64,
        ((value >> 8) & 255) as f64,
        (value & 255) as f64,
    ]
}
fn inside(points: &[[f64; 2]], x: f64, y: f64) -> bool {
    let mut result = false;
    let mut previous = points.last().unwrap();
    for point in points {
        if (point[1] > y) != (previous[1] > y)
            && x < (previous[0] - point[0]) * (y - point[1]) / (previous[1] - point[1]) + point[0]
        {
            result = !result;
        }
        previous = point;
    }
    result
}
pub fn render(glow: bool) -> Raster {
    let style: Style = serde_json::from_str(include_str!("../src/agent-cursor-style.json"))
        .expect("cursor design");
    let pad = if glow { style.glow.padding } else { 0 };
    let width = style.width + 2 * pad;
    let height = style.height + 2 * pad;
    let mut pixels = Vec::with_capacity(width * height);
    for y in 0..height {
        for x in 0..width {
            let mut channels = [0.0; 4];
            // Supersample the small polygon edges, preserving smooth alpha coverage.
            for sy in 0..4 {
                for sx in 0..4 {
                    let px = x as f64 + (sx as f64 + 0.5) / 4.0 - pad as f64;
                    let py = y as f64 + (sy as f64 + 0.5) / 4.0 - pad as f64;
                    let mut color = [0.0; 3];
                    let mut alpha = 0.0;
                    if glow {
                        let distance = ((px - style.glow.center[0]).powi(2)
                            + (py - style.glow.center[1]).powi(2))
                        .sqrt()
                            / style.glow.radius;
                        for stops in style.glow.stops.windows(2) {
                            if distance >= stops[0].offset && distance <= stops[1].offset {
                                let t = (distance - stops[0].offset)
                                    / (stops[1].offset - stops[0].offset);
                                let a = rgb(&stops[0].color);
                                let b = rgb(&stops[1].color);
                                alpha = stops[0].opacity * (1.0 - t) + stops[1].opacity * t;
                                for i in 0..3 {
                                    color[i] = (a[i] * (1.0 - t) + b[i] * t) * alpha;
                                }
                                break;
                            }
                        }
                    }
                    for layer in &style.layers {
                        if inside(&layer.points, px, py) {
                            color = rgb(&layer.color);
                            alpha = 1.0;
                        }
                    }
                    for i in 0..3 {
                        channels[i] += color[i] / 16.0;
                    }
                    channels[3] += alpha * 255.0 / 16.0;
                }
            }
            pixels.push(
                ((channels[3].round() as u32) << 24)
                    | ((channels[0].round() as u32) << 16)
                    | ((channels[1].round() as u32) << 8)
                    | channels[2].round() as u32,
            );
        }
    }
    Raster {
        width: width as u16,
        height: height as u16,
        hotspot: [style.hotspot[0] + pad as i32, style.hotspot[1] + pad as i32],
        pixels,
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn halo_is_translucent_premultiplied_and_does_not_shift_target() {
        let image = render(true);
        assert_eq!(
            (image.width, image.height, image.hotspot),
            (85, 86, [35, 34])
        );
        assert_eq!(image.pixels[0], 0);
        let halo = image.pixels[42 * 85 + 60];
        assert!((halo >> 24) > 0 && (halo >> 24) < 255);
        for pixel in &image.pixels {
            for shift in [0, 8, 16] {
                assert!(((pixel >> shift) & 255) <= (pixel >> 24));
            }
        }
        let arrow = render(false);
        assert_eq!((arrow.width, arrow.height, arrow.hotspot), (19, 20, [2, 1]));
        assert_eq!(
            image.pixels[(33 + 7) * 85 + 33 + 7],
            arrow.pixels[7 * 19 + 7]
        );
    }
}
