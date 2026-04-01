#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::Manager;
use std::{
	path::{Path, PathBuf},
	fs
};
use serde::{Serialize, Deserialize};

#[derive(Serialize, Deserialize, Debug)]
pub struct LibraryLocation {
	pub name: String,
	pub path: PathBuf,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct Config {
	pub default_lib: Option<String>,
	pub lib_locations: Vec<LibraryLocation>,
}

#[derive(Serialize, Deserialize, Debug)]
pub enum LibFormat {
	None,
	Movie,
	TV,
	Music
}

#[derive(Serialize, Deserialize, Debug)]
pub enum LibIndex {
	Simple, Nested
}

#[derive(Serialize, Deserialize, Debug)]
pub struct NewLibForm {
	pub name: String,
	pub path: PathBuf,
	pub format: LibFormat,
	pub indexing: LibIndex,
	pub metadata: bool,
	pub portable: bool
}

#[derive(Serialize, Deserialize, Debug)]
pub struct Media {
  pub id: u16,
  pub title: String,
  pub path: PathBuf,
  pub year: String,
  pub covers: Vec<PathBuf>,
  // pub cc: u16,
  // pub tags: Vec<Tag>,
  // pub featurettes: Vec<Media>,
  pub media: Vec<Media>
}

#[derive(Serialize, Deserialize, Debug)]
pub struct Library {
	pub name: String,
	pub format: LibFormat,
	pub indexing: LibIndex,

}

#[cfg(target_os = "windows")]
fn get_relative_cfg_path() -> Vec<&'static str> {
  return vec!["AppData", "Local", "Waverunner"];
}
#[cfg(target_os = "macos")]
fn get_relative_cfg_path() -> Vec<&'static str> {
  return vec!["Library", "Application Support", "Waverunner"];
}

fn get_cfg_path() -> Result<PathBuf, &'static str> {
  let mut path: PathBuf = match dirs::home_dir() {
    Some(d) => d,
    None => return Err("Failed to locate home directory.")
  };
  let chain: Vec<&str> = get_relative_cfg_path();
  for link in chain { path.push(Path::new(link)); }
  return Ok(path);
}

fn check_cfg_file() -> Result<(), String> {
	let mut path: PathBuf = get_cfg_path()?;
	path.push("cfg.json");
	match path.try_exists() {
		Err(e) => return Err(e.to_string()),
		Ok(exists) => match exists {
			false => return Err(String::from("cfg file does not exist.")),
			true => ()
		}
	};
	let cont = match fs::read(&path) {
		Ok(c) => match String::from_utf8(c) {
			Ok(cc) => cc,
			Err(e) => return Err(e.to_string())
		},
		Err(e) => return Err(e.to_string())
	};
	let _: Config = match serde_json::from_str(&cont) {
		Ok(i) => i,
		Err(e) => return Err(e.to_string())
	};
	return Ok(());
}

fn new_cfg_file() -> Result<(), String> {
	let mut path: PathBuf = get_cfg_path()?;
	path.push("cfg.json");
	let pref = Config {
		default_lib: None,
		lib_locations: vec!()
	};
	let pref_json = match serde_json::to_string_pretty(&pref) {
		Ok(pj) => pj,
		Err(e) => return Err(e.to_string())
	};
	return match fs::write(&path, pref_json) {
		Ok(()) => Ok(()),
		Err(e) => Err(e.to_string())
	};
}

#[allow(dead_code)]
fn safe_new_cfg_file() -> Result<(), String> {
	return match check_cfg_file() {
		Ok(()) => Err(String::from("There is already a valid cfg file.")),
		Err(_) => new_cfg_file()
	};
}

fn read_cfg_file() -> Result<Config, String> {
	let mut path: PathBuf = get_cfg_path()?;
	path.push("cfg.json");
	let cfg_file_contents = match fs::read(&path) {
		Ok(contents) => contents,
		Err(e) => return Err(e.to_string())
	};
	let cfg_json = match String::from_utf8(cfg_file_contents) {
		Ok(cj) => cj,
		Err(e) => return Err(e.to_string())
	};
	let cfg: Config = match serde_json::from_str(&cfg_json) {
		Ok(cfg) => cfg,
		Err(e) => return Err(e.to_string())
	};
	return Ok(cfg);
}

fn safe_create_lib(
	name: String,
	path: PathBuf,
	format: LibFormat,
	indexing: LibIndex,
	metadata: bool,
	portable: bool
) -> Result<Library, String> {

}

#[tauri::command]
fn create_lib(app: tauri::AppHandle, payload: NewLibForm) -> Result<Library, String> {
	let library = safe_create_lib(
		payload.name,
		payload.path,
		payload.format,
		payload.indexing,
		payload.metadata,
		payload.portable
	)?;
	match app.asset_protocol_scope().allow_directory(&payload.path, true) {
		Err(e) => return Err(e.to_string()),
		Ok(()) => ()
	};
	return Ok(library);
}

fn main() {
	match check_cfg_file() {
		Err(_) => match new_cfg_file() {
			Err(e) => panic!("{}", e),
			Ok(()) => ()
		},
		Ok(()) => (),
	};
	let config = match read_cfg_file() {
		Err(e) => panic!("{}", e),
		Ok(cfg) => cfg
	};

	tauri::Builder::default()
	.setup(|app| {
		let scope = app.app_handle().asset_protocol_scope();
		for location in config.lib_locations {
			match scope.allow_directory(&location.path, true) {
				Ok(()) => (),
				Err(e) => println!("Failed to add path {} to assets scope.\nerror: {}", location.path.display(), e)
			};
		}
		Ok(())
	})
	.invoke_handler(tauri::generate_handler![
		create_lib,
	])
	.run(tauri::generate_context!())
	.expect("error while running tauri application");
}
