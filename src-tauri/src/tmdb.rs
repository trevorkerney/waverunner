use reqwest::Client;
use serde::{Deserialize, Serialize};
use url::Url;

const BASE_URL: &str = "https://api.themoviedb.org/3";

// ---------- Search ----------

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TmdbSearchResult {
    pub id: i64,
    pub title: String,
    pub release_date: Option<String>,
    pub overview: Option<String>,
    pub poster_path: Option<String>,
    pub vote_average: Option<f64>,
}

#[derive(Debug, Deserialize)]
pub struct TmdbSearchResponse {
    pub results: Vec<TmdbSearchResult>,
}

pub async fn search_movie(
    client: &Client,
    token: &str,
    query: &str,
    year: Option<&str>,
) -> Result<TmdbSearchResponse, String> {
    let mut url = Url::parse(&format!("{BASE_URL}/search/movie"))
        .map_err(|e| format!("Invalid URL: {e}"))?;
    url.query_pairs_mut().append_pair("query", query);
    if let Some(y) = year {
        if !y.is_empty() {
            url.query_pairs_mut().append_pair("year", y);
        }
    }

    let resp = client
        .get(url)
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| format!("TMDB request failed: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("TMDB API error {status}: {body}"));
    }

    resp.json::<TmdbSearchResponse>()
        .await
        .map_err(|e| format!("Failed to parse TMDB response: {e}"))
}

