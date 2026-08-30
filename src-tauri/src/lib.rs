use futures::future::join_all;
use futures::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use tauri::{ipc::Channel, AppHandle, State};
use tauri_plugin_updater::UpdaterExt;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
    #[serde(default)]
    pub images: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ChatReply {
    pub content: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(tag = "event", content = "data", rename_all = "camelCase")]
pub enum StreamEvent {
    Token(String),
    Done,
    Stopped,
}

#[derive(Default)]
pub struct GenerationState(Mutex<HashMap<String, Arc<AtomicBool>>>);

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub current_version: String,
    pub version: String,
    pub date: Option<String>,
    pub body: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(tag = "event", content = "data", rename_all = "camelCase")]
pub enum UpdateEvent {
    Started { content_length: Option<u64> },
    Progress { downloaded: u64, content_length: Option<u64> },
    Finished,
}

const NTH_UPDATE_ENDPOINT: &str =
    "https://github.com/Houars/NTH./releases/latest/download/latest.json";

fn update_endpoint() -> Result<reqwest::Url, String> {
    reqwest::Url::parse(NTH_UPDATE_ENDPOINT)
        .map_err(|_| "NTH's signed release channel is invalid.".to_string())
}

#[tauri::command]
async fn check_update(app: AppHandle) -> Result<Option<UpdateInfo>, String> {
    let updater = app
        .updater_builder()
        .endpoints(vec![update_endpoint()?])
        .map_err(|error| error.to_string())?
        .build()
        .map_err(|error| error.to_string())?;

    let update = updater.check().await.map_err(|error| error.to_string())?;
    Ok(update.map(|update| UpdateInfo {
        current_version: update.current_version,
        version: update.version,
        date: update.date.map(|date| date.to_string()),
        body: update.body,
    }))
}

