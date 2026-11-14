use rune::tok::{self, type_};
#[cfg(target_arch = "wasm32")]
use rune::{App, AppHandle, TextEdit, Tx, text_input};
use rune::{AppSpec, Cx, El, ScrollSpec, col, el, row, text};
use rune_kit::{Badge, BadgeVariant, Divider, Kit};

use crate::model::{DashboardData, FreshnessInfo, FreshnessStatus, GridEvent};

const APP_TITLE: &str = "Deye Monitor";

pub(crate) struct MonitorState {
    data: DashboardData,
    demo: bool,
    #[cfg(target_arch = "wasm32")]
    busy: bool,
    notice: String,
    #[cfg(target_arch = "wasm32")]
    api_base: TextEdit,
    #[cfg(target_arch = "wasm32")]
    token: TextEdit,
    #[cfg(target_arch = "wasm32")]
    handle: Option<AppHandle<MonitorState>>,
}

impl MonitorState {
    #[cfg(target_arch = "wasm32")]
    fn new(handle: Option<AppHandle<Self>>) -> Self {
        let mut token = TextEdit::new("");
        token.set_secure(true);
        Self {
            data: DashboardData::demo(),
            demo: true,
            busy: false,
            notice: "Illustrative demo fixture — connect to view stored readings.".to_owned(),
            api_base: TextEdit::new(""),
            token,
            handle,
        }
    }

    #[cfg(not(target_arch = "wasm32"))]
    fn new() -> Self {
        Self {
            data: DashboardData::demo(),
            demo: true,
            notice: "Native scaffold is demo-only; use the web client for API reads.".to_owned(),
        }
    }
}

fn initial_state() -> MonitorState {
    #[cfg(target_arch = "wasm32")]
    {
        MonitorState::new(None)
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        MonitorState::new()
    }
}

#[cfg(target_arch = "wasm32")]
pub(crate) fn run_web() {
    let app = App::new(AppSpec::new(
        APP_TITLE,
        (1180.0, 900.0),
        initial_state,
        view,
    ))
    .canvas_id("deye-monitor")
    .full_viewport();
    let handle = app.handle();
    app.init(move || MonitorState::new(Some(handle))).run();
}

#[cfg(not(target_arch = "wasm32"))]
pub(crate) fn run_demo() {
    rune::run(AppSpec::new(
        APP_TITLE,
        (1180.0, 900.0),
        initial_state,
        view,
    ));
}

#[cfg(target_arch = "wasm32")]
fn begin_read(state: &mut MonitorState, _: &mut Tx) {
    if state.busy {
        return;
    }
    let base = state.api_base.text.trim().to_owned();
    let token = state.token.text.trim().to_owned();
    let Some(handle) = state.handle.clone() else {
        state.notice = "The browser client is not ready yet.".to_owned();
        return;
    };
    if base.is_empty() || token.is_empty() {
        state.notice = "Enter an API origin and read bearer token.".to_owned();
        return;
    }
    state.busy = true;
    state.notice = "Reading authenticated API endpoints with GET…".to_owned();
    crate::http::spawn_read(base, token, move |result| {
        handle.update(move |state, _| {
            state.busy = false;
            match result {
                Ok(data) => {
                    state.data = data;
                    state.demo = false;
                    state.notice = "Read complete. Displaying stored API data.".to_owned();
                }
                Err(error) => {
                    let visible_data = if state.demo {
                        "Demo fixture remains visible."
                    } else {
                        "Previous API readings remain visible."
                    };
                    state.notice = format!("Read failed: {error} {visible_data}");
                }
            }
        });
    });
}

