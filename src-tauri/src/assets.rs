//! Textures, models and sounds are about 200 MB. Compiling them into the
//! binary would make every build slow, so they ship as plain files in the
//! bundle's Resources folder and are read from there when the page asks for
//! them. Everything else (the page, scripts, styles, fonts) stays embedded.

use std::borrow::Cow;
use std::path::PathBuf;
use std::sync::OnceLock;

use tauri::utils::assets::{AssetKey, CspHash};
use tauri::{App, Assets, Context, Manager, Runtime};

/// URL prefixes served from Resources. They mirror `bundle.resources` in tauri.conf.json.
const ON_DISK: [&str; 2] = ["/assets/dl/", "/assets/local/"];

pub fn serve_game_files_from_resources<R: Runtime>(context: &mut Context<R>) {
    let embedded = context.set_assets(Box::new(NoAssets));
    context.set_assets(Box::new(GameAssets { embedded, resources: OnceLock::new() }));
}

struct GameAssets<R: Runtime> {
    embedded: Box<dyn Assets<R>>,
    resources: OnceLock<PathBuf>,
}

impl<R: Runtime> Assets<R> for GameAssets<R> {
    fn setup(&self, app: &App<R>) {
        self.embedded.setup(app);
        match app.path().resource_dir() {
            Ok(dir) => {
                let _ = self.resources.set(dir);
            }
            Err(error) => eprintln!("no Resources folder, so game files cannot load: {error}"),
        }
    }

    fn get(&self, key: &AssetKey) -> Option<Cow<'_, [u8]>> {
        if let Some(found) = self.embedded.get(key) {
            return Some(found);
        }
        let path = key.as_ref();
        if !ON_DISK.iter().any(|prefix| path.starts_with(prefix)) || path.split('/').any(|part| part == "..") {
            return None;
        }
        let file = self.resources.get()?.join(path.trim_start_matches('/'));
        std::fs::read(file).ok().map(Cow::Owned)
    }

    fn iter(&self) -> Box<dyn Iterator<Item = (Cow<'_, str>, Cow<'_, [u8]>)> + '_> {
        self.embedded.iter()
    }

    fn csp_hashes(&self, html_path: &AssetKey) -> Box<dyn Iterator<Item = CspHash<'_>> + '_> {
        self.embedded.csp_hashes(html_path)
    }
}

/// Stands in for a moment while the embedded assets are moved into `GameAssets`.
struct NoAssets;

impl<R: Runtime> Assets<R> for NoAssets {
    fn get(&self, _key: &AssetKey) -> Option<Cow<'_, [u8]>> {
        None
    }

    fn iter(&self) -> Box<dyn Iterator<Item = (Cow<'_, str>, Cow<'_, [u8]>)> + '_> {
        Box::new(std::iter::empty())
    }

    fn csp_hashes(&self, _html_path: &AssetKey) -> Box<dyn Iterator<Item = CspHash<'_>> + '_> {
        Box::new(std::iter::empty())
    }
}