#[tauri::command]
async fn install_update(
    app: AppHandle,
    on_event: Channel<UpdateEvent>,
) -> Result<(), String> {
    let updater = app
        .updater_builder()
        .endpoints(vec![update_endpoint()?])
        .map_err(|error| error.to_string())?
        .build()
        .map_err(|error| error.to_string())?;
    let update = updater
        .check()
        .await
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "NTH is already up to date.".to_string())?;

    let progress_channel = on_event.clone();
    let finish_channel = on_event.clone();
    let mut downloaded = 0_u64;
    let mut started = false;

    update
        .download_and_install(
            move |chunk_length, content_length| {
                if !started {
                    started = true;
                    let _ = progress_channel.send(UpdateEvent::Started { content_length });
                }
                downloaded += chunk_length as u64;
                let _ = progress_channel.send(UpdateEvent::Progress {
                    downloaded,
                    content_length,
                });
            },
            move || {
                let _ = finish_channel.send(UpdateEvent::Finished);
            },
        )
        .await
        .map_err(|error| error.to_string())
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SearchSource {
    pub title: String,
    pub url: String,
    pub snippet: String,
    pub domain: String,
    pub published_date: String,
    pub engine: String,
    pub official: bool,
    pub quality: String,
    pub score: i32,
    // Kept for backwards-compatible UI data already stored by older NTH builds.
    pub content: String,
    pub fetched: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SearchBundle {
    pub query: String,
    pub intent: String,
    pub search_queries: Vec<String>,
    pub sources: Vec<SearchSource>,
    pub evidence: String,
    pub engine_warnings: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum SearchIntent {
    CurrentProduct,
    LatestNews,
    Price,
    PersonAge,
    Rumor,
    GeneralFresh,
}

impl SearchIntent {
    fn label(self) -> &'static str {
        match self {
            SearchIntent::CurrentProduct => "current_product",
            SearchIntent::LatestNews => "latest_news",
            SearchIntent::Price => "price",
            SearchIntent::PersonAge => "person_age",
            SearchIntent::Rumor => "rumor",
            SearchIntent::GeneralFresh => "general_fresh",
        }
    }
}

fn detect_intent(query: &str) -> SearchIntent {
    let q = query.to_lowercase();

    if [
        "rumor", "rumour", "leak", "leaked", "upcoming", "future", "roadmap",
    ]
    .iter()
    .any(|x| q.contains(x))
    {
        return SearchIntent::Rumor;
    }

    if ["price", "cost", "worth", "how much", "deal", "sale"]
        .iter()
        .any(|x| q.contains(x))
    {
        return SearchIntent::Price;
    }

    if q.contains("how old is") || q.contains("age of ") {
        return SearchIntent::PersonAge;
    }

    if ["news", "breaking", "today", "this week", "latest news"]
        .iter()
        .any(|x| q.contains(x))
    {
        return SearchIntent::LatestNews;
    }

    let current_word = [
        "newest",
        "latest",
        "current",
        "currently",
        "most recent",
        "released",
        "new model",
        "new version",
    ]
    .iter()
    .any(|x| q.contains(x));

    let product_word = [
        "gpu",
        "graphics card",
        "phone",
        "smartphone",
        "cpu",
        "processor",
        "laptop",
        "tablet",
        "console",
        "model",
        "version",
        "browser",
        "camera",
        "headphone",
        "headset",
        "watch",
        "chip",
        "device",
    ]
    .iter()
    .any(|x| q.contains(x));

    if current_word && product_word {
        SearchIntent::CurrentProduct
    } else {
        SearchIntent::GeneralFresh
    }
}

fn domain_from_url(url: &str) -> String {
    let after_scheme = url.split("://").nth(1).unwrap_or(url);
    after_scheme
        .split('/')
        .next()
        .unwrap_or("")
        .trim_start_matches("www.")
        .to_lowercase()
}

fn truncate_chars(s: &str, max_chars: usize) -> String {
    if s.chars().count() <= max_chars {
        return s.to_string();
    }
    s.chars().take(max_chars).collect::<String>() + "…"
}

fn official_domain_for_query(query: &str) -> Option<&'static str> {
    let q = query.to_lowercase();

    let mappings = [
        ("nvidia", "nvidia.com"),
        ("samsung", "samsung.com"),
        ("apple", "apple.com"),
        ("microsoft", "microsoft.com"),
        ("windows", "microsoft.com"),
        ("amd", "amd.com"),
        ("ryzen", "amd.com"),
        ("radeon", "amd.com"),
        ("intel", "intel.com"),
        ("google", "google.com"),
        ("pixel", "google.com"),
        ("openai", "openai.com"),
        ("chatgpt", "openai.com"),
        ("meta", "meta.com"),
        ("playstation", "playstation.com"),
        ("sony", "sony.com"),
        ("xbox", "xbox.com"),
        ("steam", "steampowered.com"),
        ("discord", "discord.com"),
        ("mozilla", "mozilla.org"),
        ("firefox", "mozilla.org"),
    ];

    for (needle, domain) in mappings {
        if q.contains(needle) {
            return Some(domain);
        }
    }
    None
}

fn build_search_queries(query: &str, intent: SearchIntent) -> Vec<String> {
    let trimmed = query.trim();
    let mut queries = vec![trimmed.to_string()];
    let official = official_domain_for_query(trimmed);

    match intent {
        SearchIntent::CurrentProduct => {
            let precision = if let Some(domain) = official {
                format!(
                    "site:{} {} exact current released model flagship official",
                    domain, trimmed
                )
            } else {
                format!("{} exact current released model flagship official", trimmed)
            };
            queries.push(precision);
            queries.push(format!("{} latest released model exact name", trimmed));
        }
        SearchIntent::Price => {
            queries.push(format!("{} current retail price buy available", trimmed));
            queries.push(format!("{} current price comparison retailer", trimmed));
        }
        SearchIntent::PersonAge => {
            queries.push(format!("{} date of birth current age", trimmed));
        }
        SearchIntent::LatestNews => {
            queries.push(format!("{} latest official news announcement", trimmed));
        }
        SearchIntent::Rumor => {
            queries.push(format!("{} latest report leak rumor", trimmed));
            queries.push(format!(
                "{} latest leak report roadmap speculation",
                trimmed
            ));
        }
        SearchIntent::GeneralFresh => {}
    }

    queries
}

fn contains_any(haystack: &str, needles: &[&str]) -> bool {
    needles.iter().any(|n| haystack.contains(n))
}

