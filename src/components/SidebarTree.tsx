import { useState } from "react";
import {
  ChevronRight,
  Circle,
  Clapperboard,
  Film,
  Library,
  ListMusic,
  Music2,
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
  Film,
  Library,
  ListMusic,
  Music2,
  Tv,
  User,
  Users,
};

function getIcon(name: string): LucideIcon {
  return ICON_MAP[name] ?? Circle;
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
  const [expanded, setExpanded] = useState(true);
  const Icon = getIcon(node.iconName);
  const hasChildren = (node.children?.length ?? 0) > 0;
  // Playlist sidebar entries stay highlighted while the user drills into nested
  // playlist_collections — the node's view always targets the root (collectionId: null),
  // so match on libraryId + playlistId instead of the exact cache key.
  const isActive = (() => {
    if (!node.view || !activeView) return false;
    if (
      node.view.kind === "playlist-detail" &&
      activeView.kind === "playlist-detail" &&
      node.view.libraryId === activeView.libraryId &&
      node.view.playlistId === activeView.playlistId
    ) {
      return true;
    }
    return viewCacheKey(node.view) === viewCacheKey(activeView);
  })();

  const handleClick = () => {
    if (node.view) {
      onSelectView(node.view);
      if (hasChildren) setExpanded(true);
    } else if (hasChildren) {
      setExpanded((v) => !v);
    }
  };

  const toggleExpand = (e: React.MouseEvent) => {
    e.stopPropagation();
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
      className={`flex w-full items-start gap-1.5 rounded-sm py-1 pr-2 text-left text-sm ${
        isActive
          ? "bg-sidebar-accent text-sidebar-accent-foreground"
          : "text-sidebar-foreground hover:bg-sidebar-accent/50"
      }`}
    >
      {hasChildren ? (
        <span
          onClick={toggleExpand}
          className="flex h-5 w-4 flex-shrink-0 items-center justify-center hover:text-sidebar-accent-foreground"
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
      <span className="min-w-0 flex-1 break-words">{node.label}</span>
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
