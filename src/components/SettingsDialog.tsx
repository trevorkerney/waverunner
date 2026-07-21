import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { relaunch } from "@tauri-apps/plugin-process";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { Settings, Download, Eye, EyeOff, MonitorPlay, Keyboard, Globe, Volume2 } from "lucide-react";
import {
  SUBTITLE_DEFAULTS,
  applySubtitleStyleToPlayer,
  subtitleSetting,
  type SubtitleSettingKey,
} from "@/lib/subtitleStyle";
import {
  KEYBINDS_SETTING,
  PLAYER_ACTIONS,
  boundKey,
  displayKey,
  normalizeKey,
  parseKeybindOverrides,
  setRuntimeKeybinds,
  type PlayerActionId,
} from "@/lib/playerKeybinds";

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type SettingsMap = Record<string, string>;

const categories = [
  { id: "general", label: "General", icon: Settings },
  { id: "tmdb", label: "TMDB/OMDB", icon: Globe },
  { id: "player", label: "Video Player", icon: MonitorPlay },
  { id: "audio", label: "Audio Player", icon: Volume2 },
  { id: "keybinds", label: "Keybinds", icon: Keyboard },
] as const;

export function SettingsDialog({ open, onOpenChange }: SettingsDialogProps) {
  const [activeCategory, setActiveCategory] = useState<string>("general");
  const [settings, setSettings] = useState<SettingsMap>({});
  const [appVersion, setAppVersion] = useState("");
  const [updateStatus, setUpdateStatus] = useState<
    "idle" | "checking" | "downloading" | "ready" | "none" | "error"
  >("idle");
  const [updateVersion, setUpdateVersion] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [showOmdbKey, setShowOmdbKey] = useState(false);

  // Staged-but-unsaved changes. Values only reach the settings table when the
  // user clicks Save; Cancel (or closing the dialog any other way) discards.
  const [draft, setDraft] = useState<SettingsMap>({});
  // Keybind row currently listening for its new key (Settings → Keybinds).
  const [capturing, setCapturing] = useState<PlayerActionId | null>(null);
  // What the controls display: saved settings with staged changes overlaid.
  const view: SettingsMap = { ...settings, ...draft };
  const dirty = Object.entries(draft).some(([k, v]) => (settings[k] ?? "") !== v);

  useEffect(() => {
    if (!open) return;
    invoke<SettingsMap>("get_settings").then(setSettings).catch(console.error);
    invoke<string>("get_app_version").then(setAppVersion).catch(console.error);
    setUpdateStatus("idle");
    setDraft({});
    setCapturing(null);
  }, [open]);

  const stageSetting = useCallback((key: string, value: string) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }, []);

  const saveAll = useCallback(async () => {
    try {
      const changed = Object.entries(draft).filter(([k, v]) => (settings[k] ?? "") !== v);
      await Promise.all(changed.map(([key, value]) => invoke("set_setting", { key, value })));
      // The keydown handler reads binds from a module-level copy — refresh it.
      if (KEYBINDS_SETTING in draft) setRuntimeKeybinds(draft[KEYBINDS_SETTING]);
      setSettings((prev) => ({ ...prev, ...draft }));
      setDraft({});
      onOpenChange(false);
      if (changed.length > 0) toast.success("Settings saved");
    } catch (e) {
      toast.error(String(e));
    }
  }, [draft, settings, onOpenChange]);

  // Discard staged changes; if subtitle styling was being live-previewed on a
  // player, put the saved values back.
  const discard = useCallback(() => {
    if (Object.keys(draft).some((k) => k.startsWith("sub_"))) {
      void applySubtitleStyleToPlayer(settings);
    }
    setDraft({});
  }, [draft, settings]);

  const checkForUpdates = useCallback(async () => {
    setUpdateStatus("checking");
    try {
      const result = await invoke<{ version: string; body?: string } | null>(
        "check_for_update"
      );
      if (result) {
        setUpdateVersion(result.version);
        setUpdateStatus("downloading");
        await invoke("download_and_install_update");
        setUpdateStatus("ready");
      } else {
        setUpdateStatus("none");
      }
    } catch (e) {
      console.error("Update check failed:", e);
      setUpdateStatus("error");
    }
  }, []);

  // Default playback volumes (0–100), defaulting to 50 when unset.
  const volumeSetting = (key: string) => {
    const raw = view[key];
    const n = raw == null ? NaN : parseInt(raw, 10);
    return Number.isNaN(n) ? 50 : Math.max(0, Math.min(100, n));
  };
  const defaultVolume = volumeSetting("default_volume");
  const musicDefaultVolume = volumeSetting("music_default_volume");

  // Subtitle styling: stage + live-preview on an active player in one step
  // (applySubtitleStyleToPlayer ignores the rejection when no player is open).
  // Save makes the preview stick; Cancel reverts it.
  const setSubtitleSetting = useCallback(
    (key: SubtitleSettingKey, value: string) => {
      stageSetting(key, value);
      void applySubtitleStyleToPlayer({ ...settings, ...draft, [key]: value });
    },
    [stageSetting, settings, draft],
  );

  const resetSubtitleStyle = useCallback(() => {
    setDraft((prev) => ({ ...prev, ...SUBTITLE_DEFAULTS }));
    void applySubtitleStyleToPlayer({ ...settings, ...draft, ...SUBTITLE_DEFAULTS });
  }, [settings, draft]);

  const sub = (k: SubtitleSettingKey) => subtitleSetting(view, k);
  const subNum = (k: SubtitleSettingKey, fallback: number) => {
    const n = parseFloat(sub(k));
    return Number.isNaN(n) ? fallback : n;
  };

  // Staged keybind overrides + the capture flow: clicking a key button arms
  // `capturing`; the next plain keypress stages the rebind. Escape cancels,
  // and duplicates are rejected so two actions can never share a key.
  const keybindsRaw = view[KEYBINDS_SETTING];
  const keybinds = useMemo(() => parseKeybindOverrides(keybindsRaw), [keybindsRaw]);
  useEffect(() => {
    if (!capturing) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setCapturing(null);
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return; // plain keys only, no chords
      if (["Shift", "Control", "Alt", "Meta"].includes(e.key)) return;
      const taken = PLAYER_ACTIONS.find(
        (a) => a.id !== capturing && normalizeKey(boundKey(keybinds, a)) === normalizeKey(e.key),
      );
      if (taken) {
        toast.error(`"${displayKey(e.key)}" is already bound to ${taken.label}`);
        setCapturing(null);
        return;
      }
      stageSetting(KEYBINDS_SETTING, JSON.stringify({ ...keybinds, [capturing]: e.key }));
      setCapturing(null);
    };
    // Capture phase so this wins over the dialog's own Escape-to-close.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [capturing, keybinds, stageSetting]);

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) discard();
        onOpenChange(o);
      }}
    >
      {/* Rows: sidebar+content, then a full-width Save/Cancel footer. */}
      <DialogContent className="grid h-[576px] w-[1024px] grid-cols-[11rem_1fr] grid-rows-[minmax(0,1fr)_auto] gap-0 overflow-hidden p-0">
        {/* Sidebar */}
        <div className="flex w-44 shrink-0 flex-col border-r bg-muted/30 p-2">
          <p className="mb-2 px-2 pt-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Settings
          </p>
          {categories.map((cat) => (
            <button
              key={cat.id}
              onClick={() => {
                setActiveCategory(cat.id);
                setCapturing(null);
              }}
              className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm ${
                activeCategory === cat.id
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:bg-accent/50"
              }`}
            >
              <cat.icon size={14} />
              {cat.label}
            </button>
          ))}
          {appVersion && (
            <p className="mt-auto px-2 pb-1 text-xs text-muted-foreground">
              v{appVersion}
            </p>
          )}
        </div>

        {/* Content */}
        <div className="overflow-y-auto p-6">
          {activeCategory === "general" && (
            <div className="flex flex-col gap-6">
              <div>
                <h3 className="mb-4 text-sm font-semibold">Updates</h3>
                <div className="flex flex-col gap-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm">Auto-update</p>
                      <p className="text-xs text-muted-foreground">
                        Automatically check for updates on launch
                      </p>
                    </div>
                    <Switch
                      checked={view["auto_update"] !== "false"}
                      onCheckedChange={(checked) =>
                        stageSetting("auto_update", checked ? "true" : "false")
                      }
                    />
                  </div>
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm">Release channel</p>
                      <p className="text-xs text-muted-foreground">
                        Choose which releases to receive updates from
                      </p>
                    </div>
                    <Select
                      value={view["release_channel"] || "stable"}
                      onValueChange={(v) => stageSetting("release_channel", v ?? "prerelease")}
                    >
                      <SelectTrigger className="w-36">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="stable">stable</SelectItem>
                        <SelectItem value="prerelease">prerelease</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm">Check for updates</p>
                      <p className="text-xs text-muted-foreground">
                        {updateStatus === "checking" && "Checking..."}
                        {updateStatus === "downloading" &&
                          `Downloading v${updateVersion}...`}
                        {updateStatus === "ready" &&
                          `v${updateVersion} ready — restart to apply`}
                        {updateStatus === "none" && "You're on the latest version"}
                        {updateStatus === "error" && "Failed to check for updates"}
                        {updateStatus === "idle" && "Manually check for a new version"}
                      </p>
                    </div>
                    {updateStatus === "ready" ? (
                      <Button size="sm" onClick={() => relaunch()}>
                        Restart
                      </Button>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={checkForUpdates}
                        disabled={
                          updateStatus === "checking" ||
                          updateStatus === "downloading"
                        }
                      >
                        {updateStatus === "checking" || updateStatus === "downloading" ? (
                          <Spinner className="size-3.5" />
                        ) : (
                          <Download size={14} />
                        )}
                        Check
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}
          {activeCategory === "tmdb" && (
            <div className="flex flex-col gap-6">
              <div>
                <h3 className="mb-4 text-sm font-semibold">TMDB</h3>
                <div className="flex flex-col gap-4">
                  <div>
                    <p className="text-sm">API Read Access Token</p>
                    <p className="mb-2 text-xs text-muted-foreground">
                      Required for fetching movie metadata from TMDB. Get one
                      from your TMDB account settings.
                    </p>
                    <div className="flex gap-2">
                      <div className="relative flex-1">
                        <Input
                          type={showToken ? "text" : "password"}
                          value={view["tmdb_api_token"] || ""}
                          onChange={(e) =>
                            stageSetting("tmdb_api_token", e.target.value)
                          }
                          placeholder="Enter your TMDB API read access token"
                          className="pr-9"
                        />
                        <button
                          type="button"
                          onClick={() => setShowToken((v) => !v)}
                          className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                        >
                          {showToken ? <EyeOff size={14} /> : <Eye size={14} />}
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
              <div>
                <h3 className="mb-4 text-sm font-semibold">Ratings</h3>
                <div className="flex flex-col gap-4">
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <p className="text-sm">OMDB ratings</p>
                      <p className="text-xs text-muted-foreground">
                        IMDb, Metacritic, and RT critic scores. Free API keys at omdbapi.com.
                      </p>
                    </div>
                    <Switch
                      checked={view["omdb_enabled"] === "true"}
                      onCheckedChange={(v) => {
                        stageSetting("omdb_enabled", v ? "true" : "false");
                        // The RT scraper rides along with OMDB fetches; it can't be on alone.
                        if (!v) stageSetting("rt_scraper_enabled", "false");
                      }}
                    />
                  </div>
                  {view["omdb_enabled"] === "true" && (
                    <div className="relative">
                      <Input
                        type={showOmdbKey ? "text" : "password"}
                        value={view["omdb_api_key"] || ""}
                        onChange={(e) => stageSetting("omdb_api_key", e.target.value)}
                        placeholder="Enter your OMDB API key"
                        className="pr-9"
                      />
                      <button
                        type="button"
                        onClick={() => setShowOmdbKey((v) => !v)}
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                      >
                        {showOmdbKey ? <EyeOff size={14} /> : <Eye size={14} />}
                      </button>
                    </div>
                  )}
                  <div className="flex items-center justify-between gap-4">
                    <div className={view["omdb_enabled"] === "true" ? "" : "opacity-50"}>
                      <p className="text-sm">Rotten Tomatoes audience score</p>
                      <p className="text-xs text-muted-foreground">
                        Scraped from the RT website alongside OMDB fetches — no key needed.
                        May stop working if RT changes their site. Requires OMDB ratings.
                      </p>
                    </div>
                    <Switch
                      checked={view["rt_scraper_enabled"] === "true"}
                      disabled={view["omdb_enabled"] !== "true"}
                      onCheckedChange={(v) => stageSetting("rt_scraper_enabled", v ? "true" : "false")}
                    />
                  </div>
                </div>
              </div>
              <div>
                <h3 className="mb-4 text-sm font-semibold">Artwork</h3>
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <p className="text-sm">Save artwork to source folders</p>
                    <p className="text-xs text-muted-foreground">
                      When downloading covers and backdrops from TMDB, save them into the media
                      folder's covers/ and backdrops/ subfolders so they travel with your files.
                    </p>
                  </div>
                  <Switch
                    checked={view["save_artwork_to_source"] === "true"}
                    onCheckedChange={(v) => stageSetting("save_artwork_to_source", v ? "true" : "false")}
                  />
                </div>
              </div>
            </div>
          )}
          {activeCategory === "audio" && (
            <div className="flex flex-col gap-6">
              <div>
                <h3 className="mb-4 text-sm font-semibold">Playback</h3>
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <p className="text-sm">Default volume</p>
                    <p className="text-xs text-muted-foreground">
                      Volume music starts at. Adjustments in the now-playing bar last for the
                      session.
                    </p>
                  </div>
                  <div className="flex w-44 shrink-0 items-center gap-3">
                    <Slider
                      value={[musicDefaultVolume]}
                      onValueChange={(v) => stageSetting("music_default_volume", String(Array.isArray(v) ? v[0] : v))}
                      min={0}
                      max={100}
                      step={5}
                      className="flex-1"
                    />
                    <span className="w-9 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                      {musicDefaultVolume}%
                    </span>
                  </div>
                </div>
              </div>
              <div>
                <h3 className="mb-4 text-sm font-semibold">Metadata</h3>
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <p className="text-sm">Allow writing tags to files</p>
                    <p className="text-xs text-muted-foreground">
                      Metadata edits are stored in waverunner and never touch your audio files.
                      With this on, the track editor gains an explicit "also write these tags
                      into the file" option. Modifying files changes their timestamps (and
                      breaks torrent seeding for those files).
                    </p>
                  </div>
                  <Switch
                    checked={view["allow_tag_writeback"] === "true"}
                    onCheckedChange={(v) => stageSetting("allow_tag_writeback", v ? "true" : "false")}
                  />
                </div>
              </div>
            </div>
          )}
          {activeCategory === "player" && (
            <div className="flex flex-col gap-6">
              <div>
                <h3 className="mb-4 text-sm font-semibold">Playback</h3>
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <p className="text-sm">Default volume</p>
                    <p className="text-xs text-muted-foreground">
                      Volume new videos start at. Adjustments during playback carry across episodes.
                    </p>
                  </div>
                  <div className="flex w-44 shrink-0 items-center gap-3">
                    <Slider
                      value={[defaultVolume]}
                      onValueChange={(v) => stageSetting("default_volume", String(Array.isArray(v) ? v[0] : v))}
                      min={0}
                      max={100}
                      step={5}
                      className="flex-1"
                    />
                    <span className="w-9 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                      {defaultVolume}%
                    </span>
                  </div>
                </div>
              </div>
              <div>
                <div className="mb-4 flex items-center justify-between">
                  <div>
                    <h3 className="text-sm font-semibold">Subtitles</h3>
                    <p className="text-xs text-muted-foreground">
                      Changes apply live to a playing video.
                    </p>
                  </div>
                  <Button variant="outline" size="sm" onClick={resetSubtitleStyle}>
                    Reset to defaults
                  </Button>
                </div>
                <div className="flex flex-col gap-4">
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <p className="text-sm">Size</p>
                      <p className="text-xs text-muted-foreground">Subtitle text size.</p>
                    </div>
                    <div className="flex w-44 shrink-0 items-center gap-3">
                      <Slider
                        value={[subNum("sub_scale", 100)]}
                        onValueChange={(v) => setSubtitleSetting("sub_scale", String(Array.isArray(v) ? v[0] : v))}
                        min={50}
                        max={200}
                        step={5}
                        className="flex-1"
                      />
                      <span className="w-9 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                        {Math.round(subNum("sub_scale", 100))}%
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center justify-between gap-4">
                    <p className="text-sm">Bold</p>
                    <Switch
                      checked={sub("sub_bold") === "true"}
                      onCheckedChange={(v) => setSubtitleSetting("sub_bold", v ? "true" : "false")}
                    />
                  </div>
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <p className="text-sm">Font</p>
                      <p className="text-xs text-muted-foreground">
                        Font family name, e.g. Arial. Leave empty for the player default.
                      </p>
                    </div>
                    <Input
                      value={view["sub_font"] ?? ""}
                      onChange={(e) => setSubtitleSetting("sub_font", e.target.value)}
                      placeholder="Player default"
                      className="w-44 shrink-0"
                    />
                  </div>
                  <div className="flex items-center justify-between gap-4">
                    <p className="text-sm">Text color</p>
                    <input
                      type="color"
                      value={sub("sub_color")}
                      onChange={(e) => setSubtitleSetting("sub_color", e.target.value)}
                      className="h-8 w-14 shrink-0 cursor-pointer rounded-md border border-input bg-background p-1"
                    />
                  </div>
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <p className="text-sm">Outline</p>
                      <p className="text-xs text-muted-foreground">Thickness of the outline around text.</p>
                    </div>
                    <div className="flex w-44 shrink-0 items-center gap-3">
                      <Slider
                        value={[subNum("sub_border_size", 3)]}
                        onValueChange={(v) => setSubtitleSetting("sub_border_size", String(Array.isArray(v) ? v[0] : v))}
                        min={0}
                        max={8}
                        step={0.5}
                        className="flex-1"
                      />
                      <span className="w-9 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                        {subNum("sub_border_size", 3)}
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center justify-between gap-4">
                    <p className="text-sm">Outline color</p>
                    <input
                      type="color"
                      value={sub("sub_border_color")}
                      onChange={(e) => setSubtitleSetting("sub_border_color", e.target.value)}
                      className="h-8 w-14 shrink-0 cursor-pointer rounded-md border border-input bg-background p-1"
                    />
                  </div>
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <p className="text-sm">Background</p>
                      <p className="text-xs text-muted-foreground">
                        Opacity of a black box behind subtitles for readability.
                      </p>
                    </div>
                    <div className="flex w-44 shrink-0 items-center gap-3">
                      <Slider
                        value={[subNum("sub_back_opacity", 0)]}
                        onValueChange={(v) => setSubtitleSetting("sub_back_opacity", String(Array.isArray(v) ? v[0] : v))}
                        min={0}
                        max={100}
                        step={5}
                        className="flex-1"
                      />
                      <span className="w-9 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                        {Math.round(subNum("sub_back_opacity", 0))}%
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <p className="text-sm">Vertical position</p>
                      <p className="text-xs text-muted-foreground">
                        100 sits at the bottom edge; lower values lift subtitles up the screen.
                      </p>
                    </div>
                    <div className="flex w-44 shrink-0 items-center gap-3">
                      <Slider
                        value={[subNum("sub_pos", 100)]}
                        onValueChange={(v) => setSubtitleSetting("sub_pos", String(Array.isArray(v) ? v[0] : v))}
                        min={20}
                        max={100}
                        step={5}
                        className="flex-1"
                      />
                      <span className="w-9 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                        {Math.round(subNum("sub_pos", 100))}
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <p className="text-sm">Override styled subtitles</p>
                      <p className="text-xs text-muted-foreground">
                        Force these settings onto ASS/SSA subtitles that carry their own built-in styling.
                      </p>
                    </div>
                    <Switch
                      checked={sub("sub_ass_override") === "true"}
                      onCheckedChange={(v) => setSubtitleSetting("sub_ass_override", v ? "true" : "false")}
                    />
                  </div>
                </div>
              </div>
            </div>
          )}
          {activeCategory === "keybinds" && (
            <div className="flex flex-col gap-6">
              <div>
                <div className="mb-4 flex items-center justify-between">
                  <div>
                    <h3 className="text-sm font-semibold">Player keybinds</h3>
                    <p className="text-xs text-muted-foreground">
                      Click a key to rebind it, then press the new key. Esc cancels.
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setCapturing(null);
                      stageSetting(KEYBINDS_SETTING, "");
                    }}
                  >
                    Reset to defaults
                  </Button>
                </div>
                <div className="flex flex-col gap-1.5">
                  {PLAYER_ACTIONS.map((a) => (
                    <div
                      key={a.id}
                      className="flex items-center justify-between gap-4 rounded-md px-2 py-1.5 hover:bg-accent/30"
                    >
                      <p className="text-sm">{a.label}</p>
                      <Button
                        variant="outline"
                        size="sm"
                        className="min-w-24 font-mono text-xs"
                        onClick={() => setCapturing(capturing === a.id ? null : a.id)}
                      >
                        {capturing === a.id ? "Press a key…" : displayKey(boundKey(keybinds, a))}
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
        {/* Footer */}
        <div className="col-span-2 flex items-center gap-2 border-t px-4 py-3">
          {dirty && (
            <span className="text-xs text-muted-foreground">Unsaved changes</span>
          )}
          <div className="ml-auto flex gap-2">
            <Button
              variant="outline"
              onClick={() => {
                discard();
                onOpenChange(false);
              }}
            >
              Cancel
            </Button>
            <Button onClick={saveAll} disabled={!dirty}>
              Save
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
