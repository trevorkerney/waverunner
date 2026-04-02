export interface Library {
  id: string;
  name: string;
  path: string;
  format: string;
  portable: boolean;
  db_filename: string;
  default_sort_mode: string;
  managed: boolean;
}

export interface EntriesResponse {
  entries: MediaEntry[];
  sort_mode: string;
}

export interface MediaEntry {
  id: number;
  title: string;
  year: string | null;
  folder_path: string;
  parent_id: number | null;
  is_collection: boolean;
  covers: string[];
  selected_cover: string | null;
}

export interface BreadcrumbItem {
  id: number | null;
  title: string;
}
