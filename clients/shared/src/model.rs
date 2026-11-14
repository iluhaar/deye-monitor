use serde::Deserialize;

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum GridStatus {
    Online,
    Offline,
    #[default]
    #[serde(other)]
    Unknown,
}

impl GridStatus {
    pub fn label(self) -> &'static str {
        match self {
            Self::Online => "Online",
            Self::Offline => "Offline",
            Self::Unknown => "Unknown",
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GridConfidence {
    Confirmed,
    Unverified,
    #[default]
    #[serde(other)]
    Unknown,
}

impl GridConfidence {
    pub fn label(self) -> &'static str {
        match self {
            Self::Confirmed => "Confirmed",
            Self::Unverified => "Unverified",
            Self::Unknown => "Unknown",
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FreshnessStatus {
    Fresh,
    Stale,
    Unavailable,
    #[default]
    #[serde(other)]
    Unknown,
}

impl FreshnessStatus {
    pub fn label(self) -> &'static str {
        match self {
            Self::Fresh => "Fresh",
            Self::Stale => "Stale",
            Self::Unavailable => "Unavailable",
            Self::Unknown => "Unknown",
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BatteryMode {
    Charging,
    Discharging,
    Idle,
    #[default]
    #[serde(other)]
    Unknown,
}

impl BatteryMode {
    pub fn label(self) -> &'static str {
        match self {
            Self::Charging => "Charging",
            Self::Discharging => "Discharging",
            Self::Idle => "Idle",
            Self::Unknown => "Unknown",
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HealthStatus {
    Ok,
    Degraded,
    #[default]
    #[serde(other)]
    Unknown,
}

impl HealthStatus {
    pub fn label(self) -> &'static str {
        match self {
            Self::Ok => "OK",
            Self::Degraded => "Degraded",
            Self::Unknown => "Unknown",
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FreshnessInfo {
    pub status: FreshnessStatus,
    pub age_seconds: Option<f64>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct GridReading {
    pub status: GridStatus,
    pub evidence: Vec<String>,
    pub confidence: GridConfidence,
    pub voltage_v: Option<f64>,
    pub frequency_hz: Option<f64>,
    pub power_w: Option<f64>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct BatteryReading {
    pub soc_percent: Option<f64>,
    pub power_w: Option<f64>,
    pub mode: BatteryMode,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct HomeReading {
    pub power_w: Option<f64>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TelemetrySnapshot {
    pub source: Option<String>,
    pub grid: GridReading,
    pub battery: BatteryReading,
    pub home: HomeReading,
    pub measured_at: Option<String>,
    pub fetched_at: Option<String>,
    pub freshness: FreshnessInfo,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct StatusSnapshot {
    pub source: Option<String>,
    pub grid: GridReading,
    pub measured_at: Option<String>,
    pub fetched_at: Option<String>,
    pub freshness: FreshnessInfo,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct BatterySnapshot {
    pub battery: BatteryReading,
    pub measured_at: Option<String>,
    pub fetched_at: Option<String>,
    pub freshness: FreshnessInfo,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct HealthSnapshot {
    pub status: HealthStatus,
    pub snapshot_available: Option<bool>,
    pub ingestion_lag_seconds: Option<f64>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct GridEvent {
    pub id: String,
    pub status: GridStatus,
    pub observed_at: String,
    pub previous_status: Option<GridStatus>,
    pub previous_observed_at: Option<String>,
    pub evidence: Vec<String>,
    pub source: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct EventsPage {
    pub events: Vec<GridEvent>,
    pub next_cursor: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct ApiError {
    pub code: String,
    pub message: String,
}

#[derive(Clone, Debug, Deserialize)]
pub struct ApiEnvelope<T> {
    #[serde(default)]
    pub ok: bool,
    #[serde(default)]
    pub data: Option<T>,
    #[serde(default)]
    pub error: Option<ApiError>,
}

#[derive(Clone, Debug, Default)]
pub struct DashboardData {
    pub telemetry: Option<TelemetrySnapshot>,
    pub status: Option<StatusSnapshot>,
    pub battery: Option<BatterySnapshot>,
    pub health: Option<HealthSnapshot>,
    pub events: Vec<GridEvent>,
}

impl DashboardData {
    pub fn record_event(&mut self, event: GridEvent) {
        if self.events.iter().any(|existing| existing.id == event.id) {
            return;
        }
        self.events.push(event);
        self.events.sort_by(|left, right| {
            (&right.observed_at, &right.id).cmp(&(&left.observed_at, &left.id))
        });
        self.events.truncate(6);
    }

    pub fn demo() -> Self {
        let telemetry = TelemetrySnapshot {
            battery: BatteryReading {
                soc_percent: Some(68.0),
                ..BatteryReading::default()
            },
            freshness: FreshnessInfo {
                status: FreshnessStatus::Unavailable,
                age_seconds: None,
            },
            ..TelemetrySnapshot::default()
        };
        Self {
            telemetry: Some(telemetry),
            ..Self::default()
        }
    }

    pub fn grid(&self) -> GridReading {
        self.telemetry
            .as_ref()
            .map(|snapshot| snapshot.grid.clone())
            .or_else(|| self.status.as_ref().map(|snapshot| snapshot.grid.clone()))
            .unwrap_or_default()
    }

    pub fn battery_reading(&self) -> BatteryReading {
        self.battery
            .as_ref()
            .map(|snapshot| snapshot.battery.clone())
            .or_else(|| {
                self.telemetry
                    .as_ref()
                    .map(|snapshot| snapshot.battery.clone())
            })
            .unwrap_or_default()
    }

    pub fn freshness(&self) -> FreshnessInfo {
        self.telemetry
            .as_ref()
            .map(|snapshot| snapshot.freshness.clone())
            .or_else(|| {
                self.status
                    .as_ref()
                    .map(|snapshot| snapshot.freshness.clone())
            })
            .or_else(|| {
                self.battery
                    .as_ref()
                    .map(|snapshot| snapshot.freshness.clone())
            })
            .unwrap_or_default()
    }

    pub fn home_power_w(&self) -> Option<f64> {
        self.telemetry
            .as_ref()
            .and_then(|snapshot| snapshot.home.power_w)
    }

    pub fn measured_at(&self) -> Option<&str> {
        self.telemetry
            .as_ref()
            .and_then(|snapshot| snapshot.measured_at.as_deref())
            .or_else(|| {
                self.status
                    .as_ref()
                    .and_then(|snapshot| snapshot.measured_at.as_deref())
            })
            .or_else(|| {
                self.battery
                    .as_ref()
                    .and_then(|snapshot| snapshot.measured_at.as_deref())
            })
    }

    pub fn fetched_at(&self) -> Option<&str> {
        self.telemetry
            .as_ref()
            .and_then(|snapshot| snapshot.fetched_at.as_deref())
            .or_else(|| {
                self.status
                    .as_ref()
                    .and_then(|snapshot| snapshot.fetched_at.as_deref())
            })
            .or_else(|| {
                self.battery
                    .as_ref()
                    .and_then(|snapshot| snapshot.fetched_at.as_deref())
            })
    }
}
