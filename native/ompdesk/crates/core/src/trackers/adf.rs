//! Jira Cloud's Atlassian Document Format to Markdown for reading, and plain Markdown text to ADF for a comment
//! (Orca `jira/adf-markdown.ts`, `jira/markdown-adf.ts:1-304`). Only links to `http`, `https` and `mailto` stay
//! links; anything else is its text.

use serde_json::{Value, json};

fn safe_link(href: &str) -> bool {
    let lower = href.trim().to_ascii_lowercase();
    lower.starts_with("https://") || lower.starts_with("http://") || lower.starts_with("mailto:")
}

fn attr<'a>(node: &'a Value, name: &str) -> &'a str {
    node.pointer(&format!("/attrs/{name}"))
        .and_then(Value::as_str)
        .unwrap_or_default()
}

fn children(node: &Value) -> &[Value] {
    node.get("content")
        .and_then(Value::as_array)
        .map_or(&[], Vec::as_slice)
}

fn inline(node: &Value) -> String {
    children(node).iter().map(text_node).collect()
}

fn text_node(node: &Value) -> String {
    match node.get("type").and_then(Value::as_str).unwrap_or_default() {
        "text" => {
            let mut text = node
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            let marks = node
                .get("marks")
                .and_then(Value::as_array)
                .map_or(&[][..], Vec::as_slice);
            for mark in marks {
                text = match mark.get("type").and_then(Value::as_str).unwrap_or_default() {
                    "strong" => format!("**{text}**"),
                    "em" => format!("*{text}*"),
                    "code" => format!("`{text}`"),
                    "strike" => format!("~~{text}~~"),
                    "link" if safe_link(attr(mark, "href")) => {
                        format!("[{text}]({})", attr(mark, "href"))
                    }
                    _ => text,
                };
            }
            text
        }
        "hardBreak" => "\n".to_owned(),
        "mention" => attr(node, "text").to_owned(),
        "emoji" => {
            let text = attr(node, "text");
            if text.is_empty() {
                attr(node, "shortName").to_owned()
            } else {
                text.to_owned()
            }
        }
        "inlineCard" | "blockCard" => attr(node, "url").to_owned(),
        "date" => attr(node, "timestamp").to_owned(),
        "status" => attr(node, "text").to_owned(),
        _ => inline(node),
    }
}