fn source_quality(domain: &str, official_domain: Option<&str>) -> (&'static str, bool) {
    if let Some(official) = official_domain {
        if domain == official || domain.ends_with(&format!(".{}", official)) {
            return ("official", true);
        }
    }

    if contains_any(
        domain,
        &[
            "reuters.com",
            "apnews.com",
            "bloomberg.com",
            "ft.com",
            "wsj.com",
            "bbc.com",
            "cnbc.com",
        ],
    ) {
        return ("news_authority", false);
    }

    if contains_any(
        domain,
        &[
            "tomshardware.com",
            "techpowerup.com",
            "anandtech.com",
            "igorslab.de",
            "computerbase.de",
            "heise.de",
            "arstechnica.com",
            "theverge.com",
            "sammobile.com",
            "videocardz.com",
            "guru3d.com",
        ],
    ) {
        return ("specialist", false);
    }

    if contains_any(
        domain,
        &[
            "bestbuy.com",
            "amazon.",
            "newegg.com",
            "walmart.com",
            "mediamarkt.",
            "saturn.",
            "mindfactory.de",
            "alternate.de",
            "caseking.de",
        ],
    ) {
        return ("retailer", false);
    }

    if contains_any(
        domain,
        &[
            "idealo.de",
            "geizhals.",
            "gpupricehistory.com",
            "pricehistory",
        ],
    ) {
        return ("price_tracker", false);
    }

    if contains_any(domain, &["wikipedia.org"]) {
        return ("reference", false);
    }

    if contains_any(
        domain,
        &[
            "reddit.com",
            "x.com",
            "twitter.com",
            "facebook.com",
            "tiktok.com",
            "quora.com",
            "youtube.com",
            "fandom.com",
            "overclock.net",
        ],
    ) {
        return ("community", false);
    }

    if contains_any(domain, &["msn.com"]) {
        return ("aggregator", false);
    }

    ("web", false)
}

fn score_result(
    query: &str,
    intent: SearchIntent,
    title: &str,
    snippet: &str,
    url: &str,
    rank: usize,
    query_index: usize,
    published_date: &str,
) -> (i32, String, bool) {
    let q = query.to_lowercase();
    let title_l = title.to_lowercase();
    let snippet_l = snippet.to_lowercase();
    let url_l = url.to_lowercase();
    let combined = format!("{} {} {}", title_l, snippet_l, url_l);
    let domain = domain_from_url(url);
    let official_domain = official_domain_for_query(query);
    let (quality, official) = source_quality(&domain, official_domain);

    let tokens: Vec<String> = q
        .split_whitespace()
        .map(|s| s.trim_matches(|c: char| !c.is_alphanumeric()).to_string())
        .filter(|s| s.len() >= 3)
        .collect();

    let mut score = 120 - (rank as i32 * 4);

    // Precision/official search is deliberately a little stronger than the raw query.
    if query_index > 0 {
        score += 12;
    }

    for token in &tokens {
        if title_l.contains(token) {
            score += 8;
        }
        if snippet_l.contains(token) {
            score += 3;
        }
        if url_l.contains(token) {
            score += 2;
        }
    }

    match quality {
        "official" => {
            score += match intent {
                SearchIntent::CurrentProduct => 120,
                SearchIntent::LatestNews => 65,
                SearchIntent::Price => 20,
                SearchIntent::Rumor => 12,
                _ => 55,
            };
        }
        "news_authority" => {
            score += match intent {
                SearchIntent::LatestNews => 85,
                SearchIntent::Rumor => 45,
                SearchIntent::CurrentProduct => 20,
                _ => 35,
            };
        }
        "specialist" => {
            score += match intent {
                SearchIntent::Rumor => 65,
                SearchIntent::LatestNews => 45,
                SearchIntent::CurrentProduct => 32,
                SearchIntent::Price => 12,
                _ => 24,
            };
        }
        "price_tracker" => {
            if intent == SearchIntent::Price {
                score += 75;
            } else {
                score -= 5;
            }
        }
        "retailer" => {
            if intent == SearchIntent::Price {
                score += 65;
            } else {
                score -= 10;
            }
        }
        "reference" => {
            if intent == SearchIntent::PersonAge {
                score += 50;
            } else {
                score += 12;
            }
        }
        "community" => {
            if intent == SearchIntent::Rumor {
                score += 8;
            } else {
                score -= 100;
            }
        }
        "aggregator" => score -= 30,
        _ => {}
    }

    let rumor_terms = [
        "rumor",
        "rumour",
        "leak",
        "leaked",
        "upcoming",
        "expected",
        "reportedly",
        "allegedly",
        "prototype",
        "roadmap",
        "next flagship",
        "next-generation",
        "next generation",
        "could launch",
        "may launch",
    ];

    if intent == SearchIntent::CurrentProduct && contains_any(&combined, &rumor_terms) {
        score -= 180;
    }

    // "Newest/current" means released NOW. Future-looking language is a strong negative.
    if intent == SearchIntent::CurrentProduct
        && contains_any(
            &combined,
            &["future", "coming in", "coming next", "unreleased"],
        )
    {
        score -= 130;
    }

    if intent == SearchIntent::LatestNews {
        if !published_date.trim().is_empty() {
            score += 35;
        } else {
            score -= 25;
        }
    }

    // Product pages are especially useful for current-product questions.
    if intent == SearchIntent::CurrentProduct
        && contains_any(
            &url_l,
            &[
                "/geforce/",
                "/galaxy-",
                "/products/",
                "/product/",
                "/graphics-cards/",
            ],
        )
    {
        score += 16;
    }

    (score, quality.to_string(), official)
}

