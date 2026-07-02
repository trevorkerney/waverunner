import { useEffect, useMemo, useState } from "react";
import {
  ChevronRight,
  Circle,
  Clapperboard,
  Drama,
  Film,
  Library,
  ListMusic,
  Music2,
  Tag,
  Tv,
  User,
  Users,
  type LucideIcon,
} from "lucide-react";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
} from "@/components/ui/context-menu";
import type { ComplicationNode, ViewSpec } from "@/types";
import { viewCacheKey } from "@/lib/complications";

const ICON_MAP: Record<string, LucideIcon> = {
  Clapperboard,
  Drama,
  Film,
  Library,
  ListMusic,
  Music2,
  Tag,
  Tv,
  User,
  Users,
};

function getIcon(name: string): LucideIcon {
  return ICON_MAP[name] ?? Circle;
}

// Compact count for the sidebar: 999 stays, 1500 -> "1.5K", 14600 -> "14.6K".
// Trailing ".0" is dropped (1000 -> "1K"). Millions get "M" for completeness.
function formatCount(n: number): string {
  if (n < 1000) return String(n);
  const unit = n < 1_000_000 ? "K" : "M";
  const scaled = n < 1_000_000 ? n / 1000 : n / 1_000_000;
  const rounded = Math.round(scaled * 10) / 10;
  return `${rounded % 1 === 0 ? rounded.toFixed(0) : rounded.toFixed(1)}${unit}`;
}

// Active-view matching shared by the node highlight and ancestor checks.
// Playlist sidebar entries stay highlighted while the user drills into nested
// playlist_collections — the node's view always targets the root
// (collectionId: null), so match on libraryId + playlistId instead of the key.
function viewsMatch(nodeView: ViewSpec | null | undefined, activeView: ViewSpec | null): boolean {
  if (!nodeView || !activeView) return false;
  if (
    nodeView.kind === "playlist-detail" &&
    activeView.kind === "playlist-detail" &&
    nodeView.libraryId === activeView.libraryId &&
    nodeView.playlistId === activeView.playlistId
  ) {
    return true;
  }
  return viewCacheKey(nodeView) === viewCacheKey(activeView);
}

function hasActiveDescendant(node: ComplicationNode, activeView: ViewSpec | null): boolean {
  return (node.children ?? []).some(
    (c) => viewsMatch(c.view, activeView) || hasActiveDescendant(c, activeView),
  );
}

interface SidebarTreeProps {
  nodes: ComplicationNode[];
  activeView: ViewSpec | null;
  onSelectView: (view: ViewSpec) => void;
  /** Return a <ContextMenuItem> subtree for the given node, or null for no menu. */
  renderNodeMenu?: (node: ComplicationNode) => React.ReactNode | null;
  depth?: number;
}

export function SidebarTree({ nodes, activeView, onSelectView, renderNodeMenu, depth = 0 }: SidebarTreeProps) {
  return (
    <ul className="flex flex-col">
      {nodes.map((node) => (
        <TreeNode
          key={node.id}
          node={node}
          activeView={activeView}
          onSelectView={onSelectView}
          renderNodeMenu={renderNodeMenu}
          depth={depth}
        />
      ))}
    </ul>
  );
}

interface TreeNodeProps {
  node: ComplicationNode;
  activeView: ViewSpec | null;
  onSelectView: (view: ViewSpec) => void;
  renderNodeMenu?: (node: ComplicationNode) => React.ReactNode | null;
  depth: number;
}

function TreeNode({ node, activeView, onSelectView, renderNodeMenu, depth }: TreeNodeProps) {
  const [expanded, setExpanded] = useState(!node.defaultCollapsed);
  const Icon = getIcon(node.iconName);
  const hasChildren = (node.children?.length ?? 0) > 0;
  const isActive = viewsMatch(node.view, activeView);
  // A highlighted descendant must stay visible: the group auto-expands when one
  // of its children becomes active, and its chevron locks until the user leaves.
  const activeInside = useMemo(() => hasActiveDescendant(node, activeView), [node, activeView]);
  useEffect(() => {
    if (activeInside) setExpanded(true);
  }, [activeInside]);

  const handleClick = () => {
    if (node.view) {
      // Navigate only — expand/collapse is exclusively the chevron's job.
      onSelectView(node.view);
    } else if (hasChildren && !activeInside) {
      // Non-navigable parent (no view): clicking the row is the only way to toggle.
      setExpanded((v) => !v);
    }
  };

  const toggleExpand = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (activeInside) return; // locked open while a child is highlighted
    setExpanded((v) => !v);
  };

  const nodeMenu = renderNodeMenu?.(node) ?? null;

  const buttonEl = (
    <button
      onClick={handleClick}
      onContextMenu={nodeMenu ? undefined : (e) => {
        // No per-node menu — block both the browser default and propagation to the
        // sidebar's outer "Create library" menu.
        e.preventDefault();
        e.stopPropagation();
      }}
      style={{ paddingLeft: 4 + depth * 12 }}
      className={`flex w-full items-start gap-1.5 py-1 pr-2 text-left text-sm transition-colors ${
        isActive
          ? "bg-sidebar-accent font-medium text-primary"
          : "text-sidebar-foreground/75 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
      }`}
    >
      {hasChildren ? (
        <span
          onClick={toggleExpand}
          className={`flex h-5 w-4 flex-shrink-0 items-center justify-center ${
            activeInside ? "cursor-default opacity-35" : "hover:text-sidebar-accent-foreground"
          }`}
        >
          <ChevronRight
            size={12}
            className={`transition-transform ${expanded ? "rotate-90" : ""}`}
          />
        </span>
      ) : (
        <span className="h-5 w-4 flex-shrink-0" />
      )}
      <span className="flex h-5 flex-shrink-0 items-center">
        <Icon size={14} />
      </span>
      <span className="min-w-0 flex-1 break-words">
        {node.label}
        {node.count != null && (
          <span className="text-sidebar-foreground/40"> ({formatCount(node.count)})</span>
        )}
      </span>
    </button>
  );

  return (
    <li>
      {nodeMenu ? (
        <ContextMenu>
          <ContextMenuTrigger render={buttonEl} />
          <ContextMenuContent>{nodeMenu}</ContextMenuContent>
        </ContextMenu>
      ) : (
        buttonEl
      )}
      {hasChildren && expanded && (
        <SidebarTree
          nodes={node.children!}
          activeView={activeView}
          onSelectView={onSelectView}
          renderNodeMenu={renderNodeMenu}
          depth={depth + 1}
        />
      )}
    </li>
  );
}