/// Several blocks, a blank line between them.
fn blocks(nodes: &[Value]) -> String {
    nodes
        .iter()
        .map(block)
        .filter(|text| !text.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n\n")
}

/// Every line of `text` after `prefix`, the first after `first`.
fn prefixed(text: &str, first: &str, rest: &str) -> String {
    text.lines()
        .enumerate()
        .map(|(index, line)| format!("{}{line}", if index == 0 { first } else { rest }))
        .collect::<Vec<_>>()
        .join("\n")
}

/// One block as Markdown (several lines where it has them).
fn block(node: &Value) -> String {
    let kind = node.get("type").and_then(Value::as_str).unwrap_or_default();
    match kind {
        "paragraph" => inline(node),
        "heading" => {
            let level = node
                .pointer("/attrs/level")
                .and_then(Value::as_u64)
                .unwrap_or(1)
                .clamp(1, 6);
            format!("{} {}", "#".repeat(level as usize), inline(node))
        }
        "bulletList" | "orderedList" | "taskList" => children(node)
            .iter()
            .enumerate()
            .map(|(index, item)| {
                let marker = match kind {
                    "orderedList" => format!("{}. ", index + 1),
                    "taskList" if attr(item, "state") == "DONE" => "- [x] ".to_owned(),
                    "taskList" => "- [ ] ".to_owned(),
                    _ => "- ".to_owned(),
                };
                let body = if item.get("type").and_then(Value::as_str) == Some("taskItem") {
                    inline(item)
                } else {
                    children(item)
                        .iter()
                        .map(block)
                        .collect::<Vec<_>>()
                        .join("\n")
                };
                prefixed(&body, &marker, "  ")
            })
            .collect::<Vec<_>>()
            .join("\n"),
        "codeBlock" => format!("```{}\n{}\n```", attr(node, "language"), inline(node)),
        "blockquote" | "panel" => prefixed(&blocks(children(node)), "> ", "> "),
        "rule" => "---".to_owned(),
        "mediaSingle" | "mediaGroup" | "media" => String::new(),
        "table" => children(node)
            .iter()
            .map(|row| {
                let cells: Vec<String> = children(row)
                    .iter()
                    .map(|cell| {
                        blocks(children(cell))
                            .replace('\n', " ")
                            .replace('|', "\\|")
                    })
                    .collect();
                format!("| {} |", cells.join(" | "))
            })
            .collect::<Vec<_>>()
            .join("\n"),
        _ if node.get("content").is_some() => blocks(children(node)),
        _ => text_node(node),
    }
}

/// A document as Markdown; a string (Jira Server's wiki text) as it is.
pub(super) fn to_markdown(value: &Value) -> String {
    match value.as_str() {
        Some(text) => text.to_owned(),
        None => blocks(children(value)).trim().to_owned(),
    }
}

/// A comment as a document: a paragraph per blank-line-separated block, each line break kept.
// shortcut: Markdown marks (bold, links, lists) go as their plain text; port Orca's full `markdown-adf.ts` when a
// person writes formatted comments here.
pub(super) fn from_markdown(text: &str) -> Value {
    let normalized = text.replace("\r\n", "\n");
    let paragraphs: Vec<Value> = normalized
        .split("\n\n")
        .map(|paragraph| paragraph.trim_matches('\n'))
        .filter(|paragraph| !paragraph.trim().is_empty())
        .map(|paragraph| {
            let mut content = Vec::new();
            for (index, line) in paragraph.split('\n').enumerate() {
                if index > 0 {
                    content.push(json!({ "type": "hardBreak" }));
                }
                if !line.is_empty() {
                    content.push(json!({ "type": "text", "text": line }));
                }
            }
            json!({ "type": "paragraph", "content": content })
        })
        .collect();
    json!({ "type": "doc", "version": 1, "content": paragraphs })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_document_reads_as_markdown_with_safe_links_only() {
        let doc = json!({"type": "doc", "version": 1, "content": [
            {"type": "heading", "attrs": {"level": 2}, "content": [{"type": "text", "text": "Steps"}]},
            {"type": "paragraph", "content": [
                {"type": "text", "text": "Open "},
                {"type": "text", "text": "the page", "marks": [{"type": "link", "attrs": {"href": "https://x.test"}}]},
                {"type": "text", "text": " and ", "marks": []},
                {"type": "text", "text": "this", "marks": [{"type": "link", "attrs": {"href": "javascript:alert(1)"}}]},
                {"type": "hardBreak"},
                {"type": "text", "text": "bold", "marks": [{"type": "strong"}]}
            ]},
            {"type": "bulletList", "content": [
                {"type": "listItem", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "one"}]}]},
                {"type": "listItem", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "two"}]}]}
            ]},
            {"type": "codeBlock", "attrs": {"language": "rs"}, "content": [{"type": "text", "text": "let a = 1;"}]}
        ]});
        assert_eq!(
            to_markdown(&doc),
            "## Steps\n\nOpen [the page](https://x.test) and this\n**bold**\n\n- one\n- two\n\n```rs\nlet a = 1;\n```"
        );
        assert_eq!(to_markdown(&json!("h1. Server wiki")), "h1. Server wiki");
    }

    #[test]
    fn a_comment_becomes_paragraphs_with_line_breaks() {
        assert_eq!(
            from_markdown("first\nsecond\n\nthird"),
            json!({"type": "doc", "version": 1, "content": [
                {"type": "paragraph", "content": [
                    {"type": "text", "text": "first"}, {"type": "hardBreak"}, {"type": "text", "text": "second"}
                ]},
                {"type": "paragraph", "content": [{"type": "text", "text": "third"}]}
            ]})
        );
    }
}