async fn searx_request(
    client: reqwest::Client,
    base: String,
    query: String,
    intent: SearchIntent,
) -> Result<Value, String> {
    let mut url = format!(
        "{}/search?q={}&format=json&language=all&safesearch=0",
        base.trim_end_matches('/'),
        urlencoding::encode(query.trim())
    );

    if intent == SearchIntent::LatestNews {
        url.push_str("&categories=news&time_range=week");
    }

    let response = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("SearXNG request failed: {e}"))?;

    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|e| format!("Could not read SearXNG response: {e}"))?;

    if !status.is_success() {
        return Err(format!(
            "SearXNG returned {status}: {}",
            truncate_chars(&body, 300)
        ));
    }

    serde_json::from_str(&body).map_err(|e| {
        format!(
            "SearXNG did not return valid JSON: {e}. Response: {}",
            truncate_chars(&body, 250)
        )
    })
}

#[tauri::command]
async fn ollama_ping() -> Result<bool, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(3))
        .build()
        .map_err(|e| e.to_string())?;

    Ok(client
        .get("http://127.0.0.1:11434/api/tags")
        .send()
        .await
        .map(|r| r.status().is_success())
        .unwrap_or(false))
}

#[tauri::command]
async fn ollama_chat(
    model: String,
    policy: String,
    messages: Vec<ChatMessage>,
    max_tokens: Option<u32>,
) -> Result<ChatReply, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(45))
        .build()
        .map_err(|e| e.to_string())?;

    let mut api_messages: Vec<Value> = vec![json!({
        "role": "system",
        "content": policy
    })];

    for m in messages {
        let mut item = json!({
            "role": m.role,
            "content": m.content,
        });

        if !m.images.is_empty() {
            item["images"] = json!(m.images);
        }
        api_messages.push(item);
    }

    let payload = json!({
        "model": model,
        "messages": api_messages,
        "stream": false,
        "think": false,
        "keep_alive": "30m",
        "options": {
            "temperature": 0,
            "num_predict": max_tokens.unwrap_or(384)
        }
    });

    let res = client
        .post("http://127.0.0.1:11434/api/chat")
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Ollama request failed: {e}"))?;

    if !res.status().is_success() {
        let status = res.status();
        let body = res.text().await.unwrap_or_default();
        return Err(format!(
            "Ollama returned {status}: {}",
            truncate_chars(&body, 400)
        ));
    }

    let data: Value = res
        .json()
        .await
        .map_err(|e| format!("Could not decode Ollama response: {e}"))?;

    let content = data["message"]["content"]
        .as_str()
        .unwrap_or("")
        .trim()
        .to_string();

    Ok(ChatReply { content })
}

fn parse_ollama_stream_line(line: &[u8]) -> Result<(String, bool), String> {
    let data: Value =
        serde_json::from_slice(line).map_err(|e| format!("Could not decode Ollama stream: {e}"))?;

    if let Some(error) = data["error"].as_str() {
        return Err(error.to_string());
    }

    Ok((
        data["message"]["content"]
            .as_str()
            .unwrap_or("")
            .to_string(),
        data["done"].as_bool().unwrap_or(false),
    ))
}

