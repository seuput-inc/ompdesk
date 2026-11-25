use std::sync::Arc;

use shell_core::hotkey::Mods;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct SurfaceKey {
    pub view: u64,
    pub wc: u64,
    pub generation: u64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Bounds {
    pub rect: Rect,
    pub scale: f64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct TextRange {
    pub start: u32,
    pub length: u32,
}

/// CDP `Page.screencastFrame` metadata, unmodified.
#[derive(Clone, Debug, PartialEq)]
pub struct FrameMetadata {
    pub device_width: f64,
    pub device_height: f64,
    pub page_scale_factor: f64,
    pub offset_top: f64,
    pub scroll_offset_x: f64,
    pub scroll_offset_y: f64,
}

#[derive(Clone, Debug)]
pub struct EncodedFrame {
    pub key: SurfaceKey,
    pub ack: i64,
    pub png: Arc<Vec<u8>>,
    pub pixel_width: u32,
    pub pixel_height: u32,
    pub scale: f64,
    pub metadata: FrameMetadata,
}

/// Coordinate equations follow DevTools panels/screencast/{ScreencastView,InputModel}.ts.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FrameGeometry {
    screen_zoom: f64,
    page_scale: f64,
    offset_top: f64,
    scroll: (f64, f64),
    image: Rect,
}

impl FrameGeometry {
    pub fn new(
        metadata: &FrameMetadata,
        view_dip_size: (f64, f64),
        image_pixels: (u32, u32),
    ) -> Result<Self, SurfaceError> {
        let positive = [
            metadata.device_width,
            metadata.device_height,
            metadata.page_scale_factor,
            view_dip_size.0,
            view_dip_size.1,
        ];
        if positive
            .iter()
            .any(|value| !value.is_finite() || *value <= 0.0)
            || image_pixels.0 == 0
            || image_pixels.1 == 0
            || !metadata.offset_top.is_finite()
            || !metadata.scroll_offset_x.is_finite()
            || !metadata.scroll_offset_y.is_finite()
        {
            return Err(SurfaceError::Invalid(
                "invalid displayed frame geometry".into(),
            ));
        }
        let screen_zoom =
            (view_dip_size.0 / metadata.device_width).min(view_dip_size.1 / metadata.device_height);
        let image_zoom = metadata.device_width * screen_zoom / f64::from(image_pixels.0);
        let geometry = Self {
            screen_zoom,
            page_scale: metadata.page_scale_factor,
            offset_top: metadata.offset_top,
            scroll: (metadata.scroll_offset_x, metadata.scroll_offset_y),
            image: Rect {
                x: 0.0,
                y: metadata.offset_top * screen_zoom,
                width: f64::from(image_pixels.0) * image_zoom,
                height: f64::from(image_pixels.1) * image_zoom,
            },
        };
        if !geometry.image.y.is_finite()
            || !geometry.image.width.is_finite()
            || !geometry.image.height.is_finite()
            || !screen_zoom.is_finite()
            || screen_zoom <= 0.0
            || !(screen_zoom * geometry.page_scale).is_finite()
            || screen_zoom * geometry.page_scale <= 0.0
        {
            return Err(SurfaceError::Invalid(
                "displayed frame geometry overflow".into(),
            ));
        }
        Ok(geometry)
    }

    pub fn image_rect(self) -> Rect {
        self.image
    }

    /// CDP trusted input is in visual-viewport coordinates, before pinch-scale removal.
    pub fn to_input(self, point: (f64, f64)) -> (f64, f64) {
        (
            point.0 / self.screen_zoom,
            point.1 / self.screen_zoom - self.offset_top,
        )
    }

    pub fn input_delta(self, delta: (f64, f64)) -> (f64, f64) {
        (delta.0 / self.screen_zoom, delta.1 / self.screen_zoom)
    }

    /// DOM/document CSS coordinates, including the scroll captured with this paint.
    pub fn to_css(self, point: (f64, f64)) -> (f64, f64) {
        let (x, y) = self.to_input(point);
        (
            x / self.page_scale + self.scroll.0,
            y / self.page_scale + self.scroll.1,
        )
    }

    pub fn css_rect_to_view(self, rect: Rect) -> Rect {
        let scale = self.page_scale * self.screen_zoom;
        Rect {
            x: (rect.x - self.scroll.0) * scale,
            y: ((rect.y - self.scroll.1) * self.page_scale + self.offset_top) * self.screen_zoom,
            width: rect.width * scale,
            height: rect.height * scale,
        }
    }

    pub fn to_viewport_css(self, point: (f64, f64)) -> (f64, f64) {
        let (x, y) = self.to_css(point);
        (x - self.scroll.0, y - self.scroll.1)
    }

    /// DOM Range and composed iframe geometry are viewport-relative, not document-relative.
    pub fn viewport_rect_to_view(self, rect: Rect) -> Rect {
        self.css_rect_to_view(Rect {
            x: rect.x + self.scroll.0,
            y: rect.y + self.scroll.1,
            ..rect
        })
    }
}

#[cfg(test)]
mod geometry_tests {
    use super::*;

    #[test]
    fn pinched_offset_frame_aligns_paint_input_text_and_accessibility() {
        let geometry = FrameGeometry::new(
            &FrameMetadata {
                device_width: 400.0,
                device_height: 300.0,
                page_scale_factor: 2.0,
                offset_top: 20.0,
                scroll_offset_x: 70.0,
                scroll_offset_y: 90.0,
            },
            (800.0, 600.0),
            (800, 560),
        )
        .unwrap();
        assert_eq!(
            geometry.image_rect(),
            Rect {
                x: 0.0,
                y: 40.0,
                width: 800.0,
                height: 560.0
            }
        );
        assert_eq!(geometry.to_input((120.0, 200.0)), (60.0, 80.0));
        assert_eq!(geometry.input_delta((40.0, 80.0)), (20.0, 40.0));
        assert_eq!(geometry.to_css((120.0, 200.0)), (100.0, 130.0));
        assert_eq!(geometry.to_viewport_css((120.0, 200.0)), (30.0, 40.0));
        let document_rect = Rect {
            x: 100.0,
            y: 130.0,
            width: 5.0,
            height: 7.0,
        };
        let displayed = Rect {
            x: 120.0,
            y: 200.0,
            width: 20.0,
            height: 28.0,
        };
        assert_eq!(geometry.css_rect_to_view(document_rect), displayed);
        assert_eq!(
            geometry.viewport_rect_to_view(Rect {
                x: 30.0,
                y: 40.0,
                ..document_rect
            }),
            displayed,
        );
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FrameDisposition {
    Presented,
    Superseded,
    Hidden,
    Disposed,
    DecodeFailed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MouseKind {
    Move,
    Down,
    Up,
    Enter,
    #[cfg(target_os = "macos")]
    Leave,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MouseButton {
    None,
    Left,
    Middle,
    Right,
    Back,
    Forward,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KeyKind {
    Down,
    Up,
}
#[cfg(windows)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TouchKind {
    Start,
    Move,
    End,
    Cancel,
}

/// `Dip` is macOS precise scrolling; `Page` is the Windows "one screen at a time" wheel setting.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WheelUnit {
    #[cfg(target_os = "macos")]
    Dip,
    Line,
    #[cfg(windows)]
    Page,
}

#[cfg(windows)]
#[derive(Clone, Debug)]
pub struct TouchPoint {
    pub id: u32,
    pub x: f64,
    pub y: f64,
    pub radius_x: f64,
    pub radius_y: f64,
    pub pressure: f64,
}

#[derive(Clone, Debug)]
pub enum Input {
    Mouse {
        kind: MouseKind,
        x: f64,
        y: f64,
        button: MouseButton,
        buttons: u32,
        click_count: u32,
        modifiers: Mods,
    },
    Wheel {
        x: f64,
        y: f64,
        delta_x: f64,
        delta_y: f64,
        unit: WheelUnit,
        modifiers: Mods,
    },
    Key {
        kind: KeyKind,
        key: String,
        code: String,
        windows_virtual_key_code: u32,
        native_virtual_key_code: u32,
        modifiers: Mods,
        text: Option<String>,
        repeat: bool,
    },
    #[cfg(windows)]
    Touch {
        kind: TouchKind,
        points: Vec<TouchPoint>,
        modifiers: Mods,
    },
    Ime {
        utf16text: Vec<u16>,
        selection_start: u32,
        selection_end: u32,
        replacement: Option<TextRange>,
    },
    CancelIme,
    CommitText {
        text: String,
        replacement: Option<TextRange>,
    },
    Edit(EditCommand),
    Focus(bool),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EditCommand {
    Copy,
    Cut,
    Paste,
    #[cfg(target_os = "macos")]
    SelectAll,
    Undo,
    #[cfg(target_os = "macos")]
    Redo,
    #[cfg(target_os = "macos")]
    DeleteBackward,
    #[cfg(target_os = "macos")]
    DeleteForward,
}

#[derive(Clone, Debug, PartialEq)]
pub enum AxValue {
    None,
    Text(String),
    Number(f64),
    Boolean(bool),
    Protected,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Checked {
    Off,
    On,
    Mixed,
}

#[derive(Clone, Debug)]
pub struct AxNode {
    pub node_id: String,
    pub frame_id: Option<String>,
    pub backend_dom_node_id: Option<i64>,
    pub role: String,
    pub name: Option<String>,
    pub description: Option<String>,
    pub value: AxValue,
    pub children: Vec<String>,
    pub bounds: Option<Rect>,
    pub disabled: bool,
    pub focused: bool,
    pub focusable: bool,
    pub editable: bool,
    pub read_only: bool,
    pub secure: bool,
    #[cfg(target_os = "macos")]
    pub multiline: bool,
    pub required: bool,
    pub selected: bool,
    pub expanded: Option<bool>,
    pub checked: Option<Checked>,
    pub selected_text_range: Option<TextRange>,
    pub actions: Vec<AxActionKind>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AxActionKind {
    Default,
    Focus,
    SetValue,
    SetSelection,
    Increment,
    Decrement,
    #[cfg(target_os = "macos")]
    ShowMenu,
}

#[derive(Clone, Debug)]
pub struct AxSnapshot {
    pub key: SurfaceKey,
    pub generation: u64,
    pub root_id: Option<String>,
    pub nodes: Vec<AxNode>,
}

#[derive(Clone, Debug)]
pub struct AxTarget {
    pub node_id: String,
    pub frame_id: Option<String>,
    pub backend_dom_node_id: i64,
}

#[derive(Clone, Debug)]
pub enum AxAction {
    Default,
    Focus,
    SetValue(String),
    SetSelection(TextRange),
    #[cfg(target_os = "macos")]
    Increment,
    #[cfg(target_os = "macos")]
    Decrement,
    #[cfg(target_os = "macos")]
    ShowMenu,
}

/// A protected field never carries its plaintext in the native accessibility/text cache.
#[derive(Clone, Debug)]
pub enum TextContent {
    Plain(String),
    Protected { utf16_length: u32 },
}

#[derive(Clone, Debug)]
pub struct TextInputState {
    pub key: SurfaceKey,
    pub generation: u64,
    pub backend_dom_node_id: Option<i64>,
    #[cfg(target_os = "macos")]
    pub editable: bool,
    pub content: TextContent,
    pub selection: TextRange,
    pub marked: Option<TextRange>,
    pub caret: Option<Rect>,
}

#[cfg(windows)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TextUnit {
    Character,
    Word,
    Line,
    Paragraph,
    Page,
    Format,
    Document,
}

/// All offsets are UTF-16 code units; rectangles and points are surface-local DIP.
/// Only `RangeRects` and `OffsetAtPoint` have a macOS consumer; the other queries serve
/// the Windows UI Automation text pattern.
#[derive(Clone, Debug)]
pub enum TextQuery {
    RangeRects {
        range: TextRange,
    },
    OffsetAtPoint {
        x: f64,
        y: f64,
    },
    #[cfg(windows)]
    VisibleRanges,
    #[cfg(windows)]
    RangeFromChild {
        child: AxTarget,
    },
    #[cfg(windows)]
    UnitBoundaries {
        unit: TextUnit,
    },
    #[cfg(windows)]
    ScrollIntoView {
        range: TextRange,
        align_to_top: bool,
    },
}

impl TextQuery {
    /// A query that moves the Page cannot be abandoned on a timeout.
    pub fn mutates_page(&self) -> bool {
        #[cfg(windows)]
        {
            matches!(self, Self::ScrollIntoView { .. })
        }
        #[cfg(not(windows))]
        {
            false
        }
    }
}

#[derive(Clone, Debug)]
pub enum TextReply {
    Rects(Vec<Rect>),
    Offset(Option<u32>),
    #[cfg(windows)]
    Ranges(Vec<TextRange>),
    #[cfg(windows)]
    Range(Option<TextRange>),
    #[cfg(windows)]
    Boundaries(Vec<u32>),
    #[cfg(windows)]
    Scrolled,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SurfaceError {
    WrongThread,
    StaleGeneration,
    Disposed,
    Invalid(String),
    Native(String),
    Consumer(String),
}

impl std::fmt::Display for SurfaceError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::WrongThread => {
                formatter.write_str("native Preview surface requires its UI thread")
            }
            Self::StaleGeneration => {
                formatter.write_str("native Preview surface generation is stale")
            }
            Self::Disposed => formatter.write_str("native Preview surface is disposed"),
            Self::Invalid(message) | Self::Native(message) | Self::Consumer(message) => {
                formatter.write_str(message)
            }
        }
    }
}
impl std::error::Error for SurfaceError {}

/// A routes these events through its existing generation-checked Registry to the same BrowserPage.
/// Ok means the actual consumer accepted the operation, never a locally simulated browser effect.
pub trait Consumer: Send + Sync {
    fn schedule_present(&self, key: SurfaceKey) -> Result<(), SurfaceError>;
    fn presented(
        &self,
        key: SurfaceKey,
        frame_ack: i64,
        disposition: FrameDisposition,
    ) -> Result<(), SurfaceError>;
    fn input(&self, key: SurfaceKey, input: Input) -> Result<(), SurfaceError>;
    fn accessibility(
        &self,
        key: SurfaceKey,
        snapshot_generation: u64,
        target: AxTarget,
        action: AxAction,
    ) -> Result<(), SurfaceError>;
    /// Must use a captured snapshot or the existing non-UI CDP runtime. Never wait on
    /// a future that requires this OS UI thread, and never resolve a replacement Page.
    fn text_query(
        &self,
        key: SurfaceKey,
        snapshot_generation: u64,
        target: AxTarget,
        query: TextQuery,
    ) -> Result<TextReply, SurfaceError>;
    fn failed(&self, key: SurfaceKey, error: SurfaceError);
}
