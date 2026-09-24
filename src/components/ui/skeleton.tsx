import * as React from "react"
import { cn } from "@/lib/utils"

/** True only once `loading` has been true for `ms` (default 500). Fast loads
 *  show nothing at all — a skeleton that flashes for 80ms reads as a glitch,
 *  not as loading. */
function useSkeletonDelay(loading: boolean, ms = 500): boolean {
  const [show, setShow] = React.useState(false)
  React.useEffect(() => {
    if (!loading) {
      setShow(false)
      return
    }
    const t = window.setTimeout(() => setShow(true), ms)
    return () => window.clearTimeout(t)
  }, [loading, ms])
  return loading && show
}

/** A grey placeholder shaped like the content it stands in for. Dialogs open
 *  at once with skeletons where their slow content will land, then swap the
 *  real content in (DialogTransition) — never a spinner in a body, and never
 *  a dialog that waits to appear. Spinners are for "the button I clicked is
 *  working". */
function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn("animate-pulse rounded-md bg-muted", className)}
      {...props}
    />
  )
}

/** The skeleton → content hand-off the image dialogs use, in a fixed order
 *  on content that has already painted:
 *    1. `ready`: the content is mounted at opacity 0 — WITH will-change:
 *       opacity, so it's a composited layer whose contents are rasterised
 *       while invisible (a plain opacity-0 subtree is skipped by the
 *       renderer and would rasterise during the fade) — and every <img>
 *       under `contentRef` is waited on until decoded, plus a few frames.
 *    2. If a skeleton was ever shown (the 500ms delay elapsed), it fades
 *       out over 200ms, alone.
 *    3. The content fades in over 200ms, alone.
 *  Returns the stage, whether a skeleton was seen (keep it MOUNTED through
 *  its fade — an unmount/remount skips it), and the two derived flags. */
/** A skeleton that appeared stays at least this long before handing off: a
 *  load that lands just past the 500ms delay would otherwise flash it for
 *  a few frames — which reads as a double load, not as loading. */
const MIN_SKELETON_MS = 500

function useHandoff(ready: boolean, contentRef: React.RefObject<HTMLElement | null>) {
  const showSkeleton = useSkeletonDelay(!ready)
  const [stage, setStage] = React.useState<"hidden" | "tiles-out" | "reveal" | "shown">("hidden")
  const seenRef = React.useRef(false)
  const seenAtRef = React.useRef(0)
  if (showSkeleton && !seenRef.current) {
    seenRef.current = true
    seenAtRef.current = performance.now()
  }
  React.useEffect(() => {
    if (!ready) {
      setStage("hidden")
      seenRef.current = false
      return
    }
    let cancelled = false
    ;(async () => {
      const imgs = contentRef.current ? Array.from(contentRef.current.querySelectorAll("img")) : []
      // A broken image must not hold the reveal forever.
      const cap = new Promise<void>((r) => setTimeout(r, 1500))
      await Promise.race([Promise.allSettled(imgs.map((i) => i.decode())), cap])
      for (let i = 0; i < 4; i++) {
        await new Promise<void>((r) => requestAnimationFrame(() => r()))
      }
      if (cancelled) return
      if (seenRef.current) {
        const shownFor = performance.now() - seenAtRef.current
        if (shownFor < MIN_SKELETON_MS) {
          await new Promise<void>((r) => setTimeout(r, MIN_SKELETON_MS - shownFor))
          if (cancelled) return
        }
        setStage("tiles-out")
        await new Promise<void>((r) => setTimeout(r, 200))
        if (cancelled) return
      }
      setStage("reveal")
      await new Promise<void>((r) => setTimeout(r, 200))
      if (cancelled) return
      setStage("shown")
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready])
  return {
    stage,
    skeletonSeen: seenRef.current,
    shown: stage === "shown",
    contentVisible: stage === "reveal" || stage === "shown",
  }
}

export { Skeleton, useHandoff, useSkeletonDelay }
