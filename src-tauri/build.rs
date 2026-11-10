fn main() {
    // Embedding the web build from the build script (not from a macro in main.rs)
    // lets cargo see when the staged files in `web/` change and rebuild.
    let attributes = tauri_build::Attributes::new().codegen(tauri_build::CodegenContext::new());
    tauri_build::try_build(attributes).expect("tauri-build failed");
}
