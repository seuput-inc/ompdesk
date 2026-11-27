//! A bot's Look around (Orca's `shared/bots/bot-look-around.ts:42-62` setting and `:142-176` suggestion keys, and the
//! rules of `main/bots/bot-look-around-state.ts`, re-implemented): when its looks run, and the Suggestions list they
//! fill, kept apart from its items (Up next stays the items). Kept in `<userData>/looks.json` beside `items.json`
//! (mode 0o600, one JSON array, one entry per bot, written whole on every change), so a suggestion never rewrites the
//! bot record.
//!
//! A look is one turn of the bot's home chat that ends in one `ompdesk_bot suggest` call: what it lists replaces the
//! open list (a suggestion listed again keeps its id and age, so it neither moves nor reads as new), a dismissed one is
//! refused for 30 days in any wording that keys the same, and an open one is dropped after 3 days.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use super::{read_array, write_text};

/// Look around's presets (`LOOK_AROUND_EVERY_CHOICES`).
pub const EVERY_CHOICES: [&str; 4] = ["every-4h", "every-2h", "twice-daily", "mornings"];
/// The longest focus, in characters (`LOOK_AROUND_FOCUS_MAX_LENGTH`).
pub const FOCUS_MAX: usize = 500;
/// One suggestion's limits and how many one look lists (`SUGGESTION_LIMITS`).
pub const TITLE_MAX: usize = 80;
pub const WHY_MAX: usize = 400;
pub const ASK_MAX: usize = 2000;
pub const PER_LOOK: usize = 5;

const DAY_MS: f64 = 24.0 * 60.0 * 60.0 * 1000.0;
/// An open suggestion this old is dropped, even while looks keep failing.
pub const OPEN_FOR_MS: f64 = 3.0 * DAY_MS;
/// A dismissed suggestion is refused this long.
pub const DISMISSED_FOR_MS: f64 = 30.0 * DAY_MS;
/// Started titles a look is told about, so it learns what the owner acts on.
pub const STARTED_RECALL_MS: f64 = 14.0 * DAY_MS;
const SUGGESTIONS_KEPT: usize = 200;

/// The local hours each preset looks at; nothing runs at night (`LOOK_AROUND_EVERY`).
pub fn every_hours(every: &str) -> &'static [u8] {
    match every {
        "every-2h" => &[8, 10, 12, 14, 16, 18, 20],
        "twice-daily" => &[8, 13],
        "mornings" => &[8],
        _ => &[8, 12, 16, 20],
    }
}

/// A bot's Look around setting (`BotLookAround`); absent on a record means it was never set.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LookSetting {
    pub on: bool,
    pub every: String,
    pub weekdays_only: bool,
    /// What to look for, in the owner's words; empty is anything waiting on them.
    pub focus: String,
}

impl Default for LookSetting {
    /// `LOOK_AROUND_DEFAULTS`: on, every 4 hours, weekdays, no focus.
    fn default() -> Self {
        LookSetting {
            on: true,
            every: "every-4h".to_owned(),
            weekdays_only: true,
            focus: String::new(),
        }
    }
}

impl LookSetting {
    /// An unknown preset reads as the default one (Orca's `.catch('every-4h')`); a focus is cut to `FOCUS_MAX`.
    pub fn normalized(mut self) -> Self {
        if !EVERY_CHOICES.contains(&self.every.as_str()) {
            self.every = "every-4h".to_owned();
        }
        self.focus = self.focus.trim().chars().take(FOCUS_MAX).collect();
        self
    }

    /// The schedule as a five-field cron line in local time (`lookAroundSchedule`).
    pub fn cron(&self) -> String {
        let hours: Vec<String> = every_hours(&self.every).iter().map(u8::to_string).collect();
        format!(
            "0 {} * * {}",
            hours.join(","),
            if self.weekdays_only { "1-5" } else { "*" }
        )
    }
}

