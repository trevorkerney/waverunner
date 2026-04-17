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
  depth?: number;
}

export function SidebarTree({ nodes, activeView, onSelectView, depth = 0 }: SidebarTreeProps) {
  return (
    <ul className="flex flex-col">
      {nodes.map((node) => (
        <TreeNode
          key={node.id}
          node={node}
          activeView={activeView}
          onSelectView={onSelectView}
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
  depth: number;
}

function TreeNode({ node, activeView, onSelectView, depth }: TreeNodeProps) {
  const [expanded, setExpanded] = useState(true);
  const Icon = getIcon(node.iconName);
  const hasChildren = (node.children?.length ?? 0) > 0;
  const isActive =
    !!node.view && !!activeView && viewCacheKey(node.view) === viewCacheKey(activeView);

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

  return (
    <li>
      <button
        onClick={handleClick}
        style={{ paddingLeft: 4 + depth * 12 }}
        className={`flex w-full items-center gap-1.5 rounded-sm py-1 pr-2 text-left text-sm ${
          isActive
            ? "bg-sidebar-accent text-sidebar-accent-foreground"
            : "text-sidebar-foreground hover:bg-sidebar-accent/50"
        }`}
      >
        {hasChildren ? (
          <span
            onClick={toggleExpand}
            className="flex h-4 w-4 items-center justify-center hover:text-sidebar-accent-foreground"
          >
            <ChevronRight
              size={12}
              className={`transition-transform ${expanded ? "rotate-90" : ""}`}
            />
          </span>
        ) : (
          <span className="h-4 w-4" />
        )}
        <Icon size={14} className="flex-shrink-0" />
        <span className="truncate">{node.label}</span>
      </button>
      {hasChildren && expanded && (
        <SidebarTree
          nodes={node.children!}
          activeView={activeView}
          onSelectView={onSelectView}
          depth={depth + 1}
        />
      )}
    </li>
  );
}
