fn main() {
    tauri_build::build();
    // Windows: the unit-test harness has no application manifest (tauri-build
    // embeds one only in the app binary), and since the menu stack (muda)
    // took a static reference to TaskDialogIndirect — a Common Controls v6
    // export — a manifest-less test exe dies at load with
    // STATUS_ENTRYPOINT_NOT_FOUND before any test runs (2026-10-18). Have
    // the linker write a side-by-side manifest (`<exe>.manifest`) carrying
    // that dependency for every target of this package. The app binary's
    // embedded manifest takes precedence over the file, so it's unaffected;
    // the harness, which has none embedded, loads through the file.
    // (`rustc-link-arg-tests` only covers `[[test]]` targets, not the lib's
    // own harness, hence the package-wide arg.)
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc")
    {
        println!("cargo::rustc-link-arg=/MANIFEST");
        println!(
            "cargo::rustc-link-arg=/MANIFESTDEPENDENCY:type='win32' name='Microsoft.Windows.Common-Controls' version='6.0.0.0' processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'"
        );
    }
}
