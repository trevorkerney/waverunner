import { createContext, useContext, type ReactNode } from "react";
import type { Library } from "@/types";

const LibraryContext = createContext<Library | null | undefined>(undefined);

export function LibraryProvider({
  value,
  children,
}: {
  value: Library | null;
  children: ReactNode;
}) {
  return <LibraryContext.Provider value={value}>{children}</LibraryContext.Provider>;
}

export function useSelectedLibrary(): Library | null {
  const ctx = useContext(LibraryContext);
  if (ctx === undefined) throw new Error("useSelectedLibrary must be used inside <LibraryProvider>");
  return ctx;
}