fn view(state: &MonitorState, cx: &mut Cx<MonitorState>) -> El {
    let dark = cx.system_dark();
    let theme = tok::theme(dark);
    let kit = Kit::neutral(dark);
    let [top, right, bottom, left] = cx.safe_area();
    let data = &state.data;
    let grid = data.grid();
    let battery = data.battery_reading();
    let freshness = data.freshness();
    let confidence_label = grid.confidence.label();
    let grid_label = grid.status.label();
    let soc_label = percent_label(battery.soc_percent);
    let freshness_label = freshness.status.label();
    let battery_mode = battery.mode.label();

    let brand = row()
        .gap(12.0)
        .center_y()
        .child(
            el().key("brand-mark")
                .size(40.0, 40.0)
                .center()
                .radius(12.0)
                .fill(tok::accent(0, dark))
                .child(text("D").font(type_::TITLE).color(rune::Color::WHITE)),
        )
        .child(
            col()
                .gap(2.0)
                .child(text(APP_TITLE).font(type_::TITLE).color(theme.text))
                .child(
                    text("READ-ONLY ENERGY MONITOR")
                        .font(type_::SECTION)
                        .color(theme.text_secondary),
                ),
        );
    let source_badge = if state.demo {
        Badge::new("DEMO FIXTURE")
            .variant(BadgeVariant::Subtle)
            .standard()
            .build(&kit)
    } else {
        Badge::new("API DATA")
            .variant(BadgeVariant::Accent)
            .standard()
            .build(&kit)
    };
    let header = row()
        .w_full()
        .justify_between()
        .center_y()
        .flex_wrap()
        .gap(12.0)
        .child(brand)
        .child(source_badge);

    let grid_card = panel(
        col()
            .w_full()
            .gap(12.0)
            .child(
                row()
                    .w_full()
                    .justify_between()
                    .center_y()
                    .child(label("GRID STATUS", theme.text_secondary))
                    .child(Badge::new(grid_label).standard().build(&kit)),
            )
            .child(
                text(grid_label)
                    .font(rune::TextStyle::new(30.0, 600.0))
                    .color(theme.text),
            )
            .child(
                text(format!("Classification confidence · {confidence_label}"))
                    .font(type_::BODY)
                    .color(theme.text_secondary),
            )
            .child(
                row()
                    .w_full()
                    .gap(16.0)
                    .child(small_metric("Voltage", volts_label(grid.voltage_v), &theme))
                    .child(small_metric(
                        "Frequency",
                        hertz_label(grid.frequency_hz),
                        &theme,
                    )),
            ),
        &theme,
    )
    .min_w(260.0);

    let battery_card = panel(
        col()
            .w_full()
            .gap(12.0)
            .child(
                row()
                    .w_full()
                    .justify_between()
                    .center_y()
                    .child(label("BATTERY", theme.text_secondary))
                    .child(Badge::new(battery_mode).standard().build(&kit)),
            )
            .child(
                text(soc_label)
                    .font(rune::TextStyle::new(30.0, 600.0))
                    .color(theme.text),
            )
            .child(
                text("State of charge")
                    .font(type_::BODY)
                    .color(theme.text_secondary),
            )
            .child(small_metric(
                "Battery power · raw W",
                watts_label(battery.power_w),
                &theme,
            )),
        &theme,
    )
    .min_w(260.0);

    let overview = row()
        .w_full()
        .gap(14.0)
        .flex_wrap()
        .items_stretch()
        .child(grid_card)
        .child(battery_card);

    let telemetry = panel(
        col()
            .w_full()
            .gap(14.0)
            .child(
                row()
                    .w_full()
                    .justify_between()
                    .center_y()
                    .child(section_title("TELEMETRY", &theme))
                    .child(Badge::new(freshness_label).standard().build(&kit)),
            )
            .child(Divider::horizontal().build(&kit))
            .child(
                row()
                    .w_full()
                    .gap(18.0)
                    .child(small_metric(
                        "Grid power · raw W",
                        watts_label(grid.power_w),
                        &theme,
                    ))
                    .child(small_metric(
                        "Home power · W",
                        watts_label(data.home_power_w()),
                        &theme,
                    ))
                    .child(small_metric(
                        "Snapshot age",
                        age_description(&freshness),
                        &theme,
                    )),
            )
            .child(
                row()
                    .w_full()
                    .gap(18.0)
                    .child(small_metric(
                        "Measured at",
                        timestamp_label(data.measured_at()),
                        &theme,
                    ))
                    .child(small_metric(
                        "Fetched at",
                        timestamp_label(data.fetched_at()),
                        &theme,
                    ))
                    .child(small_metric(
                        "Battery power sign",
                        "Unverified".to_owned(),
                        &theme,
                    )),
            )
            .child(
                text("Power direction is not inferred; these values retain their raw sign.")
                    .font(type_::LABEL)
                    .color(theme.text_secondary),
            ),
        &theme,
    );

    let health_text = if state.demo {
        "Not connected".to_owned()
    } else {
        data.health
            .as_ref()
            .map(|health| health.status.label().to_owned())
            .unwrap_or_else(|| "Unknown".to_owned())
    };
    let health_lag = data
        .health
        .as_ref()
        .and_then(|health| health.ingestion_lag_seconds);
    let health = panel(
        col()
            .w_full()
            .gap(12.0)
            .child(section_title("SERVICE HEALTH", &theme))
            .child(
                text(health_text)
                    .font(rune::TextStyle::new(24.0, 600.0))
                    .color(theme.text),
            )
            .child(small_metric(
                "Ingestion lag",
                seconds_label(health_lag),
                &theme,
            ))
            .child(
                text(snapshot_health_note(state, data.health.as_ref()))
                    .font(type_::LABEL)
                    .color(theme.text_secondary),
            ),
        &theme,
    )
    .min_w(250.0);

    let events = events_panel(&data.events, state.demo, &theme, &kit).min_w(280.0);
    let details = row()
        .w_full()
        .gap(14.0)
        .flex_wrap()
        .items_stretch()
        .child(health)
        .child(events);

    #[cfg(target_arch = "wasm32")]
    let connection = connection_panel(state, &theme, &kit);
    #[cfg(not(target_arch = "wasm32"))]
    let connection = desktop_panel(state, &theme, &kit);

    let content = col()
        .key("dashboard-content")
        .w_full()
        .max_w(1120.0)
        .gap(16.0)
        .pt(18.0 + top)
        .pr(22.0 + right)
        .pb(28.0 + bottom)
        .pl(22.0 + left)
        .child(header)
        .child(
            col()
                .w_full()
                .gap(6.0)
                .child(
                    text("Power at a glance")
                        .font(rune::TextStyle::new(27.0, 600.0))
                        .color(theme.text),
                )
                .child(
                    text("Stored inverter readings, with uncertainty kept visible.")
                        .font(type_::BODY)
                        .color(theme.text_secondary),
                ),
        )
        .child(connection)
        .child(overview)
        .child(telemetry)
        .child(details);

    col().w_full().h_full().fill(theme.bg).child(
        col()
            .key("dashboard-scroll")
            .w_full()
            .grow(1.0)
            .shrink()
            .min_h(0.0)
            .scroll(ScrollSpec {
                stick_bottom: false,
            })
            .center_y()
            .child(content),
    )
}

