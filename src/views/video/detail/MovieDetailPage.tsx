import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import {
  Image as ImageIcon,
  Trash2,
  Pencil,
  Play,
  Film,
} from "lucide-react";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
} from "@/components/ui/context-menu";
import { Button } from "@/components/ui/button";
import { TmdbMatchDialog } from "@/components/TmdbMatchDialog";
import { TmdbImageBrowserDialog } from "@/components/TmdbImageBrowserDialog";
import { useCoverUrl } from "@/context/CoverUrlContext";
import { useSelectedLibrary } from "@/context/LibraryContext";
import { getDisplayCover } from "@/components/cards/SortableCoverCard";
import { EditField } from "@/views/video/detail/parts/EditField";
import { PersonPickerList } from "@/views/video/detail/parts/PersonPickerList";
import type { MediaEntry, MovieDetail, MovieDetailUpdate } from "@/types";

function formatReleaseDate(date: string | null | undefined): string | null {
  if (!date) return null;
  if (/^\d{4}$/.test(date)) return date;
  if (/^\d{4}-\d{2}$/.test(date)) {
    const [y, m] = date.split("-");
    return new Date(+y, +m - 1).toLocaleString("en-US", { month: "long", year: "numeric" });
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    const [y, m, d] = date.split("-");
    return new Date(+y, +m - 1, +d).toLocaleString("en-US", {
      month: "long",
      day: "numeric",
      year: "numeric",
    });
  }
  return date;
}

