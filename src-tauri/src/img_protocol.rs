//! `wrimg://` — an image-serving protocol that never blocks the UI thread.
//!
//! Tauri's built-in `asset://` handler runs synchronously inside WebView2's
//! WebResourceRequested callback, on the window's main thread: two
//! spawn_blocking round-trips plus the file read per request. A virtualized
//! grid scrolling fast through thousands of face images floods that thread
//! with blocking calls and the whole window stops responding. This handler
//! does only the URL parse on the UI thread and reads + responds from the
//! async runtime. It also sends cache headers (asset:// sends none), so a card
//! that unmounts and remounts during a scroll doesn't refetch from disk.
//!
//! Scope: any absolute path with an image extension and no `..` — the same
//! reach as the app's `asset://` scope (`**`), narrowed to image types. Cover
//! paths can come from library caches, added images, or people_images, all
//! under the app data dir today, but the check doesn't depend on that.

use std::{
    borrow::Cow,
    path::{Component, Path},
};

use tauri::{
    http::{header, Request, Response, StatusCode},
    Runtime, UriSchemeContext, UriSchemeResponder,
};

pub const SCHEME: &str = "wrimg";

pub fn handle<R: Runtime>(
    ctx: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    let _ = ctx;
    // `convertFileSrc(path, "wrimg")` yields `wrimg://localhost/<encoded path>`
    // (`http://wrimg.localhost/…` on Windows); the path component is the
    // percent-encoded absolute file path with a leading slash.
    let raw = request.uri().path();
    let path = percent_encoding::percent_decode_str(raw.strip_prefix('/').unwrap_or(raw))
        .decode_utf8_lossy()
        .into_owned();
    tauri::async_runtime::spawn(async move {
        responder.respond(serve(&path).await);
    });
}

fn empty(code: StatusCode) -> Response<Cow<'static, [u8]>> {
    Response::builder()
        .status(code)
        .body(Cow::Borrowed(&[][..]))
        .expect("static response")
}

async fn serve(path: &str) -> Response<Cow<'static, [u8]>> {
    let file = Path::new(path);
    let escapes = file.components().any(|c| matches!(c, Component::ParentDir));
    let Some(mime) = mime_for(file) else {
        return empty(StatusCode::FORBIDDEN);
    };
    if escapes || !file.is_absolute() {
        return empty(StatusCode::FORBIDDEN);
    }
    match tokio::fs::read(file).await {
        Ok(bytes) => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, mime)
            .header(header::CONTENT_LENGTH, bytes.len())
            .header(header::CACHE_CONTROL, "public, max-age=86400")
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .body(Cow::Owned(bytes))
            .expect("image response"),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => empty(StatusCode::NOT_FOUND),
        Err(_) => empty(StatusCode::INTERNAL_SERVER_ERROR),
    }
}

/// Image types this protocol serves; anything else is refused.
fn mime_for(path: &Path) -> Option<&'static str> {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .as_deref()
    {
        Some("jpg") | Some("jpeg") => Some("image/jpeg"),
        Some("png") => Some("image/png"),
        Some("webp") => Some("image/webp"),
        Some("gif") => Some("image/gif"),
        Some("bmp") => Some("image/bmp"),
        Some("avif") => Some("image/avif"),
        _ => None,
    }
}
