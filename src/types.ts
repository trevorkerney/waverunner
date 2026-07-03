export interface Library {
  id: string;
  name: string;
  paths: string[];
  format: string;
  /** 'local' = read folders from disk. Future: 'jellyfin', 'plex', ... (client mode). */
  source: string;
  default_sort_mode: string;
}

export interface EntriesResponse {
  entries: MediaEntry[];
  sort_mode: string;
  format: string;
  selected_preset_id: number | null;
  presets: SortPreset[];
}

export interface SortPreset {
  id: number;
  name: string;
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
  collection_display: string | null;
  /** "as Walter White" — only set on person-page filmography entries; shown
   *  instead of the usual subtitle. */
  role_display?: string | null;
  tmdb_id: string | null;
  /** Non-null only when this row represents a `media_link` inside a playlist view.
   *  Used to offer "Remove from playlist" from the context menu. */
  link_id: number | null;
  /** Movie with an interactive branch-graph pair next to its video — Play
   *  routes into the interactive engine instead of linear playback. */
  interactive: boolean;
}

// Each step in the navigation chain. `view` is set when this breadcrumb corresponds to a
// distinct view switch (sidebar node click, drill into person-detail) — clicking or popping
// to this crumb restores that view. When absent, this crumb is a drill-in within the current
// view (e.g. a nested collection in library-root) and navigation uses parent-id semantics.
export interface BreadcrumbItem {
  id: number | null;
  title: string;
  view?: ViewSpec;
  /** Set when this crumb is a movie/show detail page. Lets breadcrumb/back/forward
   *  navigation restore the detail page instead of treating the id as a grid parent
   *  (a movie id used as parent_id loads an empty grid). */
  entry?: MediaEntry;
  /** True for crumbs synthesized by canonical re-rooting (loop collapse / detail
   *  reset) rather than actually visited. The sidebar highlights a genuine root,
   *  but falls back to content-based highlighting when the root is synthetic. */
  synthetic?: boolean;
}

// ---------- Sidebar complications ----------

export type PersonRole = "actor" | "director_creator" | "composer" | "all";

// "Where the user is" — drives what MainContent renders. Sidebar selection
// always corresponds to a ViewSpec, and so do drill-downs that originate
// from the main content (e.g. clicking a person on a people-list view).
export type ViewSpec =
  | { kind: "library-root";       libraryId: string }
  | { kind: "movies-only";        libraryId: string }
  | { kind: "shows-only";         libraryId: string }
  | { kind: "people-all";         libraryId: string }
  | { kind: "people-list";        libraryId: string; role: PersonRole }
  | { kind: "genres";             libraryId: string }
  | { kind: "genre-detail";       libraryId: string; genre: string }
  | { kind: "person-detail";      libraryId: string; personId: number; role: PersonRole; personName: string; personImage: string | null }
  | { kind: "playlists";           libraryId: string }
  | { kind: "playlist-detail";    libraryId: string; playlistId: number; playlistName: string; collectionId: number | null };

// One node in the static complication tree shown for a library.
export interface ComplicationNode {
  id: string;
  label: string;
  iconName: string;
  view: ViewSpec | null;
  children?: ComplicationNode[];
  /** Item count shown dimmed in parentheses after the label, when known. */
  count?: number;
  /** Start with children collapsed (default is expanded). */
  defaultCollapsed?: boolean;
}

// One genre with a count of works carrying it (get_genres_in_library).
export interface GenreSummary {
  name: string;
  count: number;
}

// Per-library sidebar counts (get_library_counts).
export interface LibraryCounts {
  movies: number;
  shows: number;
  genres: number;
  people: number;
  actors: number;
  directors_creators: number;
  composers: number;
}

// D&C-page subtitle buckets (get_people_in_library, role "director_creator").
// Disjoint by title: each title counts once at the person's highest credit on
// it — created show > fully-directed show > episode scatter; films separate.
export interface DirectorCreatorCounts {
  films: number;
  /** Shows where their episode credits cover every episode in the library. */
  shows: number;
  /** Episodes directed on shows below full coverage (not created by them). */
  episodes: number;
  /** Distinct shows those scattered episodes span. */
  episode_shows: number;
  created: number;
}

