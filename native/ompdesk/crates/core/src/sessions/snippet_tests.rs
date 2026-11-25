use super::*;

fn wire(raw: &str, query: Query) -> Option<String> {
    let tokens = query.tokens();
    let lower = lowercase(raw);
    if !tokens.iter().all(|t| t.contains(&lower)) {
        return None;
    }
    let aligned = raw.encode_utf16().count() == lower.encode_utf16().count();
    excerpt(raw, &lower, aligned, tokens.first()?).map(|s| s.get().to_owned())
}

fn snippet(raw: &str, query: &str) -> Option<String> {
    wire(raw, Query::Text(query.into())).map(|s| serde_json::from_str(&s).unwrap())
}

#[test]
fn tokenizes_js_spaces_and_uses_contextual_unicode_lowercase() {
    let raw = "\"\\nΟΣ\\tİ\\r\"";
    assert_eq!(lowercase("ΟΣ ΟΣΑ İ"), "ος οσα i\u{307}");
    assert_eq!(snippet(raw, "ΟΣ"), None); // Folding changed the length of the complete file.
    let raw = "\"ΟΣ ΟΣΑ B\u{85}C\"";
    assert_eq!(
        snippet(raw, "\u{feff}ΟΣ\u{a0}ΟΣΑ\u{2028}B\u{85}C").as_deref(),
        Some("ΟΣ ΟΣΑ B\u{85}C")
    );
    assert_eq!(snippet(raw, "B\u{85}ΟΣ"), None);
    assert_eq!(snippet(raw, " \u{feff}\u{2029}"), None);
    assert_eq!(
        snippet("\"Kelvin Δ\"", "KELVIN").as_deref(),
        Some("Kelvin Δ")
    );
}

#[test]
fn skips_bad_lines_and_prefers_message_to_first_metadata_hit() {
    let prefix = "{broken needle\n{\"dir\":\"Needle header\"}\n{\"message\":null,\"text\":\"needle ignored\"}\n\"Needle second fallback\"";
    assert_eq!(snippet(prefix, "needle").as_deref(), Some("Needle header"));
    let raw = format!(
        "{prefix}\n{}",
        r#"{"outer":"needle ignored","message":{"text":[false,"  A\n\tNeedle\uFEFFplan  "]}}"#
    );
    assert_eq!(
        snippet(&raw, "needle plan").as_deref(),
        Some("A Needle plan")
    );
    assert_eq!(snippet(r#"{"needle":1,"other":"\u006e"}"#, "needle"), None);
    assert_eq!(snippet(r#"{"message":"Needle"} trailing"#, "needle"), None);
    assert_eq!(
        snippet(r#"{"n":1e999,"message":"Needle"}"#, "needle").as_deref(),
        Some("Needle")
    );
}

#[test]
fn counts_matching_lines_including_malformed_lines_not_occurrences() {
    let fallback = "\"Hit fallback\"\n";
    let malformed = "hit hit hit not JSON\n";
    let final_line = r#"{"message":"Hit conversation"}"#;
    for (n, expected) in [(48, "Hit conversation"), (49, "Hit fallback")] {
        let raw = format!(
            "{fallback}{}{}{final_line}",
            malformed.repeat(n),
            "not a match\n".repeat(100)
        );
        assert_eq!(snippet(&raw, "hit").as_deref(), Some(expected));
    }
}

#[test]
fn quotes_object_values_in_javascript_order_after_duplicate_overwrites() {
    for (fields, expected) in [
        (
            r#""z":"hit z","10":"hit ten","\u0032":["hit two","hit later"]"#,
            "hit two",
        ),
        (
            r#""4294967295":"hit max","01":"hit padded","4294967294":"hit index""#,
            "hit index",
        ),
        (
            r#""z":"hit first","1":"miss","01":"hit padded","+0":"hit plus","a":"hit a""#,
            "hit first",
        ),
        (r#""1":"hit overwritten","2":"hit two","1":null"#, "hit two"),
        (
            r#""x":null,"y":"hit next","\u0078":"hit replacement""#,
            "hit replacement",
        ),
        (
            r#""\ud800":"hit high","\ud801":"hit other","\ud800":"miss""#,
            "hit other",
        ),
    ] {
        let raw = format!("{{\"message\":{{{fields}}}}}");
        assert_eq!(snippet(&raw, "hit").as_deref(), Some(expected), "{raw}");
    }
    let raw = r#"{"message":"hit overwritten","fallback":"hit ignored","message":false}"#;
    assert_eq!(snippet(raw, "hit"), None);
}

#[test]
fn clips_exactly_seventy_utf16_units_and_quotes_cut_halves() {
    let a = "a".repeat(69);
    let b = "b".repeat(69);
    let raw = format!("\"😀{a}Hit{b}🧠\"");
    let expected = format!("\"…\\ude00{a}Hit{b}\\ud83e…\"");
    assert_eq!(wire(&raw, Query::Text("hit".into())), Some(expected));
    let pad = "z".repeat(70);
    let raw = format!("\"{pad}Hit{pad}\"");
    assert_eq!(snippet(&raw, "hit"), Some(format!("{pad}Hit{pad}")));
    let raw = format!(r#""\u0130{pad}Hit""#);
    assert_eq!(
        snippet(&raw, "hit"),
        Some(format!("…{}Hit", "z".repeat(69)))
    );
    let raw = format!(r#""before\t{a}Hit{b}\n after""#);
    assert_eq!(snippet(&raw, "hit"), Some(format!("…{a}Hit{b}…")));
}

#[test]
fn keeps_escaped_lone_units_distinct_from_replacement_characters_and_literal_escapes() {
    let raw = r#"{"message":"\ud801\ud800Hit\u0000\\ud802\udfff"}"#;
    assert_eq!(
        wire(raw, Query::Text("hit".into())).as_deref(),
        Some(r#""\ud801\ud800Hit\u0000\\ud802\udfff""#)
    );
    let raw = r#"{"message":["\ud800","literal �"]}"#;
    assert_eq!(snippet(raw, "�").as_deref(), Some("literal �"));
}

#[test]
fn searches_both_halves_of_astral_characters_with_unpaired_query_tokens() {
    let raw = r#"{"message":"First 😀A😁 last"}"#;
    for query in [
        vec![0xd83d],
        vec![0xde00, 65, 0xd83d],
        vec![0xfeff, 0xde01, 32, 0x46],
    ] {
        assert_eq!(
            wire(raw, Query::Units(query)).as_deref(),
            Some("\"First 😀A😁 last\"")
        );
    }
    assert_eq!(wire(raw, Query::Units(vec![0xd800])), None);
    let raw = r#"{"message":["\ud83d at start","😀"]}"#;
    assert_eq!(
        wire(raw, Query::Units(vec![0xd83d])).as_deref(),
        Some(r#""\ud83d at start""#)
    );
}

#[test]
fn reads_nested_values_without_serde_values_default_depth_limit() {
    let raw = format!(
        r#"{{"message":{}"Deep hit"{}}}"#,
        "[".repeat(256),
        "]".repeat(256)
    );
    assert_eq!(snippet(&raw, "hit").as_deref(), Some("Deep hit"));
}
