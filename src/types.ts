export interface Library {
  id: string;
  name: string;
  paths: string[];
  format: string;
  /** 'local' = read folders from disk. Future: 'jellyfin', 'plex', ... (client mode). */
  source: string;
  default_sort_mode: string;
  /** Import-wizard stage ('scan' | 'match' | 'review') while setup is
   *  unfinished; null = fully set up. Unfinished libraries render greyed
   *  ("Finish setup…") and resume the wizard instead of opening. */
  setup_stage: string | null;
}

export interface EntriesResponse {
  entries: MediaEntry[];
  sort_mode: string;
  format: string;
  selected_preset_id: number | null;
  presets: SortPreset[];
  /** Albums/Sounds views only: loose-track count for the header button —
   *  riding the grid payload keeps the button in the grid's render commit. */
  loose_count?: number | null;
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
  /** Watch history (movies only; shows derive theirs per-episode). */
  watched: boolean;
  /** Resume progress ratio (0..1) for the card sliver; null when none. */
  watch_progress: number | null;
  /** Deliberately marked unwatched — the state the grid badges, since
   *  watched is the library default. */
  unwatched: boolean;
  /** Partway through — counts as unwatched for the menu pivot (offer Mark
   *  watched) but never badges. */
  has_progress: boolean;
  /** Full release date (YYYY or YYYY-MM-DD) — client-side date sorting for
   *  music album entries; absent everywhere else. */
  sort_date?: string | null;
}

/** Refreshed per-entry watch flags (get_watch_flags) — patched into cached
 *  entry lists after playback so grid slivers/badges stay current. */
export interface EntryWatchFlags {
  id: number;
  watched: boolean;
  watch_progress: number | null;
  unwatched: boolean;
  has_progress: boolean;
}

/** Watch state for a movie detail page (get_watch_state). */
export interface WatchState {
  position_secs: number | null;
  duration_secs: number | null;
  watched: boolean;
  /** Deliberately marked unwatched (explicit row, not merely untracked). */
  unwatched: boolean;
  /** Interactive titles: a mid-story resume exists (Play → "Resume"). */
  interactive_resume: boolean;
}

/** One episode's watch row (get_show_watch). */
export interface EpisodeWatchInfo {
  episode_id: number;
  position_secs: number | null;
  duration_secs: number | null;
  watched: boolean;
}

