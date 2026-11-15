use std::io::Cursor;

use base64::Engine;
use image::{ImageFormat, ImageReader, Limits};

pub(super) const INPUT_BYTES: usize = 512 * 1024;

/// Decode only raster formats, before returning a fresh small PNG with no original metadata or executable content.
pub(super) fn data_url(bytes: &[u8]) -> Option<String> {
    if bytes.len() > INPUT_BYTES { return None; }
    let format = image::guess_format(bytes).ok()?;
    if !matches!(format, ImageFormat::Png | ImageFormat::Jpeg | ImageFormat::WebP | ImageFormat::Ico) { return None; }
    let mut limits = Limits::default();
    limits.max_image_width = Some(2048);
    limits.max_image_height = Some(2048);
    limits.max_alloc = Some(20 * 1024 * 1024);
    let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
    reader.limits(limits);
    let decoded = reader.decode().ok()?;
    let small = decoded.thumbnail(64, 64);
    let mut png = Cursor::new(Vec::new());
    small.write_to(&mut png, ImageFormat::Png).ok()?;
    let png = png.into_inner();
    if png.len() > 24 * 1024 { return None; }
    Some(format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(png)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn raster_artwork_becomes_a_small_contained_png_and_svg_never_reaches_the_page() {
        let picture = image::RgbaImage::from_pixel(180, 90, image::Rgba([20, 100, 180, 255]));
        let mut original = Cursor::new(Vec::new());
        picture.write_to(&mut original, ImageFormat::Png).unwrap();
        let url = data_url(original.get_ref()).unwrap();
        let bytes = base64::engine::general_purpose::STANDARD.decode(url.strip_prefix("data:image/png;base64,").unwrap()).unwrap();
        let result = image::load_from_memory(&bytes).unwrap();
        assert_eq!((result.width(), result.height()), (64, 32));
        assert!(data_url(b"<svg xmlns='http://www.w3.org/2000/svg' onload='alert(1)'/>").is_none());
        assert!(data_url(b"<html>not an image</html>").is_none());
        assert!(data_url(&vec![0; INPUT_BYTES + 1]).is_none());
    }

    #[test]
    fn declared_large_pixel_dimensions_are_refused_before_decoding() {
        let picture = image::RgbaImage::from_pixel(2049, 1, image::Rgba([0; 4]));
        let mut encoded = Cursor::new(Vec::new());
        picture.write_to(&mut encoded, ImageFormat::Png).unwrap();
        assert!(data_url(encoded.get_ref()).is_none());
    }

    #[test]
    fn all_enabled_favicon_codecs_are_normalized_and_truncation_is_rejected() {
        for format in [ImageFormat::Png, ImageFormat::Jpeg, ImageFormat::WebP, ImageFormat::Ico] {
            let picture = image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(24, 12, image::Rgb([20, 100, 180])));
            let mut encoded = Cursor::new(Vec::new());
            picture.write_to(&mut encoded, format).unwrap();
            assert!(data_url(encoded.get_ref()).is_some(), "{format:?}");
            assert!(data_url(&encoded.get_ref()[..10]).is_none(), "{format:?}");
        }
    }
}
