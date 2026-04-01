import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Minus, Square, X, ZoomIn, ZoomOut, RotateCcw } from "lucide-react";
import { ThemeToggle } from "@/components/ThemeToggle";
import {
  Menubar,
  MenubarMenu,
  MenubarTrigger,
  MenubarContent,
  MenubarItem,
} from "@/components/ui/menubar";

const appWindow = getCurrentWindow();
const MIN_ZOOM = 0.8;
const MAX_ZOOM = 1.5;
const ZOOM_STEP = 0.1;

export function Titlebar() {
  const [zoom, setZoom] = useState(() => {
    const stored = localStorage.getItem("app-zoom");
    return stored ? parseFloat(stored) : 1;
  });
  const zoomRef = useRef(zoom);

  async function applyZoom(factor: number) {
    const clamped = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round(factor * 100) / 100));
    try {
      const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
      await getCurrentWebviewWindow().setZoom(clamped);
      zoomRef.current = clamped;
      setZoom(clamped);
      localStorage.setItem("app-zoom", String(clamped));
    } catch {}
  }

  useEffect(() => {
    applyZoom(zoom);

    function handleWheel(e: WheelEvent) {
      if (!e.ctrlKey) return;
      e.preventDefault();
      applyZoom(zoomRef.current + (e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP));
    }

    function handleKeyDown(e: KeyboardEvent) {
      if (!e.ctrlKey) return;
      if (e.key === "=" || e.key === "+") {
        e.preventDefault();
        applyZoom(zoomRef.current + ZOOM_STEP);
      } else if (e.key === "-") {
        e.preventDefault();
        applyZoom(zoomRef.current - ZOOM_STEP);
      } else if (e.key === "0") {
        e.preventDefault();
        applyZoom(1);
      }
    }

    window.addEventListener("wheel", handleWheel, { passive: false });
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("wheel", handleWheel);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  const btnClass = "inline-flex h-6 w-10 items-center justify-center text-muted-foreground hover:bg-accent";

  return (
    <div
      data-tauri-drag-region
      className="flex h-6 select-none items-center bg-background"
    >
      <img src="/logo256.png" alt="Waverunner" className="ml-2 h-4 w-4" draggable={false} />
      <Menubar className="border-none rounded-none h-6 px-1 ml-1">
        <MenubarMenu>
          <MenubarTrigger className="text-xs px-2 py-0">File</MenubarTrigger>
          <MenubarContent>
            <MenubarItem disabled>Coming soon</MenubarItem>
          </MenubarContent>
        </MenubarMenu>
        <MenubarMenu>
          <MenubarTrigger className="text-xs px-2 py-0">Edit</MenubarTrigger>
          <MenubarContent>
            <MenubarItem disabled>Coming soon</MenubarItem>
          </MenubarContent>
        </MenubarMenu>
        <MenubarMenu>
          <MenubarTrigger className="text-xs px-2 py-0">View</MenubarTrigger>
          <MenubarContent>
            <MenubarItem disabled>Coming soon</MenubarItem>
          </MenubarContent>
        </MenubarMenu>
      </Menubar>
      <div className="flex-1" data-tauri-drag-region />
      <ThemeToggle />
      <div className="ml-4 flex items-center opacity-50 transition-opacity hover:opacity-100">
        <button onClick={() => applyZoom(zoom - ZOOM_STEP)} disabled={zoom <= MIN_ZOOM} className={`${btnClass} disabled:opacity-30`} title="Zoom Out">
          <ZoomOut size={12} strokeWidth={1.5} />
        </button>
        <button onClick={() => applyZoom(1)} className={btnClass} title={`Reset Zoom (${Math.round(zoom * 100)}%)`}>
          <RotateCcw size={10} strokeWidth={1.5} />
        </button>
        <button onClick={() => applyZoom(zoom + ZOOM_STEP)} disabled={zoom >= MAX_ZOOM} className={`${btnClass} disabled:opacity-30`} title="Zoom In">
          <ZoomIn size={12} strokeWidth={1.5} />
        </button>
      </div>
      <div className="ml-4 flex">
      <button onClick={() => appWindow.minimize()} className={btnClass}>
        <Minus size={12} strokeWidth={1.5} />
      </button>
      <button onClick={() => appWindow.toggleMaximize()} className={btnClass}>
        <Square size={10} strokeWidth={1.5} />
      </button>
      <button onClick={() => appWindow.close()} className="inline-flex h-6 w-10 items-center justify-center text-muted-foreground hover:bg-red-500 hover:text-white">
        <X size={12} strokeWidth={1.5} />
      </button>
      </div>
    </div>
  );
}