fn panel(content: El, theme: &rune::tok::Theme) -> El {
    col()
        .w_full()
        .grow(1.0)
        .min_w(0.0)
        .padding(18.0)
        .gap(8.0)
        .radius(16.0)
        .fill(theme.card)
        .border(1.0, theme.card_border)
        .child(content)
}

fn label(value: &str, color: rune::Color) -> El {
    text(value).font(type_::SECTION).color(color)
}

fn section_title(value: &str, theme: &rune::tok::Theme) -> El {
    text(value).font(type_::SECTION).color(theme.text_secondary)
}

fn small_metric(title: &str, value: String, theme: &rune::tok::Theme) -> El {
    col()
        .grow(1.0)
        .min_w(0.0)
        .gap(4.0)
        .child(
            text(title.to_owned())
                .font(type_::LABEL)
                .color(theme.text_secondary),
        )
        .child(text(value).font(type_::BODY).color(theme.text))
}

fn percent_label(value: Option<f64>) -> String {
    value.map_or_else(|| "—".to_owned(), |value| format!("{value:.0}%"))
}

fn watts_label(value: Option<f64>) -> String {
    value.map_or_else(|| "—".to_owned(), |value| format!("{value:.0} W"))
}

fn volts_label(value: Option<f64>) -> String {
    value.map_or_else(|| "—".to_owned(), |value| format!("{value:.1} V"))
}

fn hertz_label(value: Option<f64>) -> String {
    value.map_or_else(|| "—".to_owned(), |value| format!("{value:.2} Hz"))
}

fn seconds_label(value: Option<f64>) -> String {
    value.map_or_else(|| "—".to_owned(), |value| format!("{value:.0} s"))
}

fn timestamp_label(value: Option<&str>) -> String {
    value.map_or_else(|| "—".to_owned(), ToOwned::to_owned)
}

fn age_description(freshness: &FreshnessInfo) -> String {
    match freshness.status {
        FreshnessStatus::Fresh | FreshnessStatus::Stale => seconds_label(freshness.age_seconds),
        FreshnessStatus::Unavailable => "No snapshot".to_owned(),
        FreshnessStatus::Unknown => "Unknown".to_owned(),
    }
}

fn snapshot_health_note(
    state: &MonitorState,
    health: Option<&crate::model::HealthSnapshot>,
) -> String {
    if state.demo {
        return "Demo fixture; no server health check has run.".to_owned();
    }
    match health.and_then(|snapshot| snapshot.snapshot_available) {
        Some(true) => "A stored snapshot is available.".to_owned(),
        Some(false) => "The API reports no stored snapshot.".to_owned(),
        None => "Snapshot availability was not reported.".to_owned(),
    }
}

