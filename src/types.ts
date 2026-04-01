export interface Library {
  id: string;
  name: string;
  path: string;
  format: string;
  portable: boolean;
}

export interface MediaEntry {
  id: number;
  title: string;
  year: string | null;
  folder_path: string;
  parent_id: number | null;
  is_collection: boolean;
  covers: string[];
}

export interface BreadcrumbItem {
  id: number | null;
  title: string;
}
