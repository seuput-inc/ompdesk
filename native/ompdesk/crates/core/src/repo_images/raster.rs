use std::io::Cursor;

use base64::Engine;
use image::{ImageFormat, ImageReader, Limits};

pub(super) const INPUT_BYTES: usize = 512 * 1024;

/// image 0.25's ICO decoder constructs embedded PNGs without limits and exposes no limited constructor.
/// Bound the container's entries before its metadata parser, and select the same depth/size/last-entry candidate
/// here so an embedded PNG reaches ImageReader's allocation-limited PNG constructor instead.
fn ico_payload(bytes: &[u8]) -> Option<(&[u8], ImageFormat)> {
    if bytes.get(..4)? != [0, 0, 1, 0] {
        return None;
    }
    let count = usize::from(u16::from_le_bytes(bytes.get(4..6)?.try_into().ok()?));
    if count == 0 || count > 64 {
        return None;
    }
    let table_end = 6 + count * 16;
    let (entries, _) = bytes.get(6..table_end)?.as_chunks::<16>();
    let mut best = None;
    for (index, entry) in entries.iter().enumerate() {
        let width = if entry[0] == 0 {
            256
        } else {
            u32::from(entry[0])
        };
        let height = if entry[1] == 0 {
            256
        } else {
            u32::from(entry[1])
        };
        let depth = u16::from_le_bytes(entry[6..8].try_into().ok()?);
        let length = u32::from_le_bytes(entry[8..12].try_into().ok()?) as usize;
        let offset = u32::from_le_bytes(entry[12..16].try_into().ok()?) as usize;
        if offset < table_end {
            return None;
        }
        let payload = bytes.get(offset..offset.checked_add(length)?)?;
        let png = payload.starts_with(b"\x89PNG\r\n\x1a\n");
        if png {
            // Bound the embedded dimensions before any PNG metadata or compressed chunk is read.
            if payload.get(12..16)? != b"IHDR" {
                return None;
            }
            let actual_width = u32::from_be_bytes(payload.get(16..20)?.try_into().ok()?);
            let actual_height = u32::from_be_bytes(payload.get(20..24)?.try_into().ok()?);
            if actual_width != width || actual_height != height {
                return None;
            }
        } else {
            // A standard DIB's doubled height includes the ICO mask. Refuse a directory/header mismatch before
            // the library's BMP metadata parser allocates its raster or palette.
            let header = u32::from_le_bytes(payload.get(..4)?.try_into().ok()?);
            let (actual_width, actual_height) = if header == 12 {
                (
                    u32::from(u16::from_le_bytes(payload.get(4..6)?.try_into().ok()?)),
                    u32::from(u16::from_le_bytes(payload.get(6..8)?.try_into().ok()?)),
                )
            } else {
                (
                    u32::from_le_bytes(payload.get(4..8)?.try_into().ok()?),
                    u32::from_le_bytes(payload.get(8..12)?.try_into().ok()?),
                )
            };
            if actual_width != width || actual_height != height * 2 {
                return None;
            }
        }
        let score = (depth, width * height, index);
        if best
            .as_ref()
            .is_none_or(|(previous, _, _)| score > *previous)
        {
            best = Some((score, payload, png));
        }
    }
    let (_, payload, png) = best?;
    Some(if png {
        (payload, ImageFormat::Png)
    } else {
        (bytes, ImageFormat::Ico)
    })
}

/// Decode only raster formats, before returning a fresh small PNG with no original metadata or executable content.
pub(super) fn data_url(bytes: &[u8]) -> Option<String> {
    if bytes.len() > INPUT_BYTES {
        return None;
    }
    let format = image::guess_format(bytes).ok()?;
    if !matches!(
        format,
        ImageFormat::Png | ImageFormat::Jpeg | ImageFormat::WebP | ImageFormat::Ico
    ) {
        return None;
    }
    let (bytes, format) = if format == ImageFormat::Ico {
        ico_payload(bytes)?
    } else {
        (bytes, format)
    };
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
    if png.len() > 24 * 1024 {
        return None;
    }
    Some(format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(png)
    ))
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
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(url.strip_prefix("data:image/png;base64,").unwrap())
            .unwrap();
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
        for format in [
            ImageFormat::Png,
            ImageFormat::Jpeg,
            ImageFormat::WebP,
            ImageFormat::Ico,
        ] {
            let picture = if format == ImageFormat::Jpeg {
                image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(
                    24,
                    12,
                    image::Rgb([20, 100, 180]),
                ))
            } else {
                image::DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(
                    24,
                    12,
                    image::Rgba([20, 100, 180, 255]),
                ))
            };
            let mut encoded = Cursor::new(Vec::new());
            picture.write_to(&mut encoded, format).unwrap();
            assert!(data_url(encoded.get_ref()).is_some(), "{format:?}");
            assert!(data_url(&encoded.get_ref()[..10]).is_none(), "{format:?}");
        }
    }

    #[test]
    fn ico_directory_cannot_hide_unbounded_embedded_dimensions() {
        let mut encoded = Cursor::new(Vec::new());
        image::RgbaImage::from_pixel(16, 16, image::Rgba([0; 4]))
            .write_to(&mut encoded, ImageFormat::Ico)
            .unwrap();
        let mut bytes = encoded.into_inner();
        assert!(data_url(&bytes).is_some());
        // An ICO entry promises 16px, but the inner PNG claims 4096px. This is rejected before PNG allocation.
        let offset = u32::from_le_bytes(bytes[18..22].try_into().unwrap()) as usize;
        bytes[offset + 16..offset + 20].copy_from_slice(&4096u32.to_be_bytes());
        assert!(ico_payload(&bytes).is_none());
        assert!(data_url(&bytes).is_none());
    }
}
