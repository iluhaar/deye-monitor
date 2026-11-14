#[cfg(target_arch = "wasm32")]
mod http;
mod model;
#[cfg(not(target_arch = "wasm32"))]
mod native;
mod view;

pub use model::{
    ApiEnvelope, ApiError, BatteryMode, BatteryReading, BatterySnapshot, DashboardData, EventsPage,
    FreshnessInfo, FreshnessStatus, GridConfidence, GridEvent, GridReading, GridStatus,
    HealthSnapshot, HealthStatus, HomeReading, StatusSnapshot, TelemetrySnapshot,
};

#[cfg(target_arch = "wasm32")]
pub fn run_web() {
    view::run_web();
}

#[cfg(not(target_arch = "wasm32"))]
pub fn run_desktop() {
    view::run_desktop();
}
