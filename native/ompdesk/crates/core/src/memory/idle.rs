use std::collections::HashMap;

use serde::Serialize;

use super::ProcessRow;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct WatchProcesses<'a> {
    rows: &'a [ProcessRow],
    /// On POSIX a leaf is quiet at its own size (zero for an absent PID). On Windows a leaf is busy.
    busy_parents: Option<Vec<u32>>,
    /// Only quiet non-leaves need a footprint beyond the bytes already in the listing.
    quiet_trees: Vec<(u32, u64)>,
}

#[derive(Default)]
enum Children {
    #[default]
    ConsoleOnly,
    One(u32),
    Several,
}

impl<'a> WatchProcesses<'a> {
    pub(super) fn busy_parents(&self) -> Option<&[u32]> {
        self.busy_parents.as_deref()
    }

    pub(super) fn quiet_trees(&self) -> &[(u32, u64)] {
        &self.quiet_trees
    }

    pub(super) fn new(rows: &'a [ProcessRow], windows: bool) -> Self {
        let mut children = HashMap::<u32, Children>::new();
        for row in rows {
            // Index the parent even if its own row was gone when the OS listed its child.
            let work = children.entry(row.ppid).or_default();
            if !row
                .name
                .as_deref()
                .is_some_and(|name| name.eq_ignore_ascii_case("conhost.exe"))
            {
                *work = match work {
                    Children::ConsoleOnly => Children::One(row.pid),
                    _ => Children::Several,
                };
            }
        }
        let mut busy_parents = (!windows).then(Vec::new);
        let mut quiet_trees = Vec::new();
        for (&pid, work) in &children {
            let quiet = match (windows, work) {
                (false, Children::ConsoleOnly) => true,
                (true, Children::One(omp)) => {
                    matches!(children.get(omp), None | Some(Children::ConsoleOnly))
                }
                _ => false,
            };
            if quiet {
                quiet_trees.push((pid, 0));
            } else if let Some(busy) = &mut busy_parents {
                busy.push(pid);
            }
        }
        if !quiet_trees.is_empty() {
            fill_tree_bytes(rows, &mut quiet_trees);
        }
        Self {
            rows,
            busy_parents,
            quiet_trees,
        }
    }
}

/// Fold leaves into their parents once. Each member of a remaining cycle reaches the whole cycle
/// and all the branches already folded into it. OS snapshots contain one row per listed PID.
fn fill_tree_bytes(rows: &[ProcessRow], quiet: &mut [(u32, u64)]) {
    let by_pid: HashMap<_, _> = rows
        .iter()
        .enumerate()
        .map(|(i, row)| (row.pid, i))
        .collect();
    let mut children = vec![0usize; rows.len()];
    let mut totals: Vec<_> = rows.iter().map(|row| row.bytes).collect();
    for row in rows {
        if let Some(&parent) = by_pid.get(&row.ppid) {
            children[parent] += 1;
        }
    }
    let mut ready: Vec<_> = (0..rows.len()).filter(|&i| children[i] == 0).collect();
    while let Some(i) = ready.pop() {
        if let Some(&parent) = by_pid.get(&rows[i].ppid) {
            let bytes = totals[i];
            totals[parent] += bytes;
            children[parent] -= 1;
            if children[parent] == 0 {
                ready.push(parent);
            }
        }
    }
    for start in 0..rows.len() {
        if children[start] == 0 {
            continue;
        }
        let mut sum = 0;
        let mut i = start;
        while children[i] != 0 {
            sum += totals[i];
            children[i] = 0;
            ready.push(i);
            i = by_pid[&rows[i].ppid];
        }
        for i in ready.drain(..) {
            totals[i] = sum;
        }
    }
    for (pid, bytes) in quiet {
        *bytes = by_pid.get(pid).map_or(0, |&i| totals[i]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(pid: u32, ppid: u32, bytes: u64, image: &str) -> ProcessRow {
        ProcessRow {
            pid,
            ppid,
            bytes,
            name: Some(image.into()),
            cpu_ms: None,
        }
    }

    #[test]
    fn windows_counts_console_memory_but_only_work_below_the_one_omp_keeps_its_launcher() {
        let rows = [
            row(10, 1, 5, "omp.exe"),
            row(11, 10, 2, "ConHost.EXE"),
            row(12, 10, 300, "bun.exe"),
            row(13, 12, 3, "conhost.exe"),
            row(14, 13, 7, "helper.exe"),
            row(20, 1, 5, "cmd.exe"),
            row(21, 20, 2, "conhost.exe"),
            row(22, 20, 400, "bun.exe"),
            row(23, 22, 120, "python.exe"),
            row(24, 23, 2, "conhost.exe"),
            row(30, 1, 5, "cmd.exe"),
            row(31, 30, 90, "bun.exe"),
            row(32, 30, 120, "node.exe"),
            row(40, 1, 5, "omp.exe"),
            row(41, 40, 2, "conhost.exe"),
            // 50 and 60 disappeared before Toolhelp listed their children.
            row(51, 50, 200, "bun.exe"),
            row(61, 60, 200, "bun.exe"),
            row(62, 61, 10, "mcp.exe"),
        ];
        let sample = WatchProcesses::new(&rows, true);
        assert!(sample.busy_parents.is_none());
        let quiet: HashMap<_, _> = sample.quiet_trees.into_iter().collect();
        assert_eq!(quiet.get(&10), Some(&317));
        for busy in [20, 30, 40, 60, 999] {
            assert!(!quiet.contains_key(&busy), "pid {busy}");
        }
        assert_eq!(quiet.get(&50), Some(&0));
    }

    #[test]
    fn posix_reports_busy_parents_even_without_a_root_row_and_never_repeats_leaf_sizes() {
        let rows = super::super::parse_ps("101 100 20\n201 200 50\n102 101 30\n200 1 15");
        let sample = WatchProcesses::new(&rows, false);
        let mut busy = sample.busy_parents.unwrap();
        busy.sort_unstable();
        assert_eq!(busy, [1, 100, 101, 200]);
        assert!(sample.quiet_trees.is_empty());
    }

    #[test]
    fn cycles_include_their_attached_branches_once_without_recursing() {
        let rows = [
            row(6, 5, 20, "bun.exe"),
            row(5, 6, 10, "conhost.exe"),
            row(7, 5, 30, "conhost.exe"),
            row(8, 7, 40, "helper.exe"),
            row(9, 9, 3, "conhost.exe"),
        ];
        let windows = WatchProcesses::new(&rows, true);
        assert!(windows.quiet_trees.contains(&(5, 100)));
        let mut sizes = [(5, 0), (6, 0), (7, 0), (9, 0), (999, 0)];
        fill_tree_bytes(&rows, &mut sizes);
        assert_eq!(sizes, [(5, 100), (6, 100), (7, 70), (9, 3), (999, 0)]);
    }
}
