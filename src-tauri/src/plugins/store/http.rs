//! Minimal HTTPS GET for the store, on the hyper + rustls stack the S3 client already ships.
//! Follows a few redirects (GitHub release assets redirect to their CDN), https only, size capped.

use std::sync::Arc;
use std::time::Duration;

use http_body_util::{BodyExt, Empty};
use hyper::body::Bytes;
use hyper_util::client::legacy::Client;
use hyper_util::rt::TokioExecutor;

use crate::error::{AppError, AppResult};

const MAX_REDIRECTS: usize = 5;
/// A stalled transfer fails instead of hanging the install button.
const IDLE_TIMEOUT: Duration = Duration::from_secs(30);

fn net(e: impl std::fmt::Display) -> AppError {
    AppError::NetworkUnreachable(e.to_string())
}

fn timed_out() -> AppError {
    AppError::RequestTimeout("plugin store did not answer".into())
}

/// `progress(done, total)` is called as bytes arrive.
pub async fn get(url: &str, max_bytes: u64, mut progress: impl FnMut(u64, Option<u64>)) -> AppResult<Vec<u8>> {
    let provider = Arc::new(rustls::crypto::aws_lc_rs::default_provider());
    let https = hyper_rustls::HttpsConnectorBuilder::new()
        .with_provider_and_native_roots(provider)
        .map_err(net)?
        .https_only()
        .enable_http1()
        .build();
    let client: Client<_, Empty<Bytes>> = Client::builder(TokioExecutor::new()).build(https);

    let mut url = url.to_owned();
    for _ in 0..=MAX_REDIRECTS {
        if !url.starts_with("https://") {
            return Err(AppError::InvalidInput(format!("refusing non-https URL {url}")));
        }
        let req = hyper::Request::get(&url)
            .header(hyper::header::USER_AGENT, concat!("Cosmog/", env!("CARGO_PKG_VERSION")))
            .body(Empty::new())
            .map_err(net)?;
        let resp = tokio::time::timeout(IDLE_TIMEOUT, client.request(req)).await.map_err(|_| timed_out())?.map_err(net)?;
        let status = resp.status();
        if status.is_redirection() {
            url = resp
                .headers()
                .get(hyper::header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .ok_or_else(|| net(format!("{status} without a Location")))?
                .to_owned();
            continue;
        }
        if !status.is_success() {
            return Err(net(format!("{url}: HTTP {status}")));
        }
        let total = resp
            .headers()
            .get(hyper::header::CONTENT_LENGTH)
            .and_then(|v| v.to_str().ok()?.parse::<u64>().ok());
        if total.is_some_and(|t| t > max_bytes) {
            return Err(AppError::EntityTooLarge(format!("{url} is larger than {max_bytes} bytes")));
        }
        let mut body = resp.into_body();
        let mut out = Vec::with_capacity(total.unwrap_or(0) as usize);
        while let Some(frame) = tokio::time::timeout(IDLE_TIMEOUT, body.frame()).await.map_err(|_| timed_out())? {
            if let Ok(data) = frame.map_err(net)?.into_data() {
                out.extend_from_slice(&data);
                if out.len() as u64 > max_bytes {
                    return Err(AppError::EntityTooLarge(format!("{url} is larger than {max_bytes} bytes")));
                }
                progress(out.len() as u64, total);
            }
        }
        return Ok(out);
    }
    Err(net("too many redirects"))
}