// ---------- Movie Detail ----------

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TmdbMovieDetail {
    pub id: i64,
    pub title: String,
    pub overview: Option<String>,
    pub tagline: Option<String>,
    pub runtime: Option<i64>,
    pub release_date: Option<String>,
    pub genres: Vec<TmdbGenre>,
    pub production_companies: Vec<TmdbCompany>,
    pub credits: Option<TmdbCredits>,
    pub keywords: Option<TmdbKeywords>,
    pub releases: Option<TmdbReleases>,
    pub external_ids: Option<TmdbExternalIds>,
    pub images: Option<TmdbImages>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TmdbGenre {
    pub id: i64,
    pub name: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TmdbCompany {
    pub id: i64,
    pub name: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TmdbCredits {
    pub cast: Vec<TmdbCastMember>,
    pub crew: Vec<TmdbCrewMember>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TmdbCastMember {
    pub id: i64,
    pub name: String,
    pub character: Option<String>,
    pub order: Option<i64>,
    pub profile_path: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TmdbCrewMember {
    pub id: i64,
    pub name: String,
    pub job: Option<String>,
    pub department: Option<String>,
    pub profile_path: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TmdbKeywords {
    pub keywords: Vec<TmdbKeyword>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TmdbKeyword {
    pub id: i64,
    pub name: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TmdbReleases {
    pub countries: Vec<TmdbCountryRelease>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TmdbCountryRelease {
    pub iso_3166_1: String,
    pub certification: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TmdbExternalIds {
    pub imdb_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TmdbImages {
    pub posters: Vec<TmdbImage>,
    pub backdrops: Vec<TmdbImage>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TmdbImage {
    pub file_path: String,
    pub width: i64,
    pub height: i64,
    pub vote_average: Option<f64>,
    pub iso_639_1: Option<String>,
}

pub async fn get_movie_detail(
    client: &Client,
    token: &str,
    tmdb_id: i64,
) -> Result<TmdbMovieDetail, String> {
    let url = format!(
        "{BASE_URL}/movie/{tmdb_id}?append_to_response=credits,keywords,images,releases,external_ids"
    );

    let resp = client
        .get(&url)
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| format!("TMDB request failed: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("TMDB API error {status}: {body}"));
    }

    resp.json::<TmdbMovieDetail>()
        .await
        .map_err(|e| format!("Failed to parse TMDB movie detail: {e}"))
}

// ---------- TV Search ----------

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TmdbTvSearchResult {
    pub id: i64,
    pub name: String,
    pub first_air_date: Option<String>,
    pub overview: Option<String>,
    pub poster_path: Option<String>,
    pub vote_average: Option<f64>,
}

#[derive(Debug, Deserialize)]
pub struct TmdbTvSearchResponse {
    pub results: Vec<TmdbTvSearchResult>,
}

pub async fn search_tv(
    client: &Client,
    token: &str,
    query: &str,
    year: Option<&str>,
) -> Result<TmdbTvSearchResponse, String> {
    let mut url = Url::parse(&format!("{BASE_URL}/search/tv"))
        .map_err(|e| format!("Invalid URL: {e}"))?;
    url.query_pairs_mut().append_pair("query", query);
    if let Some(y) = year {
        if !y.is_empty() {
            url.query_pairs_mut().append_pair("first_air_date_year", y);
        }
    }

    let resp = client
        .get(url)
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| format!("TMDB request failed: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("TMDB API error {status}: {body}"));
    }

    resp.json::<TmdbTvSearchResponse>()
        .await
        .map_err(|e| format!("Failed to parse TMDB response: {e}"))
}

// ---------- TV Detail ----------

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TmdbTvDetail {
    pub id: i64,
    pub name: String,
    pub overview: Option<String>,
    pub tagline: Option<String>,
    pub first_air_date: Option<String>,
    pub number_of_seasons: Option<i64>,
    pub number_of_episodes: Option<i64>,
    pub created_by: Vec<TmdbCreator>,
    pub genres: Vec<TmdbGenre>,
    pub production_companies: Vec<TmdbCompany>,
    pub networks: Vec<TmdbNetwork>,
    pub credits: Option<TmdbCredits>,
    pub keywords: Option<TmdbTvKeywords>,
    pub content_ratings: Option<TmdbContentRatings>,
    pub external_ids: Option<TmdbExternalIds>,
    pub images: Option<TmdbImages>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TmdbCreator {
    pub id: i64,
    pub name: String,
    pub profile_path: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TmdbNetwork {
    pub id: i64,
    pub name: String,
}

// TV keywords use "results" not "keywords"
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TmdbTvKeywords {
    pub results: Vec<TmdbKeyword>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TmdbContentRatings {
    pub results: Vec<TmdbContentRating>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TmdbContentRating {
    pub iso_3166_1: String,
    pub rating: String,
}

pub async fn get_tv_detail(
    client: &Client,
    token: &str,
    tmdb_id: i64,
) -> Result<TmdbTvDetail, String> {
    let url = format!(
        "{BASE_URL}/tv/{tmdb_id}?append_to_response=credits,keywords,images,content_ratings,external_ids"
    );

    let resp = client
        .get(&url)
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| format!("TMDB request failed: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("TMDB API error {status}: {body}"));
    }

    resp.json::<TmdbTvDetail>()
        .await
        .map_err(|e| format!("Failed to parse TMDB TV detail: {e}"))
}

// ---------- Season Detail ----------

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TmdbSeasonDetail {
    pub id: i64,
    pub name: String,
    pub overview: Option<String>,
    pub season_number: i64,
    pub episodes: Vec<TmdbEpisodeSummary>,
    pub credits: Option<TmdbCredits>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TmdbEpisodeSummary {
    pub id: i64,
    pub name: String,
    pub overview: Option<String>,
    pub episode_number: i64,
    pub air_date: Option<String>,
    pub runtime: Option<i64>,
    pub guest_stars: Vec<TmdbCastMember>,
    pub crew: Vec<TmdbCrewMember>,
}

pub async fn get_season_detail(
    client: &Client,
    token: &str,
    tv_id: i64,
    season_number: i64,
) -> Result<TmdbSeasonDetail, String> {
    let url = format!(
        "{BASE_URL}/tv/{tv_id}/season/{season_number}?append_to_response=credits"
    );

    let resp = client
        .get(&url)
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| format!("TMDB request failed: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("TMDB API error {status}: {body}"));
    }

    resp.json::<TmdbSeasonDetail>()
        .await
        .map_err(|e| format!("Failed to parse TMDB season detail: {e}"))
}

// ---------- Episode Detail ----------

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TmdbEpisodeDetail {
    pub id: i64,
    pub name: String,
    pub overview: Option<String>,
    pub episode_number: i64,
    pub air_date: Option<String>,
    pub runtime: Option<i64>,
    pub guest_stars: Vec<TmdbCastMember>,
    pub crew: Vec<TmdbCrewMember>,
    pub still_path: Option<String>,
}

pub async fn get_episode_detail(
    client: &Client,
    token: &str,
    tv_id: i64,
    season_number: i64,
    episode_number: i64,
) -> Result<TmdbEpisodeDetail, String> {
    let url = format!(
        "{BASE_URL}/tv/{tv_id}/season/{season_number}/episode/{episode_number}?append_to_response=credits"
    );

    let resp = client
        .get(&url)
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| format!("TMDB request failed: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("TMDB API error {status}: {body}"));
    }

    resp.json::<TmdbEpisodeDetail>()
        .await
        .map_err(|e| format!("Failed to parse TMDB episode detail: {e}"))
}