async fn ollama_chat_stream_inner(
    model: String,
    policy: String,
    messages: Vec<ChatMessage>,
    max_tokens: Option<u32>,
    on_event: Channel<StreamEvent>,
    cancelled: Arc<AtomicBool>,
) -> Result<ChatReply, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(45))
        .build()
        .map_err(|e| e.to_string())?;

    let mut api_messages: Vec<Value> = vec![json!({
        "role": "system",
        "content": policy
    })];

    for message in messages {
        let mut item = json!({
            "role": message.role,
            "content": message.content,
        });

        if !message.images.is_empty() {
            item["images"] = json!(message.images);
        }
        api_messages.push(item);
    }

    // These generation parameters are the frozen NTH core. Streaming changes
    // delivery only; it does not change model behavior.
    let payload = json!({
        "model": model,
        "messages": api_messages,
        "stream": true,
        "think": false,
        "keep_alive": "30m",
        "options": {
            "temperature": 0,
            "num_predict": max_tokens.unwrap_or(384)
        }
    });

    let response = client
        .post("http://127.0.0.1:11434/api/chat")
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("Ollama request failed: {e}"))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!(
            "Ollama returned {status}: {}",
            truncate_chars(&body, 400)
        ));
    }

    let mut body = response.bytes_stream();
    let mut buffer: Vec<u8> = Vec::new();
    let mut content = String::new();
    let mut finished = false;

    while let Some(chunk) = body.next().await {
        if cancelled.load(Ordering::Relaxed) {
            break;
        }

        let chunk = chunk.map_err(|e| format!("Ollama stream failed: {e}"))?;
        buffer.extend_from_slice(&chunk);

        while let Some(newline) = buffer.iter().position(|byte| *byte == b'\n') {
            let mut line: Vec<u8> = buffer.drain(..=newline).collect();
            line.pop();
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            if line.is_empty() {
                continue;
            }

            let (token, done) = parse_ollama_stream_line(&line)?;
            if !token.is_empty() {
                content.push_str(&token);
                on_event
                    .send(StreamEvent::Token(token))
                    .map_err(|e| format!("Could not deliver Ollama stream: {e}"))?;
            }
            if done {
                finished = true;
                break;
            }
        }

        if finished {
            break;
        }
    }

    if !cancelled.load(Ordering::Relaxed) && !buffer.is_empty() && !finished {
        let (token, _) = parse_ollama_stream_line(&buffer)?;
        if !token.is_empty() {
            content.push_str(&token);
            on_event
                .send(StreamEvent::Token(token))
                .map_err(|e| format!("Could not deliver Ollama stream: {e}"))?;
        }
    }

    if cancelled.load(Ordering::Relaxed) {
        let _ = on_event.send(StreamEvent::Stopped);
    } else {
        let _ = on_event.send(StreamEvent::Done);
    }

    Ok(ChatReply {
        content: content.trim().to_string(),
    })
}

#[tauri::command]
async fn ollama_chat_stream(
    state: State<'_, GenerationState>,
    model: String,
    policy: String,
    messages: Vec<ChatMessage>,
    max_tokens: Option<u32>,
    generation_id: String,
    on_event: Channel<StreamEvent>,
) -> Result<ChatReply, String> {
    let cancelled = Arc::new(AtomicBool::new(false));
    state
        .0
        .lock()
        .map_err(|_| "Generation state is unavailable.".to_string())?
        .insert(generation_id.clone(), cancelled.clone());

    let result =
        ollama_chat_stream_inner(model, policy, messages, max_tokens, on_event, cancelled).await;

    if let Ok(mut generations) = state.0.lock() {
        generations.remove(&generation_id);
    }

    result
}

#[tauri::command]
fn cancel_generation(state: State<'_, GenerationState>, generation_id: String) -> bool {
    let Ok(generations) = state.0.lock() else {
        return false;
    };

    if let Some(cancelled) = generations.get(&generation_id) {
        cancelled.store(true, Ordering::Relaxed);
        true
    } else {
        false
    }
}

