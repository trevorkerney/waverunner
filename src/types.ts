export interface Library {
  id: string;
  name: string;
  paths: string[];
  format: string;
  portable: boolean;
  db_filename: string;
  default_sort_mode: string;
  managed: boolean;
}

export interface EntriesResponse {
  entries: MediaEntry[];
  sort_mode: string;
  format: string;
}

export interface MediaEntry {
  id: number;
  title: string;
  year: string | null;
  end_year: string | null;
  folder_path: string;
  parent_id: number | null;
  entry_type: string;
  covers: string[];
  selected_cover: string | null;
}

export interface BreadcrumbItem {
  id: number | null;
  title: string;
}
