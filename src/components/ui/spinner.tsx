import { cn } from "@/lib/utils"
import { Loader2Icon } from "lucide-react"

/** The rotation lives on a wrapping span, not the SVG: Chromium runs
 *  transform animations on HTML elements on the compositor thread, but
 *  animates SVG elements on the main thread — so a spinner drawn straight on
 *  the icon froze into a few frames per turn whenever the page was busy
 *  (big refreshes behind a match click). `className` sizes the shell; the
 *  icon fills it. */
function Spinner({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      role="status"
      aria-label="Loading"
      className={cn("inline-block size-4 shrink-0 animate-spin will-change-transform", className)}
      {...props}
    >
      <Loader2Icon className="size-full" />
    </span>
  )
}

export { Spinner }