#[tauri::command]
async fn searxng_smart_search(
    query: String,
    searxng_url: String,
    max_sources: Option<usize>,
) -> Result<SearchBundle, String> {
    let max_sources = max_sources.unwrap_or(6).clamp(4, 8);

    if query.trim().is_empty() {
        return Err("Search query is empty.".to_string());
    }

    let intent = detect_intent(&query);
    let search_queries = build_search_queries(&query, intent);

    // Both searches run in parallel. Total search time is bounded by the slowest
    // local SearXNG request, not query1 + query2.
    let client = reqwest::Client::builder()
        .user_agent("NTH/0.4.3")
        .timeout(std::time::Duration::from_secs(6))
        .build()
        .map_err(|e| e.to_string())?;

    let tasks = search_queries
        .iter()
        .cloned()
        .map(|q| searx_request(client.clone(), searxng_url.clone(), q, intent));

    let responses = join_all(tasks).await;

    let mut ranked: Vec<(i32, SearchSource)> = Vec::new();
    let mut seen_urls = HashSet::new();
    let mut warnings: Vec<String> = Vec::new();
    let mut successful_searches = 0usize;

    for (query_index, response) in responses.into_iter().enumerate() {
        let data = match response {
            Ok(v) => {
                successful_searches += 1;
                v
            }
            Err(e) => {
                warnings.push(e);
                continue;
            }
        };

        if let Some(arr) = data["unresponsive_engines"].as_array() {
            for item in arr.iter().take(6) {
                let text = if let Some(s) = item.as_str() {
                    s.to_string()
                } else {
                    item.to_string()
                };
                if !text.is_empty() {
                    warnings.push(text);
                }
            }
        }

        let Some(results) = data["results"].as_array() else {
            continue;
        };

        for (rank, r) in results.iter().take(20).enumerate() {
            let title = r["title"].as_str().unwrap_or("").trim().to_string();
            let url = r["url"].as_str().unwrap_or("").trim().to_string();
            let snippet = r["content"].as_str().unwrap_or("").trim().to_string();
            let published_date = r["publishedDate"]
                .as_str()
                .or_else(|| r["pubdate"].as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            let engine = r["engine"].as_str().unwrap_or("").trim().to_string();

            if title.is_empty() || url.is_empty() || !url.starts_with("http") {
                continue;
            }
            if !seen_urls.insert(url.clone()) {
                continue;
            }

            let (score, quality, official) = score_result(
                &query,
                intent,
                &title,
                &snippet,
                &url,
                rank,
                query_index,
                &published_date,
            );

            ranked.push((
                score,
                SearchSource {
                    title,
                    domain: domain_from_url(&url),
                    url,
                    snippet,
                    published_date,
                    engine,
                    official,
                    quality,
                    score,
                    content: String::new(),
                    fetched: false,
                },
            ));
        }
    }

    if successful_searches == 0 {
        return Err(format!(
            "All SearXNG searches failed. {}",
            warnings.first().cloned().unwrap_or_default()
        ));
    }

    ranked.sort_by(|a, b| b.0.cmp(&a.0));

    // Max 2 results per host. This prevents Reddit/one retailer/one news site
    // from swallowing the entire evidence set.
    let mut domain_counts: HashMap<String, usize> = HashMap::new();
    let mut sources: Vec<SearchSource> = Vec::new();

    for (_, source) in ranked {
        let count = domain_counts.entry(source.domain.clone()).or_insert(0);
        if *count >= 2 {
            continue;
        }

        *count += 1;
        sources.push(source);

        if sources.len() >= max_sources {
            break;
        }
    }

    if sources.is_empty() {
        return Err("SearXNG returned no usable results.".to_string());
    }

    let evidence = sources
        .iter()
        .enumerate()
        .map(|(i, s)| {
            let date = if s.published_date.is_empty() {
                "unknown".to_string()
            } else {
                s.published_date.clone()
            };

            format!(
                "[SOURCE {}]\nQUALITY: {}{}\nTITLE: {}\nURL: {}\nDOMAIN: {}\nPUBLISHED: {}\nENGINE: {}\nSNIPPET: {}",
                i + 1,
                s.quality.to_uppercase(),
                if s.official { " / FIRST-PARTY" } else { "" },
                s.title,
                s.url,
                s.domain,
                date,
                s.engine,
                truncate_chars(&s.snippet, 1400)
            )
        })
        .collect::<Vec<_>>()
        .join("\n\n");

    Ok(SearchBundle {
        query,
        intent: intent.label().to_string(),
        search_queries,
        sources,
        evidence,
        engine_warnings: warnings,
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .manage(GenerationState::default())
        .invoke_handler(tauri::generate_handler![
            ollama_ping,
            ollama_chat,
            ollama_chat_stream,
            cancel_generation,
            searxng_smart_search,
            check_update,
            install_update
        ])
        .run(tauri::generate_context!())
        .expect("error while running NTH");
}
