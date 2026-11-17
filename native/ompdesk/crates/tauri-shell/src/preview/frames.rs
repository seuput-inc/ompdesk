use crate::preview_surface as native;
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::Value;
use shell_core::{frame, tray_image, wire::WireError};
use shell_preview::Viewport;
use std::sync::Arc;

#[derive(Clone)]
pub struct Frame {
    png: Arc<Vec<u8>>,
    width: u32,
    height: u32,
    scale: f64,
    metadata: native::FrameMetadata,
    ack: i64,
}
impl Frame {
    pub fn from_event(params: Arc<Value>) -> Result<Self, WireError> {
        let encoded = params["data"]
            .as_str()
            .ok_or_else(|| invalid("missing screencast pixels"))?;
        let png = STANDARD.decode(encoded).map_err(invalid)?;
        if png.len() < 24 || &png[..8] != b"\x89PNG\r\n\x1a\n" || &png[12..16] != b"IHDR" {
            return Err(invalid("Preview screencast is not PNG"));
        }
        let width = u32::from_be_bytes(png[16..20].try_into().expect("PNG width"));
        let height = u32::from_be_bytes(png[20..24].try_into().expect("PNG height"));
        if width == 0 || height == 0 || width > 16384 || height > 16384 {
            return Err(invalid("invalid Preview painted dimensions"));
        }
        let number = |name: &str| {
            params["metadata"][name]
                .as_f64()
                .filter(|value| value.is_finite())
                .ok_or_else(|| invalid(format!("missing or invalid screencast {name}")))
        };
        let metadata = native::FrameMetadata {
            device_width: number("deviceWidth")?,
            device_height: number("deviceHeight")?,
            page_scale_factor: number("pageScaleFactor")?,
            offset_top: number("offsetTop")?,
            scroll_offset_x: number("scrollOffsetX")?,
            scroll_offset_y: number("scrollOffsetY")?,
        };
        if metadata.device_width <= 0.0
            || metadata.device_height <= 0.0
            || metadata.page_scale_factor <= 0.0
        {
            return Err(invalid("invalid screencast metadata dimensions"));
        }
        Ok(Self {
            png: Arc::new(png),
            width,
            height,
            scale: f64::from(width) / metadata.device_width,
            metadata,
            ack: params["sessionId"]
                .as_i64()
                .ok_or_else(|| invalid("missing painted frame ACK identity"))?,
        })
    }
    pub fn ack(&self) -> i64 {
        self.ack
    }
    pub fn width(&self) -> u32 {
        self.width
    }
    pub fn height(&self) -> u32 {
        self.height
    }
    pub fn scale(&self) -> f64 {
        self.scale
    }
    pub fn native(&self, key: native::SurfaceKey) -> native::EncodedFrame {
        native::EncodedFrame {
            key,
            ack: self.ack,
            png: Arc::clone(&self.png),
            pixel_width: self.width,
            pixel_height: self.height,
            scale: self.scale,
            metadata: self.metadata.clone(),
        }
    }
    pub fn encode(&self, params: &Value) -> Result<(Arc<Vec<u8>>, u32, u32), WireError> {
        let format = match params["format"].as_str() {
            Some("png") => frame::Format::Png,
            Some("jpeg") => frame::Format::Jpeg,
            _ => return Err(invalid("frame format must be png or jpeg")),
        };
        let quality = match params.get("quality") {
            None => 80,
            Some(value) => value
                .as_u64()
                .filter(|value| *value <= 100)
                .ok_or_else(|| invalid("frame quality must be 0..100"))?
                as u8,
        };
        let width = match params.get("width") {
            None => None,
            Some(value) => Some(
                value
                    .as_u64()
                    .filter(|value| *value > 0)
                    .and_then(|value| u32::try_from(value).ok())
                    .ok_or_else(|| invalid("invalid target width"))?,
            ),
        };
        if format == frame::Format::Png && width.is_none_or(|width| width >= self.width) {
            return Ok((Arc::clone(&self.png), self.width, self.height));
        }
        let mut image = tray_image::decode_png(&self.png).map_err(invalid)?;
        if (image.width, image.height) != (self.width, self.height) {
            return Err(invalid("painted PNG dimensions changed"));
        }
        for pixel in image.data.chunks_exact_mut(4) {
            pixel.swap(0, 2);
        }
        frame::encode(
            &image.data,
            image.width,
            image.height,
            format,
            quality,
            width,
        )
        .map(|(bytes, width, height)| (Arc::new(bytes), width, height))
        .map_err(invalid)
    }
}
fn invalid(message: impl std::fmt::Display) -> WireError {
    WireError::new("invalid", message.to_string())
}

