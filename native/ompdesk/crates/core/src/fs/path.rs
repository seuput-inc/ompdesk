//! Node-compatible lexical path normalization, independent of the host filesystem.

/// node's `normalizeString`: `.` and `..` parts resolved, repeated separators folded.
pub(crate) fn normalize_parts(
    path: &[char],
    allow_above_root: bool,
    separator: char,
    is_separator: fn(char) -> bool,
) -> String {
    let mut res: Vec<char> = Vec::new();
    let mut last_segment_length: isize = 0;
    let mut last_slash: isize = -1;
    let mut dots: i32 = 0;
    let mut code = '\0';
    let last_separator = |res: &[char]| {
        res.iter()
            .rposition(|c| *c == separator)
            .map_or(-1, |at| at as isize)
    };
    for i in 0..=path.len() {
        if i < path.len() {
            code = path[i];
        } else if is_separator(code) {
            break;
        } else {
            code = '/';
        }
        let at = i as isize;
        if is_separator(code) {
            if last_slash == at - 1 || dots == 1 {
                // A repeated separator or a `.` part adds nothing.
            } else if dots == 2 {
                let ends_in_dots = res.len() >= 2
                    && last_segment_length == 2
                    && res[res.len() - 1] == '.'
                    && res[res.len() - 2] == '.';
                if !ends_in_dots {
                    if res.len() > 2 {
                        let cut = last_separator(&res);
                        if cut == -1 {
                            res.clear();
                            last_segment_length = 0;
                        } else {
                            res.truncate(cut as usize);
                            last_segment_length = res.len() as isize - 1 - last_separator(&res);
                        }
                        last_slash = at;
                        dots = 0;
                        continue;
                    } else if !res.is_empty() {
                        res.clear();
                        last_segment_length = 0;
                        last_slash = at;
                        dots = 0;
                        continue;
                    }
                }
                if allow_above_root {
                    if !res.is_empty() {
                        res.push(separator);
                    }
                    res.extend(['.', '.']);
                    last_segment_length = 2;
                }
            } else {
                if !res.is_empty() {
                    res.push(separator);
                }
                res.extend(&path[(last_slash + 1) as usize..i]);
                last_segment_length = at - last_slash - 1;
            }
            last_slash = at;
            dots = 0;
        } else if code == '.' && dots != -1 {
            dots += 1;
        } else {
            dots = -1;
        }
    }
    res.into_iter().collect()
}

/// `path.win32.normalize`.
pub(crate) fn normalize_win32(path: &str) -> String {
    let sep = |c: char| c == '/' || c == '\\';
    let chars: Vec<char> = path.chars().collect();
    let len = chars.len();
    if len == 0 {
        return ".".to_owned();
    }
    if len == 1 {
        return if chars[0] == '/' {
            "\\".to_owned()
        } else {
            path.to_owned()
        };
    }
    let slice = |from: usize, to: usize| chars[from..to].iter().collect::<String>();
    let mut root_end = 0;
    let mut device: Option<String> = None;
    let mut absolute = false;
    if sep(chars[0]) {
        absolute = true;
        if sep(chars[1]) {
            let mut j = 2;
            let mut last = j;
            while j < len && !sep(chars[j]) {
                j += 1;
            }
            if j < len && j != last {
                let first = slice(last, j);
                last = j;
                while j < len && sep(chars[j]) {
                    j += 1;
                }
                if j < len && j != last {
                    last = j;
                    while j < len && !sep(chars[j]) {
                        j += 1;
                    }
                    if j == len {
                        return format!("\\\\{first}\\{}\\", slice(last, len));
                    }
                    if j != last {
                        device = Some(format!("\\\\{first}\\{}", slice(last, j)));
                        root_end = j;
                    }
                }
            }
        } else {
            root_end = 1;
        }
    } else if chars[0].is_ascii_alphabetic() && chars[1] == ':' {
        device = Some(slice(0, 2));
        root_end = 2;
        if len > 2 && sep(chars[2]) {
            absolute = true;
            root_end = 3;
        }
    }
    let mut tail = if root_end < len {
        normalize_parts(&chars[root_end..], !absolute, '\\', |c| {
            c == '/' || c == '\\'
        })
    } else {
        String::new()
    };
    if tail.is_empty() && !absolute {
        tail.push('.');
    }
    if !tail.is_empty() && sep(chars[len - 1]) {
        tail.push('\\');
    }
    match device {
        None if absolute => format!("\\{tail}"),
        None => tail,
        Some(device) if absolute => format!("{device}\\{tail}"),
        Some(device) => format!("{device}{tail}"),
    }
}