/// One next step a look suggested.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Suggestion {
    pub id: String,
    pub title: String,
    pub why: String,
    /// The message Start puts in the bot's message box, written as the owner.
    pub ask: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub link: Option<String>,
    /// Epoch ms it was first suggested.
    pub created_at: f64,
    /// `open`, `started`, `dismissed` or `replaced`.
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_at: Option<f64>,
}

/// A dismissed suggestion's key, refused for `DISMISSED_FOR_MS`; apart from `suggestions`, so their cap never frees one.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Dismissal {
    pub title: String,
    pub key: String,
    pub at: f64,
}

/// One bot's looks.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct BotLook {
    pub bot: String,
    pub suggestions: Vec<Suggestion>,
    pub dismissals: Vec<Dismissal>,
    /// When the owner last saw the list (epoch ms, 0 never): a suggestion made after it is new.
    pub seen_at: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_looked_at: Option<f64>,
}

/// One suggestion as a look hands it over.
#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
pub struct SuggestInput {
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub why: String,
    #[serde(default)]
    pub ask: String,
    #[serde(default)]
    pub link: Option<String>,
}

/// What the next look is told: titles still listed, started lately, dismissed lately.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct LookHistory {
    pub open: Vec<String>,
    pub started: Vec<String>,
    pub dismissed: Vec<String>,
}

impl BotLook {
    /// Open suggestions past their age become replaced; resolved ones past the dismiss window go, as do old dismissals.
    pub fn expire(&mut self, now: f64) {
        for entry in &mut self.suggestions {
            if entry.status == "open" && now - entry.created_at > OPEN_FOR_MS {
                entry.status = "replaced".to_owned();
                entry.resolved_at = Some(now);
            }
        }
        self.suggestions.retain(|entry| {
            entry.status == "open"
                || now - entry.resolved_at.unwrap_or(entry.created_at) <= DISMISSED_FOR_MS
        });
        let extra = self.suggestions.len().saturating_sub(SUGGESTIONS_KEPT);
        self.suggestions.drain(..extra);
        self.dismissals
            .retain(|entry| now - entry.at <= DISMISSED_FOR_MS);
    }

    /// One look's list: it replaces the open one. Every entry is checked before anything changes; the count listed.
    pub fn look(
        &mut self,
        inputs: &[SuggestInput],
        now: f64,
        mut new_id: impl FnMut() -> String,
    ) -> Result<usize, String> {
        if inputs.len() > PER_LOOK {
            return Err(format!(
                "At most {PER_LOOK} suggestions a look: keep the {PER_LOOK} that matter most."
            ));
        }
        let mut keys: Vec<String> = Vec::new();
        for input in inputs {
            let title = input.title.trim();
            if title.is_empty() || input.ask.trim().is_empty() {
                return Err("Each suggestion needs a title and an ask.".to_owned());
            }
            let long = |text: &str, max: usize| text.trim().chars().count() > max;
            if long(title, TITLE_MAX) || long(&input.why, WHY_MAX) || long(&input.ask, ASK_MAX) {
                return Err(format!(
                    "\"{title}\" is too long: title {TITLE_MAX}, why {WHY_MAX}, ask {ASK_MAX} characters at most."
                ));
            }
            let key = suggestion_key(title, input.link.as_deref());
            if keys.contains(&key) {
                return Err(format!("\"{title}\" is in this look twice: list it once."));
            }
            if self
                .dismissals
                .iter()
                .any(|entry| entry.key == key && now - entry.at <= DISMISSED_FOR_MS)
            {
                return Err(format!(
                    "Your owner dismissed \"{title}\" recently: leave it out, in any wording, and suggest the rest again."
                ));
            }
            if secret_like(&format!("{title}\n{}\n{}", input.why, input.ask))
                || input.link.as_deref().is_some_and(link_carries_credential)
            {
                return Err(format!(
                    "\"{title}\" looks like it holds a credential: leave secrets out of suggestions."
                ));
            }
            keys.push(key);
        }
        let mut listed: Vec<String> = Vec::new();
        for (input, key) in inputs.iter().zip(&keys) {
            let fields = |entry: &mut Suggestion| {
                entry.title = input.title.trim().to_owned();
                entry.why = input.why.trim().to_owned();
                entry.ask = input.ask.trim().to_owned();
                entry.link = input
                    .link
                    .as_deref()
                    .map(str::trim)
                    .filter(|link| !link.is_empty())
                    .map(str::to_owned);
            };
            match self.suggestions.iter_mut().find(|entry| {
                entry.status == "open"
                    && suggestion_key(&entry.title, entry.link.as_deref()) == *key
            }) {
                Some(earlier) => {
                    fields(earlier);
                    listed.push(earlier.id.clone());
                }
                None => {
                    let mut entry = Suggestion {
                        id: new_id(),
                        created_at: now,
                        status: "open".to_owned(),
                        ..Suggestion::default()
                    };
                    fields(&mut entry);
                    listed.push(entry.id.clone());
                    self.suggestions.push(entry);
                }
            }
        }
        for entry in &mut self.suggestions {
            if entry.status == "open" && !listed.contains(&entry.id) {
                entry.status = "replaced".to_owned();
                entry.resolved_at = Some(now);
            }
        }
        self.last_looked_at = Some(now);
        self.expire(now);
        Ok(listed.len())
    }

