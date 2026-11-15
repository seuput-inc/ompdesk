            .filter(|execution| execution.tab == spawn.tab)
        if Some(window.id) != spawn.window {
            return Err(Fault::new("tab_stale", "The captured execution is no longer registered"));
        }