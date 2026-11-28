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
