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

#[derive(Clone, Debug)]
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
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TouchKind {
    Start,
    Move,
    End,
    Cancel,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WheelUnit {
    Dip,
    Line,
    Page,
}

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
    SelectAll,
    Undo,
    Redo,
    DeleteBackward,
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
    Increment,
    Decrement,
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
    pub editable: bool,
    pub content: TextContent,
    pub selection: TextRange,
    pub marked: Option<TextRange>,
    pub caret: Option<Rect>,
}

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
#[derive(Clone, Debug)]
pub enum TextQuery {
    RangeRects {
        range: TextRange,
    },
    OffsetAtPoint {
        x: f64,
        y: f64,
    },
    VisibleRanges,
    RangeFromChild {
        child: AxTarget,
    },
    UnitBoundaries {
        unit: TextUnit,
    },
    ScrollIntoView {
        range: TextRange,
        align_to_top: bool,
    },
}

#[derive(Clone, Debug)]
pub enum TextReply {
    Rects(Vec<Rect>),
    Offset(Option<u32>),
    Ranges(Vec<TextRange>),
    Range(Option<TextRange>),
    Boundaries(Vec<u32>),
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
