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

export { Skeleton, useSkeletonDelay }
