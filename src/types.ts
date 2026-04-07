export interface Library {
  id: string;
  name: string;
  paths: string[];
  format: string;
  portable: boolean;
  db_filename: string;
  default_sort_mode: string;
  managed: boolean;
  player_path: string | null;
  player_args: string | null;
}

export interface DetectedPlayer {
  name: string;
  path: string;
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
  child_count: number;
}

export interface BreadcrumbItem {
  id: number | null;
  title: string;
}

export interface PersonInfo {
  id: number;
  name: string;
  image_path: string | null;
}

export interface CastInfo extends PersonInfo {
  role: string | null;
}

export interface CrewInfo extends PersonInfo {
  job: string | null;
}

export interface MovieDetail {
  id: number;
  tmdb_id: string | null;
  imdb_id: string | null;
  rotten_tomatoes_id: string | null;
  plot: string | null;
  tagline: string | null;
  runtime: number | null;
  maturity_rating: string | null;
  genres: string[];
  directors: PersonInfo[];
  cast: CastInfo[];
  crew: CrewInfo[];
  producers: PersonInfo[];
  studios: string[];
  keywords: string[];
}

export interface CastUpdateInfo {
  name: string;
  role: string | null;
}

export interface CrewUpdateInfo {
  name: string;
  job: string | null;
}

export interface SeasonInfo {
  id: number;
  title: string;
  season_number: number | null;
  sort_order: number;
}

export interface EpisodeInfo {
  id: number;
  title: string;
  episode_number: number | null;
  file_path: string;
  sort_order: number;
}

export interface MovieDetailUpdate {
  tmdb_id?: string | null;
  imdb_id?: string | null;
  rotten_tomatoes_id?: string | null;
  title?: string;
  year?: string;
  plot?: string | null;
  tagline?: string | null;
  runtime?: number | null;
  maturity_rating?: string | null;
  genres?: string[];
  directors?: string[];
  cast?: CastUpdateInfo[];
  crew?: CrewUpdateInfo[];
  producers?: string[];
  studios?: string[];
  keywords?: string[];
}
