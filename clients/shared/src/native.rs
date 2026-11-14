use std::{
    collections::VecDeque,
    io::{Read, Write},
    path::PathBuf,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use chrono::{DateTime, SecondsFormat};
use directories::ProjectDirs;
use futures_util::{SinkExt, StreamExt};
use reqwest::{Client, redirect::Policy};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use sha2::{Digest, Sha256};
use tokio::{sync::watch, time};
use tokio_tungstenite::{
    connect_async_with_config,
    tungstenite::{
        Error as SocketError, Message,
        client::IntoClientRequest,
        http::{HeaderMap, HeaderValue},
        protocol::WebSocketConfig,
    },
};
use url::Url;

use crate::model::{
    ApiEnvelope, DashboardData, EventsPage, GridEvent, GridStatus, HealthSnapshot,
    TelemetrySnapshot,
};

pub(crate) enum Update {
    Snapshot(Box<DashboardData>),
    Event(GridEvent),
    Status(String),
    Stopped(String),
}

/// Dropping the control cancels connect, replay, retry sleeps, and idle reads.
pub(crate) struct Subscription {
    _cancel: watch::Sender<()>,
}

#[derive(Debug)]
enum Failure {
    Stop(&'static str),
    Retry(&'static str, Duration),
    Resync,
    Renew,
}

fn retry(message: &'static str) -> Failure {
    Failure::Retry(message, Duration::from_secs(10))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn origin(base: &str) -> Result<String, String> {
    let url = Url::parse(base).map_err(|_| "Enter a valid API origin.".to_owned())?;
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
    {
        return Err("Use an API origin without credentials, path, query, or fragment.".to_owned());
    }
    let loopback = url.host_str().is_some_and(|host| {
        host == "localhost"
            || host
                .trim_matches(['[', ']'])
                .parse::<std::net::IpAddr>()
                .is_ok_and(|address| address.is_loopback())
    });
    if url.scheme() != "https" && !(url.scheme() == "http" && loopback) {
        return Err("Use HTTPS, or HTTP on localhost for local development.".to_owned());
    }
    Ok(url.origin().ascii_serialization())
}

fn local_origin(base: &str) -> bool {
    // origin() only allows plaintext HTTP for loopback addresses.
    base.starts_with("http://")
}

pub(crate) fn start(
    base: String,
    token: String,
    emit: impl Fn(Update) + Send + 'static,
) -> Result<Subscription, String> {
    let base = origin(&base)?;
    if token.is_empty() || token.len() > 4096 {
        return Err("Enter a valid read bearer token.".to_owned());
    }
    HeaderValue::from_str(&format!("Bearer {token}"))
        .map_err(|_| "Enter a valid read bearer token.".to_owned())?;
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|_| "Could not start the connection runtime.".to_owned())?;
    let (cancel, mut stopped) = watch::channel(());
    std::thread::Builder::new()
        .name("deye-subscription".to_owned())
        .spawn(move || {
            runtime.block_on(async {
                tokio::select! {
                    _ = stopped.changed() => {}
                    _ = run(base, token, &emit) => {}
                }
            });
            runtime.shutdown_timeout(Duration::from_secs(1));
        })
        .map_err(|_| "Could not start the subscription worker.".to_owned())?;
    Ok(Subscription { _cancel: cancel })
}

#[derive(Default, Deserialize, Serialize)]
struct SavedCursor {
    origin: String,
    cursor: Option<String>,
    recent_ids: VecDeque<String>,
}

struct CursorStore {
    path: PathBuf,
    saved: SavedCursor,
}

fn valid_cursor(cursor: &str) -> bool {
    !cursor.is_empty()
        && cursor.len() <= 512
        && cursor
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

impl CursorStore {
    fn open(base: &str) -> Result<Self, Failure> {
        let directories = ProjectDirs::from("dev", "illiadot", "DeyeMonitor").ok_or(
            Failure::Stop("The application data directory is unavailable."),
        )?;
        let directory = directories.data_local_dir().join("subscriptions");
        let mut builder = std::fs::DirBuilder::new();
        builder.recursive(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder
            .create(&directory)
            .map_err(|_| Failure::Stop("Could not create the subscription data directory."))?;
        let name = format!("{:x}.json", Sha256::digest(base.as_bytes()));
        let path = directory.join(name);
        let read = || -> std::io::Result<Vec<u8>> {
            let mut bytes = Vec::new();
            std::fs::File::open(&path)?
                .take(64 * 1024 + 1)
                .read_to_end(&mut bytes)?;
            Ok(bytes)
        };
        let saved = match read() {
            Ok(bytes) if bytes.len() <= 64 * 1024 => {
                let saved: SavedCursor = serde_json::from_slice(&bytes)
                    .map_err(|_| Failure::Stop("The saved subscription cursor is invalid."))?;
                if saved.origin != base
                    || saved
                        .cursor
                        .as_deref()
                        .is_some_and(|cursor| !valid_cursor(cursor))
                    || saved.recent_ids.len() > 256
                    || saved
                        .recent_ids
                        .iter()
                        .any(|id| id.is_empty() || id.len() > 128)
                {
                    return Err(Failure::Stop("The saved subscription cursor is invalid."));
                }
                saved
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => SavedCursor {
                origin: base.to_owned(),
                ..SavedCursor::default()
            },
            _ => {
                return Err(Failure::Stop(
                    "Could not read the saved subscription cursor.",
                ));
            }
        };
        Ok(Self { path, saved })
    }

    fn remember(&mut self, id: &str) -> bool {
        if self.saved.recent_ids.iter().any(|seen| seen == id) {
            return false;
        }
        self.saved.recent_ids.push_back(id.to_owned());
        while self.saved.recent_ids.len() > 256 {
            self.saved.recent_ids.pop_front();
        }
        true
    }

    fn save(&self) -> Result<(), Failure> {
        let save = || -> Result<(), Box<dyn std::error::Error>> {
            let directory = self.path.parent().ok_or("missing data directory")?;
            let mut file = tempfile::NamedTempFile::new_in(directory)?;
            serde_json::to_writer(file.as_file_mut(), &self.saved)?;
            file.flush()?;
            file.as_file().sync_all()?;
            file.persist(&self.path)?;
            #[cfg(unix)]
            std::fs::File::open(directory)?.sync_all()?;
            Ok(())
        };
        save().map_err(|_| {
            Failure::Stop("Could not save the subscription cursor. Reconnect to retry.")
        })
    }

    fn reset(&mut self) -> Result<(), Failure> {
        self.saved.cursor = None;
        self.save()
    }
}

fn status_failure(status: u16, headers: &HeaderMap) -> Failure {
    match status {
        401 | 403 => {
            Failure::Stop("Authorization was rejected. Check the read token and reconnect.")
        }
        409 => Failure::Resync,
        429 => {
            let seconds = headers
                .get("Retry-After")
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.parse::<u64>().ok())
                .unwrap_or(60)
                .clamp(10, 3600);
            Failure::Retry("The API is rate limited.", Duration::from_secs(seconds))
        }
        404 | 426 => Failure::Stop("The API does not provide the expected subscription endpoint."),
        301 | 302 | 303 | 307 | 308 => {
            Failure::Stop("Use the API's direct origin; authenticated redirects are not followed.")
        }
        _ => retry("The API is temporarily unavailable."),
    }
}

async fn get<T: DeserializeOwned + Default>(
    client: &Client,
    base: &str,
    token: &str,
    path: &str,
) -> Result<Option<T>, Failure> {
    let mut request = client
        .get(format!("{base}/api/v1/{path}"))
        .bearer_auth(token)
        .header("Accept", "application/json");
    if local_origin(base) {
        request = request.header("CF-Connecting-IP", "127.0.0.1");
    }
    let mut response = request
        .send()
        .await
        .map_err(|_| retry("The API connection failed."))?;
    if !response.status().is_success() {
        return Err(status_failure(
            response.status().as_u16(),
            response.headers(),
        ));
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| retry("The API response could not be read."))?
    {
        if body.len() + chunk.len() > 1024 * 1024 {
            return Err(Failure::Stop("The API response exceeded its size limit."));
        }
        body.extend_from_slice(&chunk);
    }
    let envelope: ApiEnvelope<T> = serde_json::from_slice(&body)
        .map_err(|_| Failure::Stop("The API returned an unexpected response."))?;
    if !envelope.ok {
        return Err(retry("The API did not accept the read request."));
    }
    Ok(envelope.data)
}

async fn read_dashboard(
    client: &Client,
    base: &str,
    token: &str,
) -> Result<DashboardData, Failure> {
    // Telemetry includes the grid and battery; avoid redundant status/battery reads.
    let telemetry: Option<TelemetrySnapshot> = get(client, base, token, "telemetry").await?;
    let health: Option<HealthSnapshot> = get(client, base, token, "health").await?;
    let events: Option<EventsPage> = get(client, base, token, "events?limit=6").await?;
    Ok(DashboardData {
        telemetry,
        health,
        events: events.map_or_else(Vec::new, |page| page.events),
        ..DashboardData::default()
    })
}

#[derive(Deserialize)]
#[serde(tag = "type")]
enum ServerMessage {
    #[serde(rename = "ready")]
    Ready {
        version: u8,
        #[serde(rename = "expiresAt")]
        expires_at: u64,
    },
    #[serde(rename = "grid.changed")]
    Changed {
        version: u8,
        cursor: String,
        data: GridEvent,
    },
    #[serde(rename = "checkpoint")]
    Checkpoint {
        cursor: String,
        #[serde(rename = "hasMore")]
        has_more: bool,
    },
    #[serde(rename = "resync.required")]
    Resync,
    #[serde(rename = "reconnect")]
    Reconnect,
    #[serde(rename = "stream.error")]
    StreamError,
    #[serde(rename = "protocol.error")]
    ProtocolError,
}

fn event_time(event: &GridEvent) -> Result<u64, Failure> {
    let invalid = || Failure::Stop("The subscription returned an invalid grid event.");
    let observed = DateTime::parse_from_rfc3339(&event.observed_at).map_err(|_| invalid())?;
    let previous = event
        .previous_observed_at
        .as_deref()
        .map(DateTime::parse_from_rfc3339)
        .transpose()
        .map_err(|_| invalid())?;
    if event.id.is_empty()
        || event.id.len() > 128
        || !matches!(event.status, GridStatus::Online | GridStatus::Offline)
        || event.source.as_deref() != Some("deye-cloud")
        || event.evidence.is_empty()
        || event.evidence.len() > 16
        || event
            .evidence
            .iter()
            .any(|item| item.trim().is_empty() || item.chars().count() > 64)
        || event.previous_status.is_some() != previous.is_some()
        || event.previous_status == Some(GridStatus::Unknown)
        || event.previous_status == Some(event.status)
        || previous.is_some_and(|time| time > observed)
        || observed.to_rfc3339_opts(SecondsFormat::Millis, true) != event.observed_at
    {
        return Err(invalid());
    }
    u64::try_from(observed.timestamp_millis()).map_err(|_| invalid())
}

async fn notify(event: &GridEvent, emit: &impl Fn(Update)) {
    let summary = match event.status {
        GridStatus::Online => "Grid power restored",
        GridStatus::Offline => "Grid power is off",
        GridStatus::Unknown => return,
    };
    let body = format!("Observed at {}", event.observed_at);
    let task = tokio::task::spawn_blocking(move || {
        notify_rust::Notification::new()
            .appname("Deye Monitor")
            .summary(summary)
            .body(&body)
            .show()
            .is_ok()
    });
    if !matches!(
        time::timeout(Duration::from_secs(3), task).await,
        Ok(Ok(true))
    ) {
        emit(Update::Status(
            "Connected. Check OS notification permissions to enable alerts.".to_owned(),
        ));
    }
}

async fn session(
    client: &Client,
    base: &str,
    token: &str,
    store: &mut CursorStore,
    alert_after: u64,
    mut measured_at: Option<String>,
    emit: &impl Fn(Update),
) -> Result<(), Failure> {
    let socket_url = format!(
        "{}/api/v1/events/subscribe",
        base.replacen("https://", "wss://", 1)
            .replacen("http://", "ws://", 1)
    );
    let mut request = socket_url
        .into_client_request()
        .map_err(|_| Failure::Stop("The subscription URL is invalid."))?;
    request.headers_mut().insert(
        "Authorization",
        HeaderValue::from_str(&format!("Bearer {token}"))
            .map_err(|_| Failure::Stop("The read token is invalid."))?,
    );
    if let Some(cursor) = &store.saved.cursor {
        request.headers_mut().insert(
            "Last-Event-ID",
            HeaderValue::from_str(cursor)
                .map_err(|_| Failure::Stop("The saved cursor is invalid."))?,
        );
    }
    if local_origin(base) {
        request
            .headers_mut()
            .insert("CF-Connecting-IP", HeaderValue::from_static("127.0.0.1"));
    }
    let config = WebSocketConfig::default()
        .max_message_size(Some(64 * 1024))
        .max_frame_size(Some(64 * 1024));
    let (mut socket, _) = time::timeout(
        Duration::from_secs(15),
        connect_async_with_config(request, Some(config), true),
    )
    .await
    .map_err(|_| retry("The subscription handshake timed out."))?
    .map_err(|error| match error {
        SocketError::Http(response) => {
            status_failure(response.status().as_u16(), response.headers())
        }
        _ => retry("The subscription connection failed."),
    })?;
    let mut ready = false;
    let mut page_cursor = None;
    let mut page_bytes = 0;
    let mut page_count = 0;
    let mut needs_snapshot = false;
    let mut last_received = time::Instant::now();
    let deadline = time::sleep(Duration::from_secs(15));
    tokio::pin!(deadline);
    let mut ping = time::interval_at(
        time::Instant::now() + Duration::from_secs(30),
        Duration::from_secs(30),
    );
    ping.set_missed_tick_behavior(time::MissedTickBehavior::Skip);

    loop {
        tokio::select! {
            _ = &mut deadline => {
                let _ = time::timeout(Duration::from_secs(2), socket.close(None)).await;
                return if ready { Err(Failure::Renew) } else { Err(retry("The server did not start the subscription.")) };
            }
            _ = ping.tick() => {
                if last_received.elapsed() > Duration::from_secs(90) {
                    return Err(retry("The connection was interrupted."));
                }
                socket.send(Message::Text("ping".into())).await
                    .map_err(|_| retry("The connection was interrupted."))?;
            }
            incoming = socket.next() => {
                let message = incoming.ok_or_else(|| retry("The connection closed."))?
                    .map_err(|_| retry("The connection was interrupted."))?;
                last_received = time::Instant::now();
                let text = match message {
                    Message::Text(text) if text == "pong" => continue,
                    Message::Text(text) => text,
                    Message::Ping(_) | Message::Pong(_) => {
                        socket.flush().await.map_err(|_| retry("The connection was interrupted."))?;
                        continue;
                    }
                    Message::Close(_) => return Err(retry("The connection closed.")),
                    _ => return Err(Failure::Stop("The server sent an unsupported subscription message.")),
                };
                let message: ServerMessage = serde_json::from_str(&text)
                    .map_err(|_| Failure::Stop("The server sent an invalid subscription message."))?;
                match message {
                    ServerMessage::Ready { version: 1, expires_at } if !ready => {
                        let remaining = expires_at.saturating_sub(now_ms());
                        if !(5000..=2 * 60 * 60_000).contains(&remaining) {
                            return Err(Failure::Stop("The subscription expiry is invalid. Check the system clock."));
                        }
                        ready = true;
                        deadline.as_mut().reset(time::Instant::now() + Duration::from_millis(remaining - 5000));
                        emit(Update::Status("Connected — subscribed to grid changes.".to_owned()));
                    }
                    ServerMessage::Changed { version: 1, cursor, data } if ready => {
                        page_bytes += text.len();
                        page_count += 1;
                        if !valid_cursor(&cursor) || page_count > 100 || page_bytes > 32 * 1024 {
                            return Err(Failure::Stop("The subscription exceeded its page limits."));
                        }
                        let observed_at = event_time(&data)?;
                        needs_snapshot |= measured_at.as_ref()
                            .is_none_or(|measured| data.observed_at > *measured);
                        if store.remember(&data.id) {
                            emit(Update::Event(data.clone()));
                            // Never show old replay as a fresh outage alert.
                            if observed_at > alert_after
                                && now_ms().checked_sub(observed_at).is_some_and(|age| age <= 120_000) {
                                notify(&data, emit).await;
                            }
                        }
                        page_cursor = Some(cursor);
                    }
                    ServerMessage::Checkpoint { cursor, has_more } if ready => {
                        if page_cursor.as_deref() != Some(&cursor) {
                            return Err(Failure::Stop("The subscription checkpoint is invalid."));
                        }
                        store.saved.cursor = Some(cursor.clone());
                        store.save()?;
                        socket.send(Message::Text(serde_json::json!({"type": "ack", "cursor": cursor}).to_string().into()))
                            .await.map_err(|_| retry("The checkpoint could not be acknowledged."))?;
                        page_cursor = None;
                        page_bytes = 0;
                        page_count = 0;
                        if !has_more && needs_snapshot {
                            // Snapshot reads are event-driven, never on a periodic timer.
                            let data = read_dashboard(client, base, token).await?;
                            measured_at = data.measured_at().map(ToOwned::to_owned);
                            emit(Update::Snapshot(Box::new(data)));
                            needs_snapshot = false;
                        }
                    }
                    ServerMessage::Resync => return Err(Failure::Resync),
                    ServerMessage::Reconnect => return Err(Failure::Renew),
                    ServerMessage::StreamError => return Err(retry("The server is temporarily unavailable.")),
                    ServerMessage::ProtocolError => return Err(Failure::Stop("The server rejected the subscription protocol.")),
                    _ => return Err(Failure::Stop("The subscription protocol version is unsupported.")),
                }
            }
        }
    }
}

async fn run(base: String, token: String, emit: &impl Fn(Update)) {
    let mut store = match CursorStore::open(&base) {
        Ok(store) => store,
        Err(Failure::Stop(message)) => {
            emit(Update::Stopped(message.to_owned()));
            return;
        }
        _ => return,
    };
    let client = match Client::builder()
        .timeout(Duration::from_secs(15))
        .redirect(Policy::none())
        .build()
    {
        Ok(client) => client,
        Err(_) => {
            emit(Update::Stopped(
                "Could not initialize the HTTPS client.".to_owned(),
            ));
            return;
        }
    };
    let alert_after = now_ms();
    let mut backoff = 10;
    loop {
        emit(Update::Status(
            "Connecting to the read-only API…".to_owned(),
        ));
        let started = time::Instant::now();
        let result = match read_dashboard(&client, &base, &token).await {
            Ok(data) => {
                let measured_at = data.measured_at().map(ToOwned::to_owned);
                emit(Update::Snapshot(Box::new(data)));
                session(
                    &client,
                    &base,
                    &token,
                    &mut store,
                    alert_after,
                    measured_at,
                    emit,
                )
                .await
            }
            Err(error) => Err(error),
        };
        if started.elapsed() >= Duration::from_secs(60) {
            backoff = 10;
        }
        let failure = result
            .err()
            .unwrap_or_else(|| retry("The connection closed."));
        let (message, delay) = match failure {
            Failure::Stop(message) => {
                emit(Update::Stopped(message.to_owned()));
                return;
            }
            Failure::Renew => (
                "Renewing the authenticated subscription.",
                Duration::from_secs(1),
            ),
            Failure::Resync => {
                if store.reset().is_err() {
                    emit(Update::Stopped(
                        "Could not reset the saved cursor.".to_owned(),
                    ));
                    return;
                }
                ("Resynchronizing retained history.", Duration::from_secs(10))
            }
            Failure::Retry(message, minimum) => {
                let delay = Duration::from_secs(backoff).max(minimum);
                backoff = (backoff * 2).min(60);
                (message, delay)
            }
        };
        let jitter = Duration::from_millis(rand::random::<u64>() % 2000);
        emit(Update::Status(format!(
            "{message} Reconnecting in {} seconds…",
            delay.as_secs()
        )));
        time::sleep(delay + jitter).await;
    }
}
