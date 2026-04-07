import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { relaunch } from "@tauri-apps/plugin-process";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { Settings, Download } from "lucide-react";

const RECYCLE_STEPS = [0, 1, 2, 5, 10, 25, 50, 100, 250, -1];
const RECYCLE_DEFAULT_STEP = 6; // 50 GB

function recycleValueToStep(value: string | undefined): number {
  if (!value) return RECYCLE_DEFAULT_STEP;
  const num = parseInt(value, 10);
  const idx = RECYCLE_STEPS.indexOf(num);
  return idx >= 0 ? idx : RECYCLE_DEFAULT_STEP;
}

function recycleStepLabel(step: number): string {
  const val = RECYCLE_STEPS[step];
  if (val === 0) return "Always permanently delete";
  if (val === -1) return "Always send to Recycle Bin";
  return `Send to Recycle Bin if under ${val} GB, otherwise permanently delete`;
}

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type SettingsMap = Record<string, string>;

const categories = [
  { id: "general", label: "General", icon: Settings },
] as const;

export function SettingsDialog({ open, onOpenChange }: SettingsDialogProps) {
  const [activeCategory, setActiveCategory] = useState<string>("general");
  const [settings, setSettings] = useState<SettingsMap>({});
  const [appVersion, setAppVersion] = useState("");
  const [updateStatus, setUpdateStatus] = useState<
    "idle" | "checking" | "downloading" | "ready" | "none" | "error"
  >("idle");
  const [updateVersion, setUpdateVersion] = useState("");

  useEffect(() => {
    if (!open) return;
    invoke<SettingsMap>("get_settings").then(setSettings).catch(console.error);
    invoke<string>("get_app_version").then(setAppVersion).catch(console.error);
    setUpdateStatus("idle");
  }, [open]);

  const setSetting = useCallback(
    async (key: string, value: string) => {
      try {
        await invoke("set_setting", { key, value });
        setSettings((prev) => ({ ...prev, [key]: value }));
      } catch (e) {
        toast.error(String(e));
      }
    },
    []
  );

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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[576px] w-[1024px] gap-0 overflow-hidden p-0">
        {/* Sidebar */}
        <div className="flex w-44 shrink-0 flex-col border-r bg-muted/30 p-2">
          <p className="mb-2 px-2 pt-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Settings
          </p>
          {categories.map((cat) => (
            <button
              key={cat.id}
              onClick={() => setActiveCategory(cat.id)}
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
        <div className="flex-1 overflow-y-auto p-6">
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
                      checked={settings["auto_update"] !== "false"}
                      onCheckedChange={(checked) =>
                        setSetting("auto_update", checked ? "true" : "false")
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
                      value={settings["release_channel"] || "stable"}
                      onValueChange={(v) => setSetting("release_channel", v ?? "prerelease")}
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
              <div>
                <h3 className="mb-4 text-sm font-semibold">Deletion</h3>
                <div className="flex flex-col gap-3">
                  <div>
                    <p className="text-sm">Recycle Bin Threshold</p>
                    <p className="text-xs text-muted-foreground">
                      When deleting media from managed libraries, folders under this size are sent to the Recycle Bin instead of being permanently deleted.
                    </p>
                  </div>
                  <Slider
                    value={[recycleValueToStep(settings["recycle_bin_max_gb"])]}
                    onValueChange={(v) => {
                      const step = Array.isArray(v) ? v[0] : v;
                      setSetting("recycle_bin_max_gb", String(RECYCLE_STEPS[step]));
                    }}
                    min={0}
                    max={RECYCLE_STEPS.length - 1}
                    step={1}
                  />
                  <p className="text-xs text-muted-foreground">
                    {recycleStepLabel(recycleValueToStep(settings["recycle_bin_max_gb"]))}
                  </p>
                </div>
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
