use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // 记忆窗口尺寸 / 位置 / 最大化状态，下次打开还原
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .setup(|app| {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.set_title("驭潮 YuChao");
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