#[cfg(target_arch = "wasm32")]
fn connection_panel(state: &MonitorState, theme: &rune::tok::Theme, kit: &Kit) -> El {
    let base_input = text_input(&state.api_base, type_::BODY)
        .key("api-base")
        .single_line()
        .placeholder("https://monitor.example.com", theme.text_secondary)
        .color(theme.text)
        .padding(11.0)
        .h(42.0)
        .radius(10.0)
        .fill(theme.bg)
        .border(1.0, theme.card_border)
        .on_edit(|state: &mut MonitorState| &mut state.api_base);
    let token_input = text_input(&state.token, type_::BODY)
        .key("read-token")
        .single_line()
        .placeholder("Read bearer token", theme.text_secondary)
        .color(theme.text)
        .grow(1.0)
        .min_w(190.0)
        .padding(11.0)
        .h(42.0)
        .radius(10.0)
        .fill(theme.bg)
        .border(1.0, theme.card_border)
        .secure()
        .on_edit(|state: &mut MonitorState| &mut state.token);
    let read_button = el()
        .key("read-api")
        .h(42.0)
        .px(16.0)
        .center()
        .radius(10.0)
        .fill(tok::accent(0, true))
        .child(
            text(if state.busy {
                "READING…"
            } else {
                "READ LATEST"
            })
            .font(type_::LABEL)
            .color(rune::Color::WHITE),
        )
        .on_press_tx(begin_read);

    panel(
        col()
            .w_full()
            .gap(10.0)
            .child(
                row()
                    .w_full()
                    .justify_between()
                    .center_y()
                    .child(section_title("READ-ONLY API CONNECTION", theme))
                    .child(Badge::new("GET ONLY").standard().build(kit)),
            )
            .child(label("API origin", theme.text_secondary))
            .child(base_input)
            .child(label("Read bearer token", theme.text_secondary))
            .child(
                row()
                    .w_full()
                    .gap(10.0)
                    .flex_wrap()
                    .child(token_input)
                    .child(read_button),
            )
            .child(text("Token stays in memory only. Requests use the stored-data API; refresh ingestion is not called.").font(type_::LABEL).color(theme.text_secondary))
            .child(text(state.notice.clone()).font(type_::LABEL).color(theme.text_secondary)),
        theme,
    )
}

#[cfg(not(target_arch = "wasm32"))]
fn desktop_panel(state: &MonitorState, theme: &rune::tok::Theme, kit: &Kit) -> El {
    panel(
        col()
            .w_full()
            .gap(8.0)
            .child(
                row()
                    .justify_between()
                    .center_y()
                    .child(section_title("NATIVE PREVIEW", theme))
                    .child(Badge::new("DEMO ONLY").standard().build(kit)),
            )
            .child(
                text(state.notice.clone())
                    .font(type_::BODY)
                    .color(theme.text_secondary),
            ),
        theme,
    )
}

fn events_panel(events: &[GridEvent], demo: bool, theme: &rune::tok::Theme, kit: &Kit) -> El {
    let mut rows = col().w_full().gap(9.0);
    if events.is_empty() {
        let message = if demo {
            "No real events loaded. Connect to the API to view stored grid transitions."
        } else {
            "No grid transition events in this page."
        };
        rows = rows.child(
            text(message)
                .font(type_::BODY)
                .color(theme.text_secondary)
                .wrap()
                .w_full(),
        );
    } else {
        for event in events.iter().take(6) {
            rows = rows.child(event_row(event, theme, kit));
        }
    }
    panel(
        col()
            .w_full()
            .gap(12.0)
            .child(
                row()
                    .w_full()
                    .justify_between()
                    .center_y()
                    .child(section_title("RECENT GRID EVENTS", theme))
                    .child(
                        Badge::new(format!("{} SHOWN", events.len().min(6)))
                            .standard()
                            .build(kit),
                    ),
            )
            .child(rows),
        theme,
    )
}

fn event_row(event: &GridEvent, theme: &rune::tok::Theme, kit: &Kit) -> El {
    let previous = event.previous_status.map_or_else(
        || "Previous state unknown".to_owned(),
        |status| format!("{} → {}", status.label(), event.status.label()),
    );
    let evidence = if event.evidence.is_empty() {
        "Evidence not supplied".to_owned()
    } else {
        event.evidence.join(" · ")
    };
    row()
        .w_full()
        .gap(10.0)
        .items_stretch()
        .child(Badge::new(event.status.label()).standard().build(kit))
        .child(
            col()
                .grow(1.0)
                .min_w(0.0)
                .gap(3.0)
                .child(text(previous).font(type_::BODY).color(theme.text))
                .child(
                    text(evidence)
                        .font(type_::LABEL)
                        .color(theme.text_secondary)
                        .wrap()
                        .w_full(),
                )
                .child(
                    text(event.observed_at.clone())
                        .font(type_::LABEL.mono())
                        .color(theme.text_secondary),
                ),
        )
}
