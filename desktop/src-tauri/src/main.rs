// Windows 下不弹控制台；macOS 无影响
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    yuchao_desktop_lib::run()
}
