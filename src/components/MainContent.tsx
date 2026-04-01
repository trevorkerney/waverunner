import { convertFileSrc } from "@tauri-apps/api/core";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import {
  Breadcrumb,
  BreadcrumbList,
  BreadcrumbItem as BreadcrumbUIItem,
  BreadcrumbLink,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Search, Folder } from "lucide-react";
import { Library, MediaEntry, BreadcrumbItem } from "@/types";

interface MainContentProps {
  entries: MediaEntry[];
  breadcrumbs: BreadcrumbItem[];
  coverSize: number;
  onCoverSizeChange: (size: number) => void;
  search: string;
  onSearchChange: (search: string) => void;
  onNavigate: (entry: MediaEntry) => void;
  onBreadcrumbClick: (index: number) => void;
  selectedLibrary: Library | null;
}

export function MainContent({
  entries,
  breadcrumbs,
  coverSize,
  onCoverSizeChange,
  search,
  onSearchChange,
  onNavigate,
  onBreadcrumbClick,
  selectedLibrary,
}: MainContentProps) {
  const filteredEntries = search
    ? entries.filter((e) =>
        e.title.toLowerCase().includes(search.toLowerCase())
      )
    : entries;

  return (
    <main className="flex flex-1 flex-col overflow-hidden bg-background">
      {selectedLibrary && (
        <>
          {/* Breadcrumbs */}
          <Breadcrumb className="border-b border-border px-4 py-2">
            <BreadcrumbList>
              {breadcrumbs.map((crumb, i) => (
                <BreadcrumbUIItem key={i}>
                  {i > 0 && <BreadcrumbSeparator />}
                  {i === breadcrumbs.length - 1 ? (
                    <BreadcrumbPage>{crumb.title}</BreadcrumbPage>
                  ) : (
                    <BreadcrumbLink
                      render={<button onClick={() => onBreadcrumbClick(i)} />}
                    >
                      {crumb.title}
                    </BreadcrumbLink>
                  )}
                </BreadcrumbUIItem>
              ))}
            </BreadcrumbList>
          </Breadcrumb>

          {/* Search + Size Slider */}
          <div className="flex items-center gap-4 border-b border-border px-4 py-2">
            <div className="relative flex-1">
              <Search
                size={14}
                className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                value={search}
                onChange={(e) => onSearchChange(e.target.value)}
                placeholder="Search..."
                className="h-8 pl-8 text-sm"
              />
            </div>
            <div className="flex w-32 items-center gap-2">
              <Slider
                value={[coverSize]}
                onValueChange={(v) => onCoverSizeChange(Array.isArray(v) ? v[0] : v)}
                min={100}
                max={400}
                step={10}
                className="w-full"
              />
            </div>
          </div>
        </>
      )}

      {/* Content Grid */}
      <div className="flex-1 overflow-y-auto p-4">
        {!selectedLibrary ? (
          <div />
        ) : filteredEntries.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {search ? "No results" : "Empty"}
          </p>
        ) : (
          <div
            className="grid gap-4"
            style={{
              gridTemplateColumns: `repeat(auto-fill, minmax(${coverSize}px, 1fr))`,
            }}
          >
            {filteredEntries.map((entry) => (
              <CoverCard
                key={entry.id}
                entry={entry}
                size={coverSize}
                onNavigate={onNavigate}
              />
            ))}
          </div>
        )}
      </div>
    </main>
  );
}

function CoverCard({
  entry,
  size,
  onNavigate,
}: {
  entry: MediaEntry;
  size: number;
  onNavigate: (entry: MediaEntry) => void;
}) {
  const coverPath = entry.covers[0];
  const coverSrc = coverPath ? convertFileSrc(coverPath) : null;

  return (
    <button
      onClick={() => {
        if (entry.is_collection) {
          onNavigate(entry);
        }
      }}
      className="group flex flex-col items-center gap-2 rounded-md p-2 text-left hover:bg-accent"
    >
      <div
        className="relative flex items-center justify-center overflow-hidden rounded-md bg-muted"
        style={{ width: size, height: size * 1.5 }}
      >
        {coverSrc ? (
          <img
            src={coverSrc}
            alt={entry.title}
            className="h-full w-full object-cover"
          />
        ) : (
          <Folder
            size={size * 0.3}
            className="text-muted-foreground/30"
          />
        )}
        {entry.is_collection && (
          <div className="absolute bottom-1 right-1 rounded-sm bg-black/60 px-1.5 py-0.5 text-xs text-white">
            Collection
          </div>
        )}
      </div>
      <div className="w-full" style={{ maxWidth: size }}>
        <p className="text-sm font-medium">{entry.title}</p>
        {entry.year && (
          <p className="text-xs text-muted-foreground">{entry.year}</p>
        )}
      </div>
    </button>
  );
}
