use serde::de::DeserializeOwned;
use wasm_bindgen::{JsCast, JsValue};
use wasm_bindgen_futures::JsFuture;
use web_sys::{Headers, Request, RequestCredentials, RequestInit, Response, Url};

use crate::model::{
    ApiEnvelope, BatterySnapshot, DashboardData, EventsPage, HealthSnapshot, StatusSnapshot,
    TelemetrySnapshot,
};

fn js_error(_: JsValue) -> String {
    "The API request failed. Check the API URL, token, and browser CORS settings.".to_owned()
}

fn validate_base_url(base: &str) -> Result<String, String> {
    let url = Url::new(base).map_err(|_| "Enter a valid API origin URL.".to_owned())?;
    let protocol = url.protocol();
    if protocol != "http:" && protocol != "https:" {
        return Err("The API URL must use HTTP or HTTPS.".to_owned());
    }
    if !url.username().is_empty() || !url.password().is_empty() {
        return Err("Do not put credentials in the API URL.".to_owned());
    }
    if !url.search().is_empty() || !url.hash().is_empty() {
        return Err("Use an API origin without a query or fragment.".to_owned());
    }
    Ok(url.origin())
}

async fn get<T: DeserializeOwned + Default>(
    base: &str,
    token: &str,
    path: &str,
) -> Result<Option<T>, String> {
    let headers = Headers::new().map_err(js_error)?;
    headers
        .set("Accept", "application/json")
        .map_err(js_error)?;
    headers
        .set("Authorization", &format!("Bearer {token}"))
        .map_err(js_error)?;

    let init = RequestInit::new();
    init.set_method("GET");
    init.set_credentials(RequestCredentials::Omit);
    init.set_headers(&headers);
    let request = Request::new_with_str_and_init(&format!("{base}/api/v1/{path}"), &init)
        .map_err(js_error)?;
    let window = web_sys::window().ok_or_else(|| "Browser window is unavailable.".to_owned())?;
    let response = JsFuture::from(window.fetch_with_request(&request))
        .await
        .map_err(js_error)?
        .dyn_into::<Response>()
        .map_err(js_error)?;
    if !response.ok() {
        return Err(format!("API returned HTTP {}.", response.status()));
    }

    let json = JsFuture::from(response.json().map_err(js_error)?)
        .await
        .map_err(js_error)?;
    let envelope: ApiEnvelope<T> = serde_wasm_bindgen::from_value(json)
        .map_err(|_| "API returned an unexpected response.".to_owned())?;
    if !envelope.ok {
        return Err(envelope
            .error
            .map(|error| {
                if error.message.is_empty() {
                    error.code
                } else {
                    error.message
                }
            })
            .unwrap_or_else(|| "API request was not accepted.".to_owned()));
    }
    Ok(envelope.data)
}

async fn read_dashboard(base: &str, token: &str) -> Result<DashboardData, String> {
    let base = validate_base_url(base)?;
    let telemetry: Option<TelemetrySnapshot> = get(&base, token, "telemetry").await?;
    let status: Option<StatusSnapshot> = get(&base, token, "status").await?;
    let battery: Option<BatterySnapshot> = get(&base, token, "battery").await?;
    let health: Option<HealthSnapshot> = get(&base, token, "health").await?;
    let events: Option<EventsPage> = get(&base, token, "events?limit=6").await?;

    Ok(DashboardData {
        telemetry,
        status,
        battery,
        health,
        events: events.map_or_else(Vec::new, |page| page.events),
    })
}

pub(crate) fn spawn_read(
    base: String,
    token: String,
    done: impl FnOnce(Result<DashboardData, String>) + 'static,
) {
    wasm_bindgen_futures::spawn_local(async move {
        let result = read_dashboard(&base, &token).await;
        done(result);
    });
}
