//! Cursor capture for first-person look, with public APIs only.
//!
//! WKWebView refuses `requestPointerLock`, so the page asks the app instead.
//! A grab warps the cursor to the middle of the window (so clicks land on the
//! game), detaches it from mouse movement and hides it. WebKit keeps filling
//! `movementX` and `movementY` from the raw event deltas while it is frozen.
//!
//! The grab is given back on request, when the window loses focus, when the
//! app is deactivated and when the window closes. `GrabState` is the single
//! record of whether it is held, so hide and unhide stay balanced.

use std::sync::atomic::{AtomicU64, Ordering};

use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, Runtime, State, WebviewWindow};

use crate::MAIN_WINDOW;

/// Sent to the page when the app lets go without being asked, with the number of the grab that ended.
const RELEASED_EVENT: &str = "pointer-released";

const FREE: u64 = 0;

/// Grabs are numbered from 1 so the page can tell a late report about an old
/// grab from one about the grab it holds now.
#[derive(Default)]
pub struct GrabState {
    /// The number of the grab held now, or `FREE`.
    current: AtomicU64,
    last: AtomicU64,
}

impl GrabState {
    pub fn is_held(&self) -> bool {
        self.current.load(Ordering::SeqCst) != FREE
    }
}

/// Returns the grab's number.
#[tauri::command]
pub fn pointer_grab<R: Runtime>(window: WebviewWindow<R>, state: State<'_, GrabState>) -> Result<u64, String> {
    // A background window must never freeze the cursor under another app.
    if !window.is_focused().map_err(|error| error.to_string())? || !app_is_active() {
        return Err("the window is not focused".into());
    }
    freeze_at_centre(&window).map_err(|error| error.to_string())?;
    let held = state.current.load(Ordering::SeqCst);
    if held != FREE {
        return Ok(held);
    }
    let id = state.last.fetch_add(1, Ordering::SeqCst) + 1;
    state.current.store(id, Ordering::SeqCst);
    set_cursor_hidden(window.app_handle(), true);
    Ok(id)
}

#[tauri::command]
pub fn pointer_release<R: Runtime>(app: AppHandle<R>) {
    give_back(&app);
}

/// Lets go if the grab is held and tells the page. Safe to call at any time.
pub fn release<R: Runtime>(app: &AppHandle<R>) {
    if let Some(id) = give_back(app) {
        if let Err(error) = app.emit(RELEASED_EVENT, id) {
            eprintln!("could not tell the page the pointer was released: {error}");
        }
    }
}

/// Keeps a held cursor inside the window after it moved or changed size.
pub fn recentre<R: Runtime>(app: &AppHandle<R>) {
    if !app.state::<GrabState>().is_held() {
        return;
    }
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        if let Err(error) = freeze_at_centre(&window) {
            eprintln!("could not recentre the pointer: {error}");
        }
    }
}

/// Window blur covers most deactivations; this catches the rest (another app
/// brought forward while a panel of ours holds the keyboard, for instance).
#[cfg(target_os = "macos")]
pub fn release_on_deactivate<R: Runtime>(app: AppHandle<R>) {
    use std::ptr::NonNull;

    use block2::RcBlock;
    use objc2_app_kit::NSApplicationDidResignActiveNotification;
    use objc2_foundation::{NSNotification, NSNotificationCenter};

    let block = RcBlock::new(move |_: NonNull<NSNotification>| release(&app));
    // SAFETY: the notification name is a valid AppKit constant, and the block
    // only touches thread-safe state. With no queue it runs on the posting
    // thread, which for this notification is the main thread.
    let observer = unsafe {
        NSNotificationCenter::defaultCenter().addObserverForName_object_queue_usingBlock(
            Some(NSApplicationDidResignActiveNotification),
            None,
            None,
            &block,
        )
    };
    // The observer lives as long as the app does.
    std::mem::forget(observer);
}

#[cfg(not(target_os = "macos"))]
pub fn release_on_deactivate<R: Runtime>(_app: AppHandle<R>) {}

/// A window can still call itself key for a moment after another app has come forward.
#[cfg(target_os = "macos")]
fn app_is_active() -> bool {
    objc2_app_kit::NSRunningApplication::currentApplication().isActive()
}

#[cfg(not(target_os = "macos"))]
fn app_is_active() -> bool {
    true
}

/// Returns the number of the grab that was held, if one was.
fn give_back<R: Runtime>(app: &AppHandle<R>) -> Option<u64> {
    let id = app.state::<GrabState>().current.swap(FREE, Ordering::SeqCst);
    if id == FREE {
        return None;
    }
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        if let Err(error) = window.set_cursor_grab(false) {
            eprintln!("could not free the pointer: {error}");
        }
    }
    set_cursor_hidden(app, false);
    Some(id)
}

/// `NSCursor` counts hides, so every hide needs one unhide: `pointer_grab`
/// hides only when it starts a new grab and `give_back` unhides only when it
/// ends one. Both run on the main thread, so they cannot interleave. Tauri's own
/// `set_cursor_visible` works through cursor rectangles, which a webview
/// overrides, so it would leave the cursor showing.
#[cfg(target_os = "macos")]
fn set_cursor_hidden<R: Runtime>(app: &AppHandle<R>, hidden: bool) {
    use objc2_app_kit::NSCursor;

    let result = app.run_on_main_thread(move || {
        if hidden {
            NSCursor::hide();
        } else {
            NSCursor::unhide();
        }
    });
    if let Err(error) = result {
        eprintln!("could not change the pointer's visibility: {error}");
    }
}

#[cfg(not(target_os = "macos"))]
fn set_cursor_hidden<R: Runtime>(app: &AppHandle<R>, hidden: bool) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        if let Err(error) = window.set_cursor_visible(!hidden) {
            eprintln!("could not change the pointer's visibility: {error}");
        }
    }
}

fn freeze_at_centre<R: Runtime>(window: &WebviewWindow<R>) -> tauri::Result<()> {
    let size = window.inner_size()?;
    // Warping re-attaches the cursor, so the grab has to come second.
    window.set_cursor_position(PhysicalPosition::new(f64::from(size.width) / 2.0, f64::from(size.height) / 2.0))?;
    window.set_cursor_grab(true)
}