/** Where a show's Play button should land (get_show_continue). */
export interface ContinueTarget {
  episode_id: number;
  season_number: number | null;
  episode_number: number | null;
  position_secs: number | null;
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
  // Home carries no library; the optional-undefined member keeps the
  // pervasive `view.libraryId` accesses type-legal (they see string | undefined).
  | { kind: "home";               libraryId?: undefined }
  | { kind: "library-root";       libraryId: string }
  | { kind: "movies-only";        libraryId: string }
  | { kind: "shows-only";         libraryId: string }
  | { kind: "people-all";         libraryId: string }
  | { kind: "people-list";        libraryId: string; role: PersonRole }
  | { kind: "genres";             libraryId: string }
  | { kind: "genre-detail";       libraryId: string; genre: string }
  | { kind: "person-detail";      libraryId: string; personId: number; role: PersonRole; personName: string; personImage: string | null }
  | { kind: "playlists";           libraryId: string }
  | { kind: "playlist-detail";    libraryId: string; playlistId: number; playlistName: string; collectionId: number | null }
  | { kind: "albums";             libraryId: string }
  | { kind: "sounds";             libraryId: string }
  | { kind: "tracks";             libraryId: string }
  | { kind: "loose-tracks";       libraryId: string; sounds: boolean }
  | { kind: "music-issues";       libraryId: string };

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

// Per-library sidebar counts (get_library_counts / get_music_counts — the
// music fields are only present for music libraries and vice versa).
export interface LibraryCounts {
  movies?: number;
  shows?: number;
  genres?: number;
  people?: number;
  actors?: number;
  directors_creators?: number;
  composers?: number;
  artists?: number;
  albums?: number;
  tracks?: number;
  sounds?: number;
  issues?: number;
}

// ---------- Music ----------

// One album card on an artist page (get_artist_detail).
export interface MusicAlbumCard {
  id: number;
  title: string;
  year: string | null;
  /** Full release date (YYYY or YYYY-MM-DD) — client-side date sorting. */
  release_date: string | null;
  covers: string[];
  selected_cover: string | null;
  track_count: number;
  release_count: number;
  runtime_secs: number;
  /** Owning artist — set on appears-on cards (another artist's album). */
  artist_title: string | null;
  /** Full artist credit for the album's header line (multi-artist albums list
   *  every owner; single-artist albums list the one). Linkable when resolved. */
  artists: { name: string; artist_id: number | null }[];
}

export interface MusicArtistDetail {
  id: number;
  title: string;
  covers: string[];
  selected_cover: string | null;
  album_count: number;
  track_count: number;
  albums: MusicAlbumCard[];
  /** Other artists' albums this artist is credited on (features). */
  appears_on: MusicAlbumCard[];
  /** Album-less tracks — the artist page's flat "Tracks" section. */
  loose_tracks: MusicTrack[];
  /** User-written biography (nothing fills this automatically yet). */
  biography: string | null;
}

// One name in a track's ordered credit list; artist_id set when the library
// has them as an artist (linkable to their page).
export interface MusicCredit {
  name: string;
  artist_id: number | null;
}

export interface MusicTrack {
  id: number;
  title: string;
  track_number: number | null;
  disc_number: number | null;
  runtime_secs: number | null;
  artist_name: string | null;
  /** Absolute path, ready to play. */
  file_path: string;
  play_count: number;
  loved: boolean;
  /** Main artist(s) first, then features — no "feat." framing. */
  credits: MusicCredit[];
}

// One owned version of an album (our release = MusicBrainz "release";
// label null = the plain/unnamed version).
export interface MusicRelease {
  id: number;
  label: string | null;
  is_default: boolean;
  disc_count: number;
  year: string | null;
  tracks: MusicTrack[];
}

export interface MusicAlbumDetail {
  id: number;
  title: string;
  /** "album" | "single" | "ep" | "compilation" | … — drives the page eyebrow. */
  album_type: string;
  year: string | null;
  /** null = artist-less album (no artist tags anywhere in it). */
  artist_id: number | null;
  artist_title: string | null;
  /** Multi-artist albums: full ordered credit, each linkable when the library
   *  has that artist. Empty = single artist (use artist_title). */
  artist_credits: { name: string; artist_id: number | null }[];
  covers: string[];
  selected_cover: string | null;
  genres: string[];
  releases: MusicRelease[];
  /** Sound-side entry (virtual collection) — swaps music affordances for
   *  collection ones (move tracks between collections, etc.). */
  is_sound: boolean;
  /** Matched to a MusicBrainz release — enables the track-list check. */
  mb_matched: boolean;
  /** Owning library — collection dialogs are library-scoped. */
  library_id: string;
}

// A file the scanner could not read at all (get_music_scan_issues).
export interface MusicScanIssue {
  file_path: string;
  reason: string;
}

// One row of the library-wide Tracks page (get_music_tracks). Loose tracks
// simply have null album (and possibly artist) columns.
export interface LibraryTrackRow {
  id: number;
  title: string;
  /** Display-only label for untitled tracks — never parsed into metadata. */
  file_name: string;
  file_path: string;
  runtime_secs: number | null;
  artist_name: string | null;
  artist_id: number | null;
  album_id: number | null;
  album_title: string | null;
  /** Album display cover (cached path) — the now-playing bar's art. */
  cover: string | null;
  play_count: number;
  loved: boolean;
  credits: MusicCredit[];
}

// Backend row from get_track_queue_items — everything needed to build a
// MusicQueueItem for tracks outside their album page (playlists).
export interface TrackQueueInfo {
  track_id: number;
  title: string;
  artist_name: string | null;
  artist_id: number | null;
  artists: MusicCredit[];
  album_id: number | null;
  album_title: string | null;
  /** Album display cover (cached path). */
  cover: string | null;
  file_path: string;
  duration_secs: number | null;
  loved: boolean;
}

// One card on the Home hub's continue-watching rail (get_continue_watching).
export interface ContinueWatchingItem {
  kind: "movie" | "show";
  entry_id: number;
  library_id: string;
  title: string;
  cover: string | null;
  /** The frame the user left at (captured on player close) — preferred card art. */
  frame: string | null;
  backdrop: string | null;
  last_played_at: string;
  position_secs: number | null;
  duration_secs: number | null;
  episode_id: number | null;
  season_number: number | null;
  episode_number: number | null;
  episode_title: string | null;
}

// One row of playback history (get_recent_music_plays) — every start counts.
export interface RecentPlay {
  track_id: number;
  track_title: string;
  /** For the untitled-track filename fallback (display-only convention). */
  file_path: string;
  artist_name: string | null;
  album_id: number | null;
  album_title: string | null;
  /** Album display cover (cached path), for tile surfaces. */
  cover: string | null;
  /** For cross-library navigation from global surfaces (Home). */
  library_id: string;
  /** SQLite UTC "YYYY-MM-DD HH:MM:SS". */
  started_at: string;
  scrobbled: boolean;
}

// One item in the frontend-owned play queue.
export interface MusicQueueItem {
  trackId: number;
  title: string;
  artistName: string | null;
  /** Main credit's artist entry — the now-playing bar's artist link target.
   *  Optional: queues persisted before this field existed lack it. */
  artistId?: number | null;
  /** Every credited artist in display order (id null = not in the library),
   *  so the bar can link each name individually. Optional like artistId. */
  artists?: { name: string; artistId: number | null }[];
  albumId: number | null;
  albumTitle: string | null;
  /** Cached cover path (full-res convention, same as MediaEntry.covers). */
  cover: string | null;
  /** Absolute file path for the backend to load. */
  path: string;
  durationSecs: number | null;
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

// Full person record for the person-detail header (biography rides in person_meta).
export interface PersonDetail {
  id: number;
  name: string;
  image_path: string | null;
  tmdb_id: number | null;
  biography: string | null;
}

// One hit from search_tmdb_person (match dialog / cast-editor TMDB source).
export interface TmdbPersonSearchResult {
  id: number;
  name: string;
  profile_path: string | null;
  known_for_department: string | null;
  known_for_summary: string | null;
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

/** One rendered choice: text, or a locally-resolved 3-state sprite sheet
 *  (image-only choices carry both; text is the no-assets fallback). */
export interface InteractiveChoiceView {
  text: string;
  subText: string | null;
  imagePath: string | null;
  imageSize: string | null;
  imagePosition: string | null;
}

/** Payload of interactive-choice-open (and interactive_status rehydration). */
export interface InteractiveChoiceOpen {
  segmentId: string;
  choices: InteractiveChoiceView[];
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

/** Live decode numbers for the stats panel (get_player_stats; snake_case). */
export interface PlayerStats {
  file: string | null;
  video_codec: string | null;
  width: number | null;
  height: number | null;
  container_fps: number | null;
  estimated_fps: number | null;
  dropped_frames: number | null;
  hwdec: string | null;
  position: number | null;
  duration: number | null;
  cache_secs: number | null;
}

export interface InteractiveJumpMetrics {
  jumps: number;
  seekJumps: number;
  lastFrom: string | null;
  lastTo: string | null;
  lastLatencyMs: number | null;
}

/** Engine internals for the stats panel (interactive_debug). */
export interface InteractiveDebug {
  segmentId: string;
  segmentStartMs: number;
  segmentEndMs: number | null;
  storyMs: number | null;
  pendingTarget: string | null;
  choiceOpen: boolean;
  snapshotCount: number;
  pathLen: number;
  persistentSet: number;
  globalSet: number;
  metrics: InteractiveJumpMetrics;
}

/** One decision point on the "Previous choices" timeline (interactive_history). */
export interface InteractiveHistoryEntry {
  index: number;
  segmentId: string;
  storyMs: number;
  fileMs: number;
  choiceTexts: string[];
  selectedIndex: number | null;
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
