import { useCallback, useEffect, useState } from "react";
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
import { Settings, Download } from "lucide-react";

const UPDATE_ENDPOINT =
  "https://github.com/trevorkerney/waverunner/releases/latest/download/latest.json";

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
      const endpoint = UPDATE_ENDPOINT;
      const result = await invoke<{ version: string; body?: string } | null>(
        "check_for_update",
        { endpoint }
      );
      if (result) {
        setUpdateVersion(result.version);
        setUpdateStatus("downloading");
        await invoke("download_and_install_update", { endpoint });
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
        </div>
      </DialogContent>
    </Dialog>
  );
}