    /// The owner's Start or Dismiss moves an open suggestion out of the list once; a dismissed one is remembered.
    pub fn resolve(&mut self, id: &str, to: &str, now: f64) -> Result<Suggestion, &'static str> {
        let Some(entry) = self.suggestions.iter_mut().find(|entry| entry.id == id) else {
            return Err("That suggestion is gone.");
        };
        if entry.status != "open" {
            return Err("That suggestion is no longer listed.");
        }
        entry.status = to.to_owned();
        entry.resolved_at = Some(now);
        let resolved = entry.clone();
        if to == "dismissed" {
            let key = suggestion_key(&resolved.title, resolved.link.as_deref());
            self.dismissals.retain(|dismissal| dismissal.key != key);
            self.dismissals.push(Dismissal {
                title: resolved.title.clone(),
                key,
                at: now,
            });
        }
        Ok(resolved)
    }

    /// The open list at `now`, oldest first.
    pub fn open(&self, now: f64) -> Vec<&Suggestion> {
        self.suggestions
            .iter()
            .filter(|entry| entry.status == "open" && now - entry.created_at <= OPEN_FOR_MS)
            .collect()
    }

    /// Open suggestions the owner has not seen yet.
    pub fn unseen(&self, now: f64) -> usize {
        self.open(now)
            .iter()
            .filter(|entry| entry.created_at > self.seen_at)
            .count()
    }

    /// `lookHistory`.
    pub fn history(&self, now: f64) -> LookHistory {
        let titles = |status: &str, within: f64| -> Vec<String> {
            self.suggestions
                .iter()
                .filter(|entry| {
                    entry.status == status
                        && now - entry.resolved_at.unwrap_or(entry.created_at) <= within
                })
                .map(|entry| entry.title.clone())
                .collect()
        };
        LookHistory {
            open: self
                .open(now)
                .iter()
                .map(|entry| entry.title.clone())
                .collect(),
            started: titles("started", STARTED_RECALL_MS),
            dismissed: self
                .dismissals
                .iter()
                .filter(|entry| now - entry.at <= DISMISSED_FOR_MS)
                .map(|entry| entry.title.clone())
                .collect(),
        }
    }
}

/// The looks of every bot.
pub struct Looks {
    file: Option<PathBuf>,
    looks: Vec<BotLook>,
}

