//! Hit regions are half-open rectangles in physical pixels of the window's client area.
//! The page reports its painted controls and exclusions in back-to-front order.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Hit {
    Client,
    Caption,
    Minimize,
    Maximize,
    Close,
    Top,
    TopLeft,
    TopRight,
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct Cell {
    pub hit: Hit,
    pub bounds: [i32; 4],
}

/// The HWND width, monitor DPI and the host's page zoom decide the largest input surface, not JS.
pub(crate) struct RowBounds {
    pub width: i32,
    pub scale: f64,
}
impl RowBounds {
    pub fn height(&self) -> i32 {
        (36.0 * self.scale).round() as i32
    }
    pub fn accepts(&self, width: i32, height: i32, count: usize) -> bool {
        width > 0
            && width.abs_diff(self.width) <= self.rounding() as u32
            && height == self.height()
            && count <= 2048
    }
    // innerWidth is an integer CSS pixel. Half a CSS pixel can span several physical pixels.
    fn rounding(&self) -> i32 {
        (self.scale * 0.5).ceil().max(1.0) as i32
    }
    pub fn contains(&self, cell: &Cell) -> bool {
        let [l, t, r, b] = cell.bounds;
        if l < 0 || t < 0 || l >= r || r > self.width || t >= b || b > self.height() {
            return false;
        }
        let column = match cell.hit {
            Hit::Minimize => 3,
            Hit::Maximize => 2,
            Hit::Close => 1,
            Hit::Caption | Hit::Client => return true,
            _ => return false,
        };
        let rounding = self.rounding();
        let edge = |n| self.width - (f64::from(n) * 46.0 * self.scale).round() as i32;
        l >= edge(column) - rounding && r <= edge(column - 1) + rounding
    }
}

pub(crate) fn at(cells: &[Cell], x: i32, y: i32, width: i32, resize: i32, fullscreen: bool) -> Hit {
    if fullscreen || x < 0 || y < 0 || x >= width {
        return Hit::Client;
    }
    if y < resize {
        return if x < resize {
            Hit::TopLeft
        } else if x >= width - resize {
            Hit::TopRight
        } else {
            Hit::Top
        };
    }
    cells
        .iter()
        .rev()
        .find(|cell| {
            let [l, t, r, b] = cell.bounds;
            l <= x && x < r && t <= y && y < b
        })
        .map_or(Hit::Client, |cell| cell.hit)
}

#[cfg(test)]
mod tests {
    use super::Hit::*;
    use super::*;

    #[test]
    fn page_cannot_enlarge_the_row_or_move_close_over_the_tabs() {
        let row = RowBounds {
            width: 1000,
            scale: 1.5,
        };
        assert!(row.accepts(1000, 54, 2048));
        assert!(!row.accepts(1000, 55, 1));
        assert!(!row.accepts(1000, 54, 2049));
        assert!(!row.accepts(2000, 54, 1));
        assert!(!row.contains(&Cell {
            hit: Close,
            bounds: [0, 0, 1000, 54]
        }));
        assert!(!row.contains(&Cell {
            hit: Caption,
            bounds: [0, 0, 1000, 55]
        }));
        assert!(row.contains(&Cell {
            hit: Close,
            bounds: [931, 4, 1000, 54]
        }));
    }

    #[test]
    fn controls_over_drag_and_overlay_over_controls() {
        let cells = [
            Cell {
                hit: Caption,
                bounds: [0, 0, 500, 36],
            },
            Cell {
                hit: Client,
                bounds: [80, 4, 240, 32],
            },
            Cell {
                hit: Minimize,
                bounds: [362, 0, 408, 36],
            },
            Cell {
                hit: Maximize,
                bounds: [408, 0, 454, 36],
            },
            Cell {
                hit: Close,
                bounds: [454, 0, 500, 36],
            },
            Cell {
                hit: Client,
                bounds: [450, 8, 470, 32],
            },
        ];
        for (x, y, expected) in [
            (-1, 10, Client),
            (80, 18, Client),
            (240, 18, Caption),
            (361, 35, Caption),
            (362, 35, Minimize),
            (407, 35, Minimize),
            (408, 35, Maximize),
            (453, 35, Maximize),
            (454, 35, Close),
            (451, 18, Client),
            (469, 18, Client),
            (470, 18, Close),
            (499, 35, Close),
            (500, 35, Client),
            (400, 36, Client),
        ] {
            assert_eq!(at(&cells, x, y, 500, 4, false), expected);
        }
        assert_eq!(at(&cells, 420, 0, 500, 4, false), Top);
        assert_eq!(at(&cells, 1, 1, 500, 4, false), TopLeft);
        assert_eq!(at(&cells, 499, 1, 500, 4, false), TopRight);
        assert_eq!(at(&cells, 100, 1, 500, 4, false), Top);
        assert_eq!(at(&cells, 420, 0, 500, 0, false), Maximize);
        assert_eq!(at(&cells, 420, 0, 500, 4, true), Client);
    }
}
