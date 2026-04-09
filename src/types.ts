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
  season_display: string | null;
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
  release_date: string | null;
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
  tmdb_id: number | null;
}

export interface CrewUpdateInfo {
  name: string;
  job: string | null;
  tmdb_id: number | null;
}

export interface PersonUpdateInfo {
  name: string;
  tmdb_id: number | null;
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

// TMDB types

export interface TmdbSearchResult {
  id: number;
  title: string;
  release_date: string | null;
  overview: string | null;
  poster_path: string | null;
  vote_average: number | null;
}

export interface TmdbGenre {
  id: number;
  name: string;
}

export interface TmdbCompany {
  id: number;
  name: string;
}

export interface TmdbCastMember {
  id: number;
  name: string;
  character: string | null;
  order: number | null;
  profile_path: string | null;
}

export interface TmdbCrewMember {
  id: number;
  name: string;
  job: string | null;
  department: string | null;
  profile_path: string | null;
}

export interface TmdbImage {
  file_path: string;
  width: number;
  height: number;
  vote_average: number | null;
  iso_639_1: string | null;
}

export interface TmdbMovieDetail {
  id: number;
  title: string;
  overview: string | null;
  tagline: string | null;
  runtime: number | null;
  release_date: string | null;
  genres: TmdbGenre[];
  production_companies: TmdbCompany[];
  credits: {
    cast: TmdbCastMember[];
    crew: TmdbCrewMember[];
  } | null;
  keywords: { keywords: { id: number; name: string }[] } | null;
  releases: { countries: { iso_3166_1: string; certification: string }[] } | null;
  external_ids: { imdb_id: string | null } | null;
  images: { posters: TmdbImage[]; backdrops: TmdbImage[] } | null;
}

export interface TmdbImageDownload {
  file_path: string;
  size: string;
  image_type: "cover" | "background";
}

export interface TmdbFieldSelection {
  tmdb_id?: string;
  imdb_id?: string;
  plot?: string;
  tagline?: string;
  runtime?: number;
  release_date?: string;
  maturity_rating?: string;
  genres?: string[];
  directors?: PersonUpdateInfo[];
  cast?: CastUpdateInfo[];
  crew?: CrewUpdateInfo[];
  producers?: PersonUpdateInfo[];
  studios?: string[];
  keywords?: string[];
}

export interface MovieDetailUpdate {
  tmdb_id?: string | null;
  imdb_id?: string | null;
  rotten_tomatoes_id?: string | null;
  title?: string;
  release_date?: string;
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

// ---------- Show types ----------

export interface ShowDetail {
  id: number;
  tmdb_id: string | null;
  imdb_id: string | null;
  plot: string | null;
  tagline: string | null;
  maturity_rating: string | null;
  genres: string[];
  creators: PersonInfo[];
  cast: CastInfo[];
  crew: CrewInfo[];
  producers: PersonInfo[];
  studios: string[];
  keywords: string[];
}

export interface SeasonDetailLocal {
  id: number;
  title: string;
  season_number: number | null;
  plot: string | null;
  cast: CastInfo[];
  crew: CrewInfo[];
  directors: PersonInfo[];
  producers: PersonInfo[];
}

export interface EpisodeDetailLocal {
  id: number;
  title: string;
  episode_number: number | null;
  plot: string | null;
  runtime: number | null;
  cast: CastInfo[];
  crew: CrewInfo[];
}

// ---------- TMDB TV types ----------

export interface TmdbTvSearchResult {
  id: number;
  name: string;
  first_air_date: string | null;
  overview: string | null;
  poster_path: string | null;
  vote_average: number | null;
}

export interface TmdbTvDetail {
  id: number;
  name: string;
  overview: string | null;
  tagline: string | null;
  first_air_date: string | null;
  number_of_seasons: number | null;
  number_of_episodes: number | null;
  created_by: { id: number; name: string; profile_path: string | null }[];
  genres: TmdbGenre[];
  production_companies: TmdbCompany[];
  networks: { id: number; name: string }[];
  credits: {
    cast: TmdbCastMember[];
    crew: TmdbCrewMember[];
  } | null;
  keywords: { results: { id: number; name: string }[] } | null;
  content_ratings: { results: { iso_3166_1: string; rating: string }[] } | null;
  external_ids: { imdb_id: string | null } | null;
  images: { posters: TmdbImage[]; backdrops: TmdbImage[] } | null;
}

export interface TmdbSeasonDetail {
  id: number;
  name: string;
  overview: string | null;
  season_number: number;
  episodes: TmdbEpisodeSummary[];
  credits: {
    cast: TmdbCastMember[];
    crew: TmdbCrewMember[];
  } | null;
}

export interface TmdbEpisodeSummary {
  id: number;
  name: string;
  overview: string | null;
  episode_number: number;
  air_date: string | null;
  runtime: number | null;
  guest_stars: TmdbCastMember[];
  crew: TmdbCrewMember[];
}

export interface TmdbEpisodeDetail {
  id: number;
  name: string;
  overview: string | null;
  episode_number: number;
  air_date: string | null;
  runtime: number | null;
  guest_stars: TmdbCastMember[];
  crew: TmdbCrewMember[];
  still_path: string | null;
}

export interface TmdbShowFieldSelection {
  tmdb_id?: string;
  imdb_id?: string;
  plot?: string;
  tagline?: string;
  maturity_rating?: string;
  genres?: string[];
  creators?: PersonUpdateInfo[];
  cast?: CastUpdateInfo[];
  crew?: CrewUpdateInfo[];
  producers?: PersonUpdateInfo[];
  studios?: string[];
  keywords?: string[];
}

export interface TmdbSeasonFieldSelection {
  plot?: string;
  cast?: CastUpdateInfo[];
  crew?: CrewUpdateInfo[];
  directors?: PersonUpdateInfo[];
  producers?: PersonUpdateInfo[];
}

export interface TmdbEpisodeFieldSelection {
  plot?: string;
  runtime?: number;
  release_date?: string;
  cast?: CastUpdateInfo[];
  crew?: CrewUpdateInfo[];
}