export function MovieDetailPage({
  entry,
  onEntryChanged,
  onTitleChanged,
  onChangeCover,
  onAddCover,
  onDeleteCover,
  onPlayFile,
}: {
  entry: MediaEntry;
  onEntryChanged: () => void;
  onTitleChanged: (entryId: number, newTitle: string) => void;
  onChangeCover: () => void;
  onAddCover: () => void;
  onDeleteCover: () => void;
  onPlayFile?: (path: string, title: string) => void;
}) {
  const { getFullCoverUrl } = useCoverUrl();
  const selectedLibrary = useSelectedLibrary();
  const [detail, setDetail] = useState<MovieDetail | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<MovieDetailUpdate>({});
  const [saving, setSaving] = useState(false);
  const [tmdbDialogOpen, setTmdbDialogOpen] = useState(false);
  const [tmdbImagesOpen, setTmdbImagesOpen] = useState(false);

  const loadDetail = useCallback(async () => {
    try {
      const d = await invoke<MovieDetail>("get_movie_detail", {
        entryId: entry.id,
      });
      setDetail(d);
    } catch (e) {
      console.error("Failed to load movie detail:", e);
    }
  }, [entry.id]);

  useEffect(() => {
    loadDetail();
  }, [loadDetail]);

  if (!selectedLibrary) return null;

  const startEditing = () => {
    setDraft({
      title: entry.title,
      release_date: detail?.release_date ?? entry.year ?? "",
      tmdb_id: detail?.tmdb_id ?? null,
      imdb_id: detail?.imdb_id ?? null,
      rotten_tomatoes_id: detail?.rotten_tomatoes_id ?? null,
      plot: detail?.plot ?? null,
      tagline: detail?.tagline ?? null,
      runtime: detail?.runtime ?? null,
      maturity_rating: detail?.maturity_rating ?? null,
      genres: detail?.genres ?? [],
      // Directors/composers: the backend now accepts PersonUpdateInfo (not plain
       // strings) so tmdb_id and an explicit person_id hint can round-trip. We carry
       // the existing DB id as `person_id` so editing this form doesn't orphan the
       // person record via name-rewrite.
      directors:
        detail?.directors.map((d: { id: number; name: string }) => ({
          person_id: d.id,
          name: d.name,
          tmdb_id: null,
          profile_path: null,
        })) ?? [],
      cast:
        detail?.cast.map((c: { id: number; name: string; role: string | null }) => ({
          person_id: c.id,
          name: c.name,
          role: c.role,
          tmdb_id: null,
          profile_path: null,
        })) ?? [],
      composers:
        detail?.composers.map((p: { id: number; name: string }) => ({
          person_id: p.id,
          name: p.name,
          tmdb_id: null,
          profile_path: null,
        })) ?? [],
      studios: detail?.studios ?? [],
      keywords: detail?.keywords ?? [],
    });
    setEditing(true);
  };

  const saveDetail = async () => {
    setSaving(true);
    try {
      await invoke("update_movie_detail", {
        entryId: entry.id,
        detail: draft,
      });
      await loadDetail();
      if (draft.title && draft.title !== entry.title) {
        onTitleChanged(entry.id, draft.title);
      }
      onEntryChanged();
      setEditing(false);
    } catch (e) {
      console.error("Failed to save movie detail:", e);
      toast.error(String(e));
    } finally {
      setSaving(false);
    }
  };

  const coverPath = getDisplayCover(entry);
  const coverSrc = coverPath ? getFullCoverUrl(coverPath) : null;

  const updateDraft = (field: keyof MovieDetailUpdate, value: unknown) => {
    setDraft((prev: MovieDetailUpdate) => ({ ...prev, [field]: value }));
  };

  const updateListField = (field: keyof MovieDetailUpdate, value: string) => {
    updateDraft(field, value.split(",").map((s) => s.trim()).filter(Boolean));
  };

  return (
    <div className="flex gap-8 p-4">
      {coverSrc && (
        <ContextMenu>
          <ContextMenuTrigger
            render={
              <img
                src={coverSrc}
                alt={entry.title}
                className="h-auto max-h-[500px] w-auto shrink-0 rounded-lg object-contain shadow-lg"
              />
            }
          />
          <ContextMenuContent>
            <ContextMenuItem onClick={onAddCover}>
              <ImageIcon size={14} />
              Add local cover
            </ContextMenuItem>
            <ContextMenuItem onClick={() => setTmdbImagesOpen(true)} disabled={!detail?.tmdb_id}>
              <ImageIcon size={14} />
              Add cover from TMDB
            </ContextMenuItem>
            <ContextMenuItem onClick={onChangeCover} disabled={entry.covers.length <= 1}>
              <ImageIcon size={14} />
              Change cover
            </ContextMenuItem>
            <ContextMenuItem onClick={onDeleteCover} disabled={entry.covers.length < 1}>
              <Trash2 size={14} />
              Delete cover
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      )}
      <ContextMenu>
        <ContextMenuTrigger render={<div className="flex min-w-0 flex-1 flex-col gap-4" />}>
          <div className="flex items-start justify-between gap-4">
            <div>
              {editing ? (
                <div className="flex flex-col gap-2">
                  <input
                    value={draft.title ?? ""}
                    onChange={(e) => updateDraft("title", e.target.value)}
                    className="rounded border border-input bg-transparent px-2 py-1 text-2xl font-bold outline-none"
                  />
                  <input
                    value={draft.release_date ?? ""}
                    onChange={(e) => updateDraft("release_date", e.target.value)}
                    placeholder="YYYY, YYYY-MM, or YYYY-MM-DD"
                    className="w-36 rounded border border-input bg-transparent px-2 py-1 text-sm outline-none"
                  />
                </div>
              ) : (
                <>
                  <h1 className="text-3xl font-bold">{entry.title}</h1>
                  {(() => {
                    const dateDisplay =
                      formatReleaseDate(detail?.release_date) ??
                      (entry.year && `${entry.year}${entry.end_year ? `–${entry.end_year}` : ""}`);
                    return (
                      dateDisplay && (
                        <p className="text-lg text-muted-foreground">{dateDisplay}</p>
                      )
                    );
                  })()}
                </>
              )}
            </div>
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={async () => {
                  try {
                    const path = await invoke<string>("get_movie_file_path", {
                      libraryId: selectedLibrary.id,
                      entryId: entry.id,
                    });
                    onPlayFile?.(path, entry.title);
                  } catch (e) {
                    toast.error(String(e));
                  }
                }}
              >
                <Play size={14} />
                Play
              </Button>
              {editing && (
                <>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setEditing(false)}
                    disabled={saving}
                  >
                    Cancel
                  </Button>
                  <Button size="sm" onClick={saveDetail} disabled={saving}>
                    {saving ? "Saving..." : "Save"}
                  </Button>
                </>
              )}
            </div>
          </div>

          {detail && !editing && (
            <div className="flex flex-col gap-3 text-sm">
              {detail.tagline && <p className="italic text-muted-foreground">{detail.tagline}</p>}
              {detail.plot && <p>{detail.plot}</p>}
              {detail.runtime != null && (
                <p>
                  <span className="font-medium">Runtime:</span> {detail.runtime} min
                </p>
              )}
              {detail.maturity_rating && (
                <p>
                  <span className="font-medium">Rating:</span> {detail.maturity_rating}
                </p>
              )}
              {detail.genres.length > 0 && (
                <p>
                  <span className="font-medium">Genres:</span> {detail.genres.join(", ")}
                </p>
              )}
              {detail.directors.length > 0 && (
                <p>
                  <span className="font-medium">Director:</span>{" "}
                  {detail.directors.map((d: { name: string }) => d.name).join(", ")}
                </p>
              )}
              {detail.cast.length > 0 && (
                <p>
                  <span className="font-medium">Cast:</span>{" "}
                  {detail.cast
                    .map((c: { name: string; role: string | null }) =>
                      c.role ? `${c.name} (${c.role})` : c.name,
                    )
                    .join(", ")}
                </p>
              )}
              {detail.composers.length > 0 && (
                <p>
                  <span className="font-medium">Composers:</span>{" "}
                  {detail.composers.map((p: { name: string }) => p.name).join(", ")}
                </p>
              )}
              {detail.studios.length > 0 && (
                <p>
                  <span className="font-medium">Studios:</span> {detail.studios.join(", ")}
                </p>
              )}
              {detail.keywords.length > 0 && (
                <p>
                  <span className="font-medium">Keywords:</span> {detail.keywords.join(", ")}
                </p>
              )}
              {detail.tmdb_id && (
                <p>
                  <span className="font-medium">TMDB:</span> {detail.tmdb_id}
                </p>
              )}
              {detail.imdb_id && (
                <p>
                  <span className="font-medium">IMDB:</span> {detail.imdb_id}
                </p>
              )}
              {detail.rotten_tomatoes_id && (
                <p>
                  <span className="font-medium">Rotten Tomatoes:</span> {detail.rotten_tomatoes_id}
                </p>
              )}
            </div>
          )}

          {editing && (
            <div className="flex flex-col gap-3 text-sm">
              <EditField
                label="Tagline"
                value={draft.tagline ?? ""}
                onChange={(v) => updateDraft("tagline", v || null)}
              />
              <EditField
                label="Plot"
                value={draft.plot ?? ""}
                onChange={(v) => updateDraft("plot", v || null)}
                multiline
              />
              <EditField
                label="Runtime (min)"
                value={draft.runtime != null ? String(draft.runtime) : ""}
                onChange={(v) => updateDraft("runtime", v ? Number(v) : null)}
              />
              <EditField
                label="Maturity Rating"
                value={draft.maturity_rating ?? ""}
                onChange={(v) => updateDraft("maturity_rating", v || null)}
              />
              <EditField
                label="Genres (comma-separated)"
                value={(draft.genres ?? []).join(", ")}
                onChange={(v) => updateListField("genres", v)}
              />
              <PersonPickerList
                label="Directors"
                items={draft.directors ?? []}
                onChange={(items) => updateDraft("directors", items)}
              />
              <PersonPickerList
                label="Composers"
                items={draft.composers ?? []}
                onChange={(items) => updateDraft("composers", items)}
              />
              <EditField
                label="Studios (comma-separated)"
                value={(draft.studios ?? []).join(", ")}
                onChange={(v) => updateListField("studios", v)}
              />
              <EditField
                label="Keywords (comma-separated)"
                value={(draft.keywords ?? []).join(", ")}
                onChange={(v) => updateListField("keywords", v)}
              />
              <EditField
                label="TMDB ID"
                value={draft.tmdb_id ?? ""}
                onChange={(v) => updateDraft("tmdb_id", v || null)}
              />
              <EditField
                label="IMDB ID"
                value={draft.imdb_id ?? ""}
                onChange={(v) => updateDraft("imdb_id", v || null)}
              />
              <EditField
                label="Rotten Tomatoes ID"
                value={draft.rotten_tomatoes_id ?? ""}
                onChange={(v) => updateDraft("rotten_tomatoes_id", v || null)}
              />
              <PersonPickerList
                label="Cast"
                items={draft.cast ?? []}
                onChange={(items) => updateDraft("cast", items)}
                secondaryField="role"
                secondaryLabel="Character"
              />
            </div>
          )}
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onClick={() => setTmdbDialogOpen(true)}>
            <Film size={14} />
            {detail?.tmdb_id ? "Rematch TMDB" : "Match TMDB"}
          </ContextMenuItem>
          <ContextMenuItem onClick={startEditing}>
            <Pencil size={14} />
            Edit
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      <TmdbMatchDialog
        open={tmdbDialogOpen}
        onOpenChange={setTmdbDialogOpen}
        entryId={entry.id}
        entryTitle={entry.title}
        entryYear={entry.year}
        currentDetail={detail}
        onApplied={() => {
          loadDetail();
          onEntryChanged();
        }}
      />
      {detail?.tmdb_id && (
        <TmdbImageBrowserDialog
          open={tmdbImagesOpen}
          onOpenChange={setTmdbImagesOpen}
          libraryId={selectedLibrary.id}
          entryId={entry.id}
          tmdbId={detail.tmdb_id}
          onDownloaded={() => {
            loadDetail();
            onEntryChanged();
          }}
        />
      )}
    </div>
  );
}