/// The pixels a frame of an offscreen window is: the window's DIP size times the screen's scale, whatever the
/// page's own zoom (the zoom changes the layout and the scale the page paints at, not the window).
pub fn frame_pixels(window: Viewport) -> (u32, u32) {
    let pixels = |dip: u32| (f64::from(dip) * window.device_scale_factor).round() as u32;
    (pixels(window.width), pixels(window.height))
}

/// Whether `frame` pictures an offscreen window of `window`'s size. Until a surface of the resized view activates,
/// Chromium's capturer letterboxes the last surface into the new capture size, keeping that surface's aspect ratio
/// (Viz `FrameSinkVideoCapturerImpl`, `ContentRectDeterminedForCapture`), and the frame is cut to that content: right
/// after a 240×160 view became 780×1400 the first frame is the old picture at 780×520. Such a frame shows a geometry
/// the page no longer has. A side may be over by the rounding of a fractional view scale (`Page::resize_framed`
/// rounds the view's DIP up).
pub fn pictures_window(frame: &Frame, window: Viewport) -> bool {
    let (width, height) = frame_pixels(window);
    let slack = window.device_scale_factor.ceil() as u32;
    frame.width.abs_diff(width) <= slack && frame.height.abs_diff(height) <= slack
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn painted_at(width: u32, height: u32) -> Frame {
        let (png, _, _) = frame::encode(
            &[0, 0, 255, 255].repeat((width * height) as usize),
            width,
            height,
            frame::Format::Png,
            80,
            None,
        )
        .unwrap();
        Frame::from_event(Arc::new(json!({"sessionId":42,"data":STANDARD.encode(png),"metadata":{"deviceWidth":width / 2,"deviceHeight":height / 2,"pageScaleFactor":1,"offsetTop":0,"scrollOffsetX":0,"scrollOffsetY":0}}))).unwrap()
    }
    fn painted() -> Frame {
        painted_at(20, 10)
    }
    #[test]
    fn encoding_keeps_the_retained_paint_and_never_enlarges_it() {
        let frame = painted();
        let (png, width, height) = frame.encode(&json!({"format":"png","width":100})).unwrap();
        assert_eq!((width, height), (20, 10));
        assert_eq!(
            tray_image::decode_png(&png).unwrap().data[0..4],
            [255, 0, 0, 255]
        );
        let (jpeg, width, height) = frame.encode(&json!({"format":"jpeg","width":5})).unwrap();
        assert_eq!((width, height), (5, 2));
        assert_eq!(&jpeg[..2], &[0xff, 0xd8]);
    }
    #[test]
    fn invalid_frame_encoding_options_do_not_masquerade_as_defaults() {
        let frame = painted();
        for params in [
            json!({"format":"gif"}),
            json!({"format":"jpeg","quality":101}),
            json!({"format":"png","width":0}),
        ] {
            assert!(frame.encode(&params).is_err());
        }
    }
    #[test]
    fn an_offscreen_window_streams_its_size_times_the_screen_scale() {
        let at = |width, height, device_scale_factor| {
            frame_pixels(Viewport {
                width,
                height,
                device_scale_factor,
            })
        };
        assert_eq!(at(780, 1400, 1.0), (780, 1400));
        assert_eq!(at(390, 700, 2.0), (780, 1400));
        assert_eq!(at(390, 700, 1.5), (585, 1050));
    }
    #[test]
    fn a_letterboxed_frame_of_the_previous_view_does_not_picture_the_window() {
        for (frame, window, pictured) in [
            ((780, 1400), (780, 1400, 1.0), true),
            ((780, 1400), (390, 700, 2.0), true),
            // A 1.5× view rounds 1400 / 1.5 up to 934 DIP, 1401 pixels.
            ((780, 1401), (520, 933, 1.5), true),
            // The 240×160 view's last surface letterboxed into a 780×1400 capture.
            ((780, 520), (780, 1400, 1.0), false),
            ((240, 160), (780, 1400, 1.0), false),
        ] {
            let (width, height, device_scale_factor) = window;
            let window = Viewport {
                width,
                height,
                device_scale_factor,
            };
            assert_eq!(
                pictures_window(&painted_at(frame.0, frame.1), window),
                pictured,
                "{frame:?} in {width}x{height}@{device_scale_factor}"
            );
        }
    }
}
