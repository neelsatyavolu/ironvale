//! Ironvale for the Mac: a window around the same web build, plus the things
//! a WKWebView cannot do for a first-person game by itself.

mod assets;
#[cfg(debug_assertions)]
mod devbridge;
mod menu;
mod pointer;

use tauri::{Manager, RunEvent, WindowEvent};

/// The label of the only window, as declared in tauri.conf.json.
pub const MAIN_WINDOW: &str = "main";

fn main() {
    let mut context = tauri::tauri_build_context!();
    assets::serve_game_files_from_resources(&mut context);

    let builder = tauri::Builder::default()
        .manage(pointer::GrabState::default())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .menu(menu::build)
        .on_window_event(|window, event| match event {
            WindowEvent::Focused(false) | WindowEvent::CloseRequested { .. } | WindowEvent::Destroyed => {
                pointer::release(window.app_handle());
            }
            WindowEvent::Resized(_) | WindowEvent::Moved(_) | WindowEvent::ScaleFactorChanged { .. } => {
                pointer::recentre(window.app_handle());
            }
            _ => {}
        })
        // A page that reloads while it holds the pointer forgets that it does (hot reload in `app:dev`).
        .on_page_load(|webview, _| pointer::release(webview.app_handle()))
        .setup(|app| {
            pointer::release_on_deactivate(app.handle().clone());
            #[cfg(debug_assertions)]
            devbridge::start(app.handle().clone());
            Ok(())
        });

    #[cfg(debug_assertions)]
    let builder = builder.plugin(devbridge::plugin()).invoke_handler(tauri::generate_handler![
        pointer::pointer_grab,
        pointer::pointer_release,
        menu::toggle_fullscreen,
        devbridge::devbridge_reply
    ]);
    #[cfg(not(debug_assertions))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        pointer::pointer_grab,
        pointer::pointer_release,
        menu::toggle_fullscreen
    ]);

    builder
        .build(context)
        .expect("Ironvale could not start")
        .run(|app, event| {
            if matches!(event, RunEvent::ExitRequested { .. } | RunEvent::Exit) {
                pointer::release(app);
            }
        });
}
