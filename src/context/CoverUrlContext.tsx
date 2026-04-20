import { createContext, useContext, type ReactNode } from "react";

export type CoverUrlValue = {
  getCoverUrl: (filePath: string) => string;
  getFullCoverUrl: (filePath: string) => string;
};

const CoverUrlContext = createContext<CoverUrlValue | null>(null);

export function CoverUrlProvider({
  value,
  children,
}: {
  value: CoverUrlValue;
  children: ReactNode;
}) {
  return <CoverUrlContext.Provider value={value}>{children}</CoverUrlContext.Provider>;
}

export function useCoverUrl(): CoverUrlValue {
  const ctx = useContext(CoverUrlContext);
  if (!ctx) throw new Error("useCoverUrl must be used inside <CoverUrlProvider>");
  return ctx;
}