// Returned by get_people_in_library.
export interface PersonSummary {
  id: number;
  name: string;
  image_path: string | null;
  /** Distinct titles credited in the requested role. Drives "Most credited" ranking. */
  work_count: number;
  /** Pinned to the top of alphabetical people views. */
  favorite: boolean;
  /** D&C breakdown — D&C page, and the all-people page when non-empty. */
  dc: DirectorCreatorCounts | null;
  /** Acting split ("in 23 movies & 4 shows") — Actors page, and the all-people page when non-empty. */
  acting: TitleCounts | null;
  /** Composing split ("scored 12 movies & 3 shows") — Composers page, and the all-people page when non-empty. */
  composing: TitleCounts | null;
}

// Plain film/show split of a role's distinct titles. A show counts once no
// matter the credit's level (show, season, or episode) or how many
// characters/episodes were involved.
export interface TitleCounts {
  films: number;
  shows: number;
}

export interface PlaylistSummary {
  id: number;
  title: string;
  selected_cover: string | null;
  covers: string[];
  movie_count: number;
  show_count: number;
  /** Nested collections (recursive) — with the link counts, decides whether deletion confirms. */
  collection_count: number;
  /** Items at the playlist's top level only (links + collections) — the sidebar count. */
  root_item_count: number;
  year: string | null;
  end_year: string | null;
}

// Result of `get_playlists` — the playlists plus the saved presets / selected preset
// for the playlists-LIST sort scope (drives the toolbar's preset dropdown).
export interface PlaylistsResponse {
  playlists: PlaylistSummary[];
  presets: SortPreset[];
  selected_preset_id: number | null;
}

// Result of `get_playlist_contents`. Entries are a mix of linked media
// (with `link_id` populated, `entry_type` = target's type) and nested
// playlist-collection groups (`entry_type` = "playlist_collection").
export interface PlaylistContents {
  entries: MediaEntry[];
  sort_mode: string;
  playlist_name: string;
  selected_preset_id: number | null;
  presets: SortPreset[];
}

export interface PersonInfo {
  id: number;
  name: string;
  image_path: string | null;
}

// Returned by search_people_by_character (people-page search by character name).
export interface CharacterMatch {
  person: PersonSummary;
  matched_role: string;
  matched_title: string;
  /** Other distinct matching character strings for this person. */
  extra_matches: number;
}

export interface CastInfo extends PersonInfo {
  role: string | null;
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
  composers: PersonInfo[];
  studios: string[];
  keywords: string[];
  /** Backdrop for the detail-page hero (selected, or first cached). */
  backdrop: string | null;
}

export interface CastUpdateInfo {
  name: string;
  role: string | null;
  tmdb_id: number | null;
  profile_path: string | null;
}

export interface PersonUpdateInfo {
  name: string;
  tmdb_id: number | null;
  profile_path: string | null;
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
  /** Last episode covered by a multi-episode file ("S01E01-E02" → 2); null otherwise. */
  episode_number_end: number | null;
  file_path: string;
  sort_order: number;
  /** Shown inline in the episode list (clamped) — full detail loads on expand. */
  plot: string | null;
  runtime: number | null;
  release_date: string | null;
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
  image_type: "cover" | "backdrop";
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
  composers?: PersonUpdateInfo[];
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
  composers?: string[];
  studios?: string[];
  keywords?: string[];
}

// ---------- Show types ----------

export interface ShowDetail {
  id: number;
  tmdb_id: string | null;
  imdb_id: string | null;
  rotten_tomatoes_id: string | null;
  plot: string | null;
  tagline: string | null;
  maturity_rating: string | null;
  genres: string[];
  creators: PersonInfo[];
  cast: CastInfo[];
  composers: PersonInfo[];
  studios: string[];
  keywords: string[];
  /** Sum of every episode's runtime — null unless ALL episodes have one. */
  total_runtime: number | null;
  /** Backdrop for the detail-page hero (selected, or first cached). */
  backdrop: string | null;
}