impl Looks {
    /// Loads `file` (None: memory only); an entry without its bot is left out.
    pub fn new(file: Option<PathBuf>) -> Looks {
        let looks = file
            .as_deref()
            .map(read_array)
            .unwrap_or_default()
            .into_iter()
            .filter_map(|look| serde_json::from_value::<BotLook>(look).ok())
            .filter(|look| !look.bot.is_empty())
            .collect();
        Looks { file, looks }
    }

    pub fn get(&self, bot: &str) -> Option<&BotLook> {
        self.looks.iter().find(|look| look.bot == bot)
    }

    /// Changes the bot's looks (made when it has none) and saves; what `change` answered.
    pub fn change<T>(&mut self, bot: &str, change: impl FnOnce(&mut BotLook) -> T) -> T {
        let at = match self.looks.iter().position(|look| look.bot == bot) {
            Some(at) => at,
            None => {
                self.looks.push(BotLook {
                    bot: bot.to_owned(),
                    ..BotLook::default()
                });
                self.looks.len() - 1
            }
        };
        let before = self.looks[at].clone();
        let answer = change(&mut self.looks[at]);
        if self.looks[at] != before {
            self.save();
        }
        answer
    }

    pub fn remove_bot(&mut self, bot: &str) {
        let before = self.looks.len();
        self.looks.retain(|look| look.bot != bot);
        if self.looks.len() != before {
            self.save();
        }
    }

    fn save(&self) {
        let Some(file) = &self.file else { return };
        let text = serde_json::to_string(&self.looks).unwrap_or_else(|_| "[]".to_owned());
        if let Err(error) = write_text(file, &text, Some(0o600)) {
            eprintln!("[bots] looks not saved: {error}");
        }
    }
}

/// What makes two suggestions the same: the thing their link names, else their title (`suggestionKey`).
pub fn suggestion_key(title: &str, link: Option<&str>) -> String {
    match link.and_then(normalized_link) {
        Some(link) => format!("link:{link}"),
        None => format!("title:{}", title_key(title)),
    }
}

/// A title ignoring case and spacing.
pub fn title_key(title: &str) -> String {
    title
        .to_lowercase()
        .split_whitespace()
        .collect::<Vec<&str>>()
        .join(" ")
}

/// A link's parts: host (no user, no port), path, and the query and fragment parameter names. None: no `scheme://host`.
struct LinkParts<'a> {
    user: bool,
    host: String,
    path: &'a str,
    params: Vec<&'a str>,
}

fn link_parts(link: &str) -> Option<LinkParts<'_>> {
    let (scheme, rest) = link.trim().split_once("://")?;
    if scheme.is_empty()
        || !scheme
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "+-.".contains(c))
    {
        return None;
    }
    let authority_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..authority_end];
    let (user, host_port) = match authority.rsplit_once('@') {
        Some((_, host)) => (true, host),
        None => (false, authority),
    };
    let host = host_port.split(':').next().unwrap_or("").to_lowercase();
    if host.is_empty() {
        return None;
    }
    let tail = &rest[authority_end..];
    let path_end = tail.find(['?', '#']).unwrap_or(tail.len());
    let path = &tail[..path_end];
    let params = tail[path_end..]
        .split(['?', '#', '&'])
        .filter(|part| !part.is_empty())
        .map(|part| part.split('=').next().unwrap_or(""))
        .collect();
    Some(LinkParts {
        user,
        host,
        path,
        params,
    })
}

/// A link as the thing it names: lower case, no query or fragment, nothing past a GitHub pull request's or issue's
/// number or a Linear issue's key, so `…/pull/12/files#r1` and `…/pull/12` are one.
fn normalized_link(link: &str) -> Option<String> {
    let parts = link_parts(link)?;
    let path = parts.path.to_lowercase();
    let segments: Vec<&str> = path.split('/').filter(|part| !part.is_empty()).collect();
    let numbered = |at: usize| {
        segments
            .get(at + 1)
            .is_some_and(|next| !next.is_empty() && next.chars().all(|c| c.is_ascii_digit()))
    };
    let github = segments
        .iter()
        .position(|part| *part == "pull" || *part == "issues")
        .filter(|at| numbered(*at));
    let linear = segments
        .iter()
        .position(|part| *part == "issue")
        .filter(|at| segments.get(at + 1).is_some());
    let kept = match (github, linear) {
        (Some(at), _) | (None, Some(at)) => &segments[..at + 2],
        (None, None) => &segments[..],
    };
    let host = parts
        .host
        .strip_prefix("www.")
        .unwrap_or(parts.host.as_str());
    Some(format!("{host}/{}", kept.join("/")))
}

/// A link that names a credential: in its text, its user part, or a query or fragment parameter's name
/// (`linkCarriesCredential`). One that does not parse counts as one.
pub fn link_carries_credential(link: &str) -> bool {
    if secret_like(link) {
        return true;
    }
    let Some(parts) = link_parts(link) else {
        return true;
    };
    parts.user
        || parts.params.iter().any(|name| {
            let name = name.to_lowercase();
            name == "sig"
                || [
                    "token",
                    "secret",
                    "passw",
                    "apikey",
                    "api_key",
                    "api-key",
                    "accesskey",
                    "access_key",
                    "access-key",
                    "signature",
                    "auth",
                    "credential",
                    "session",
                ]
                .iter()
                .any(|word| name.contains(word))
        })
}

/// A token's prefixes, its shortest run after them, which bytes the run takes, and whether the prefix is any case.
type Shape<'a> = (&'a [&'a str], usize, &'a dyn Fn(u8) -> bool, bool);

/// Whether `text` holds a token or key in a shape Orca's `containsSecretLike` redacts: GitHub, GitLab, OpenAI-style,
/// Slack and AWS keys, a bearer token, a private key block, or a URL with a user and password.
pub fn secret_like(text: &str) -> bool {
    let token = |c: u8| c.is_ascii_alphanumeric() || c == b'_';
    let dashed = |c: u8| c.is_ascii_alphanumeric() || c == b'_' || c == b'-';
    let slack = |c: u8| c.is_ascii_alphanumeric() || c == b'-';
    let aws = |c: u8| c.is_ascii_digit() || c.is_ascii_uppercase();
    let bearer = |c: u8| c.is_ascii_alphanumeric() || b"._~+/-".contains(&c);
    let shapes: [Shape<'_>; 7] = [
        (&["ghp_", "gho_", "ghu_", "ghs_", "ghr_"], 20, &token, false),
        (&["github_pat_"], 20, &token, false),
        (&["glpat-"], 20, &dashed, false),
        (&["sk-"], 20, &dashed, false),
        (
            &["xoxb-", "xoxa-", "xoxp-", "xoxr-", "xoxs-"],
            10,
            &slack,
            false,
        ),
        (&["AKIA"], 16, &aws, false),
        (&["bearer "], 20, &bearer, true),
    ];
    let lower = text.to_ascii_lowercase();
    let bytes = text.as_bytes();
    for (prefixes, min, allowed, any_case) in shapes {
        let haystack = if any_case { lower.as_str() } else { text };
        for prefix in prefixes {
            for (at, _) in haystack.match_indices(prefix) {
                if at > 0 && token(bytes[at - 1]) {
                    continue;
                }
                let run = bytes[at + prefix.len()..]
                    .iter()
                    .take_while(|c| allowed(**c))
                    .count();
                if run >= min {
                    return true;
                }
            }
        }
    }
    if text.contains("-----BEGIN ") && text.contains("PRIVATE KEY-----") {
        return true;
    }
    // `user:password@host`.
    text.split_whitespace().any(|word| {
        let after = word.split_once("://").map_or(word, |(_, rest)| rest);
        let authority = after.split('/').next().unwrap_or("");
        authority
            .rsplit_once('@')
            .is_some_and(|(user, host)| user.contains(':') && !host.is_empty())
    })
}