export interface SeasonDetailLocal {
  id: number;
  title: string;
  season_number: number | null;
  plot: string | null;
  cast: CastInfo[];
}

export interface EpisodeDetailLocal {
  id: number;
  title: string;
  episode_number: number | null;
  episode_number_end: number | null;
  release_date: string | null;
  plot: string | null;
  runtime: number | null;
  cast: CastInfo[];
  directors: PersonInfo[];
  composers: PersonInfo[];
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
  seasons: TmdbSeasonStub[];
}

export interface TmdbSeasonStub {
  season_number: number;
  name: string;
  episode_count: number;
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
  composers?: PersonUpdateInfo[];
  studios?: string[];
  keywords?: string[];
}

export interface TmdbSeasonFieldSelection {
  plot?: string;
  cast?: CastUpdateInfo[];
  season_director?: PersonUpdateInfo[];
}

export interface TmdbEpisodeFieldSelection {
  title?: string;
  plot?: string;
  runtime?: number;
  release_date?: string;
  cast?: CastUpdateInfo[];
  director?: PersonUpdateInfo[];
  composer?: PersonUpdateInfo[];
}

export interface BulkMovieTarget {
  id: number;
  title: string;
  year: string | null;
}

export interface BulkShowTarget {
  id: number;
  title: string;
  year: string | null;
  tmdb_id: string | null;
}

export interface BulkSeasonTarget {
  id: number;
  show_id: number;
  season_number: number;
  episode_count: number;
  /** Season-metadata pass already ran — not counted, not refetched. */
  season_done: boolean;
  /** Per-episode pass already ran — not counted, not refetched. */
  episodes_done: boolean;
}

export interface BulkWebisodeTarget {
  show_id: number;
  extra_count: number;
}

export interface TmdbBulkTargets {
  movies: BulkMovieTarget[];
  shows: BulkShowTarget[];
  seasons: BulkSeasonTarget[];
  webisodes: BulkWebisodeTarget[];
  /** Every movie in the library — the ratings pass targets all of them. */
  all_movies: BulkMovieTarget[];
  /** Every show in the library — the ratings pass covers these too. */
  all_shows: BulkMovieTarget[];
}

export interface RatingInfo {
  /** 'rotten_tomatoes_audience' | 'rotten_tomatoes' | 'imdb' | 'metacritic' */
  source: string;
  value: string;
}

export interface ExtraInfo {
  id: number;
  kind: string;
  title: string;
  file_path: string;
  plot: string | null;
  release_date: string | null;
  runtime: number | null;
}

export interface ShowEpisodeFlat {
  episode_id: number;
  season_id: number;
  season_number: number | null;
  episode_number: number | null;
  title: string;
  file_path: string;
}

export interface EpisodeRef {
  episodeId: number;
  seasonId: number;
  seasonNumber: number | null;
  episodeNumber: number | null;
  title: string;
}

export type PlayerContext =
  | { kind: "none" }
  | { kind: "movie" }
  | { kind: "interactive"; libraryId: string; entryId: number }
  | {
      kind: "episode";
      libraryId: string;
      showId: number;
      showTitle: string;
      episodes: EpisodeRef[];
      index: number;
    };

/** Payload of interactive-choice-open (and interactive_status rehydration). */
export interface InteractiveChoiceOpen {
  segmentId: string;
  choices: { text: string; subText: string | null }[];
  defaultIndex: number;
  remainingMs: number;
  totalMs: number;
  layoutType: string | null;
  selectedIndex: number | null;
}

export interface InteractiveStatus {
  entryId: number;
  libraryId: string;
  title: string;
  segmentId: string;
  choice: InteractiveChoiceOpen | null;
}

export interface PlayerTrack {
  id: number;
  type: "audio" | "sub" | "video";
  title: string | null;
  lang: string | null;
  selected: boolean;
  /** True for attached-picture streams (embedded cover art / backdrops) that
   *  masquerade as video tracks — excluded from the video-track picker. */
  albumart: boolean;
}
