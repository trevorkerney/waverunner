"use client"

import * as React from "react"
import { createPortal } from "react-dom"
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { XIcon } from "lucide-react"

// ---------------------------------------------------------------------------
// The modal system (2026-09-23).
//
// ONE shell. The stack provider owns a single popup (backdrop, frame, focus
// trap, Escape, outside-click). A <Dialog> doesn't render a popup of its
// own: while it is the dialog on show, it portals its content INTO the
// shell. React context and state stay with the caller (a portal keeps the
// React tree), only the DOM lands in the shell.
//
// ONE visible modal. Open dialogs register on a stack in opening order;
// the shell shows the top. A dialog that opens another is hidden while the
// child is up and comes back when the child closes; chains of any depth
// work because it's a stack. Escape / backdrop / Cancel / the X pop one.
// A child that FINISHES its parent's job declares `finishesParent`; its
// `finish()` (useDialogStack) pops itself and keeps popping while the
// entry it removed finished the one beneath.
//
// FIXED sizes. Every DialogContent declares a width (`size`) and a height
// (`height`) from short vocabularies (or a raw CSS length). The frame is
// exactly that; the body scrolls (DialogBody) when content is taller and
// leaves air when it's shorter. Nothing is ever measured.
//
// The MORPH. When the dialog on show changes (child opens, child closes):
//   1. everything in the shell fades out         (FADE_MS)
//   2. the empty frame animates to the new size  (RESIZE_MS)
//   3. the new dialog's content fades in         (FADE_MS)
// The first open and the last close use the shell's own enter/exit.
// ---------------------------------------------------------------------------

const FADE_MS = 200
const RESIZE_MS = 200
/** The shell's exit animation (see the popup's data-closed classes). */
const EXIT_MS = 120

/** Width vocabulary. */
const DIALOG_SIZES = {
  sm: "24rem",
  md: "28rem",
  lg: "32rem",
  xl: "40rem",
  "2xl": "48rem",
} as const
type DialogSize = keyof typeof DIALOG_SIZES

/** Height vocabulary. */
const DIALOG_HEIGHTS = {
  xs: "14rem",
  sm: "20rem",
  md: "28rem",
  lg: "36rem",
  xl: "44rem",
} as const
type DialogHeight = keyof typeof DIALOG_HEIGHTS

interface FrameSize {
  width: string
  /** undefined = not declared (content height; the morph can't animate to it). */
  height: string | undefined
}

type CloseDetails = DialogPrimitive.Root.ChangeEventDetails

interface StackEntry {
  id: string
  finishesParent: boolean
  /** Ask this dialog to close (its own onOpenChange(false)). */
  requestClose: (details?: CloseDetails) => void
  /** What a DISMISS (X / outside / Escape) does while this is on top:
   *  "all" clears the stack (default); "self" closes only this dialog and
   *  returns to the one beneath — for confirmations and other small boxes. */
  dismiss: "self" | "all"
  /** The dialog's content lives in this node for the dialog's whole life.
   *  The shell gives it a slot and never moves it: re-attaching a node
   *  makes the browser re-evaluate its images, which flashed blank. */
  node: HTMLDivElement
}

interface StackActions {
  push: (entry: StackEntry) => void
  pop: (id: string) => void
  finish: (id: string) => void
  registerSize: (id: string, size: FrameSize) => void
  /** The X, a click outside, or Escape: clears the whole stack, unless the
   *  dialog on top declared `dismiss="self"` — then only it closes. */
  dismissTop: (details?: CloseDetails) => void
}

interface StackView {
  stack: StackEntry[]
  /** The dialog whose content is in the shell's main slot. */
  displayed: string | null
  /** During the morph's fade-out: the dialog leaving, in the overlay slot. */
  outgoing: string | null
  /** The shell's morph phase (see useDialogPhase). */
  phase: Phase
}

// Two contexts on purpose: the actions never change (a registration effect
// can depend on them), the view changes on every push/pop.
const StackActionsContext = React.createContext<StackActions | null>(null)
const StackViewContext = React.createContext<StackView | null>(null)

type Phase = "idle" | "out" | "resize" | "in"

/** Mount once at the app root. */
function ModalStackProvider({ children }: { children: React.ReactNode }) {
  const [stack, setStack] = React.useState<StackEntry[]>([])
  const stackRef = React.useRef(stack)
  stackRef.current = stack
  const [sizes, setSizes] = React.useState<Map<string, FrameSize>>(() => new Map())
  const sizesRef = React.useRef(sizes)
  sizesRef.current = sizes

  const [displayed, setDisplayed] = React.useState<string | null>(null)
  // The dialog leaving during a change-over. Its entry is kept here because
  // it has usually popped from the stack by then (it closed), and the
  // shell still needs its node to fade it.
  const [outgoing, setOutgoing] = React.useState<StackEntry | null>(null)
  const [phase, setPhase] = React.useState<Phase>("idle")
  // In-place growth: the main slot stays visible through the resize.
  const [keep, setKeep] = React.useState(false)
  const generation = React.useRef(0)
  // Set by dismissTop while it clears the stack; cleared by the emptying
  // pop, or by a push (a dialog declined to close — follow the top again).
  const clearingRef = React.useRef(false)
  const reduced =
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches

  // Every entry ever pushed, by id — the change-over needs the leaving
  // dialog's node after it has popped.
  const entriesRef = React.useRef<Map<string, StackEntry>>(new Map())
  // push/pop compute the new stack synchronously and hand its top to
  // followTop IN THE SAME UPDATE, so the render that drops a closed dialog
  // from the stack is also the render that marks it "leaving". (Reacting to
  // the top in an effect left one frame in between — the leaving dialog's
  // slot unmounted, its node detached, and re-attached a frame later: the
  // content vanished and its images flashed blank.)
  const push = React.useCallback((entry: StackEntry) => {
    entriesRef.current.set(entry.id, entry)
    clearingRef.current = false
    const next = [...stackRef.current.filter((e) => e.id !== entry.id), entry]
    stackRef.current = next
    setStack(next)
    followTopRef.current(next)
  }, [])
  const pop = React.useCallback((id: string) => {
    if (!stackRef.current.some((e) => e.id === id)) return
    const next = stackRef.current.filter((e) => e.id !== id)
    stackRef.current = next
    setStack(next)
    setSizes((prev) => {
      if (!prev.has(id)) return prev
      const n = new Map(prev)
      n.delete(id)
      return n
    })
    followTopRef.current(next)
  }, [])
  const finish = React.useCallback((id: string) => {
    const s = stackRef.current
    const idx = s.findIndex((e) => e.id === id)
    if (idx === -1) return
    // Close from the top down to `id`, then keep going while each closed
    // entry finished the one beneath it.
    const toClose: StackEntry[] = []
    for (let i = s.length - 1; i >= idx; i--) toClose.push(s[i])
    let cursor = idx - 1
    let last = s[idx]
    while (last.finishesParent && cursor >= 0) {
      toClose.push(s[cursor])
      last = s[cursor]
      cursor--
    }
    for (const e of toClose) e.requestClose()
  }, [])
  const registerSize = React.useCallback((id: string, size: FrameSize) => {
    setSizes((prev) => {
      const cur = prev.get(id)
      if (cur && cur.width === size.width && cur.height === size.height) return prev
      const next = new Map(prev)
      next.set(id, size)
      return next
    })
  }, [])

  // The frame size actually applied to the shell. It lags the declared
  // sizes on purpose: through a change-over it switches at the resize step,
  // and a dialog that re-declares its own size (a taller state, say) gets
  // the same fade → resize → fade rather than a live resize.
  const [applied, setApplied] = React.useState<FrameSize | undefined>(undefined)

  // The dialog on show follows the top of the stack — through the morph
  // when there's a change-over, immediately on the first open, and after
  // the exit animation on the last close. Called from push/pop with the
  // new stack, in their update (see above).
  const displayedRef = React.useRef<string | null>(null)
  displayedRef.current = displayed
  // The last dialog's close, pending its exit animation. Cancelled if a
  // dialog is back on the stack before it fires — React's dev-mode double
  // effects register, unregister and re-register in one tick, and the
  // re-register must not leave a close armed.
  const closeTimerRef = React.useRef<number | null>(null)
  const followTopRef = React.useRef<(next: StackEntry[]) => void>(() => {})
  followTopRef.current = (next: StackEntry[]) => {
    const top = next.length > 0 ? next[next.length - 1].id : null
    const cur = displayedRef.current
    if (top !== null && closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
    // Mid-clear: dialogs are popping one by one; hold the display where it
    // is until the stack is empty.
    if (clearingRef.current) {
      if (top === null) clearingRef.current = false
      else return
    }
    if (top === cur) return
    const gen = ++generation.current
    if (cur === null) {
      displayedRef.current = top
      setDisplayed(top)
      return
    }
    if (top === null) {
      closeTimerRef.current = window.setTimeout(() => {
        closeTimerRef.current = null
        if (gen !== generation.current) return
        displayedRef.current = null
        setDisplayed(null)
        setApplied(undefined)
        setPhase("idle")
      }, EXIT_MS)
      return
    }
    if (reduced) {
      displayedRef.current = top
      setDisplayed(top)
      setApplied(sizesRef.current.get(top))
      return
    }
    // Change-over: the current content leaves (its slot fades) while the
    // new content mounts invisible in its own slot.
    setOutgoing(entriesRef.current.get(cur) ?? null)
    displayedRef.current = top
    setDisplayed(top)
    runMorph(gen, () => sizesRef.current.get(top), { afterOut: () => setOutgoing(null) })
  }

  /** The fade → (resize) → fade sequence. Sets phase "out" now; after the
   *  fade, applies the target size and runs the resize step ONLY if the size
   *  actually differs (same-size change-overs take 400ms, not 600); then
   *  fades in. The target is read after the fade-out, by which time a new
   *  dialog's content has mounted and declared it. Returns the cleanup. */
  const appliedRef = React.useRef(applied)
  appliedRef.current = applied
  const runMorph = (
    gen: number,
    target: () => FrameSize | undefined,
    opts: {
      afterOut?: () => void
      /** In-place growth (a dialog re-declaring its own size): the content
       *  stays visible and rides the resize; nothing fades out. The dialog
       *  fades its NEW content in itself, keyed on the "in" phase
       *  (useDialogPhase). */
      keepContent?: boolean
    } = {},
  ) => {
    const timers: number[] = []
    const later = (ms: number, f: () => void) => {
      timers.push(
        window.setTimeout(() => {
          if (gen === generation.current) f()
        }, ms),
      )
    }
    const resizeThenIn = () => {
      opts.afterOut?.()
      const next = target()
      const cur = appliedRef.current
      const same = !!cur && !!next && cur.width === next.width && cur.height === next.height
      let resize = 0
      if (!same) {
        setApplied(next)
        setPhase("resize")
        resize = RESIZE_MS
      }
      later(resize, () => setPhase("in"))
      later(resize + FADE_MS, () => {
        setPhase("idle")
        setKeep(false)
      })
    }
    if (opts.keepContent) {
      setKeep(true)
      resizeThenIn()
    } else {
      setPhase("out")
      later(FADE_MS, resizeThenIn)
    }
    return () => {
      for (const t of timers) window.clearTimeout(t)
    }
  }

  // The declared size of the dialog on show: applied at once when the
  // shell first shows it, and animated (fade → resize → fade) when the same
  // dialog re-declares while idle.
  const declared = displayed ? sizes.get(displayed) : undefined
  React.useEffect(() => {
    if (!displayed || !declared) return
    if (!applied) {
      setApplied(declared)
      return
    }
    if (phase !== "idle") return
    if (applied.width === declared.width && applied.height === declared.height) return
    if (reduced) {
      setApplied(declared)
      return
    }
    const gen = ++generation.current
    // No cleanup: `phase` is a dep (so a re-declare during a morph is
    // re-checked once idle), and the morph itself changes phase — a cleanup
    // here would cancel the timers it had just scheduled. The generation
    // guard already retires them if another morph starts.
    runMorph(gen, () => declared, { keepContent: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayed, declared?.width, declared?.height, phase])

  // Clearing the whole stack: every dialog closes top-down in one tick, and
  // the flag tells followTop not to start a change-over to each parent on
  // the way down — the shell just runs its one exit once the stack is empty.
  const dismissTop = React.useCallback((details?: CloseDetails) => {
    const s = stackRef.current
    const top = s[s.length - 1]
    if (!top) return
    if (top.dismiss === "self") {
      top.requestClose(details)
      return
    }
    clearingRef.current = true
    for (let i = s.length - 1; i >= 0; i--) s[i].requestClose(details)
  }, [])

  const actions = React.useMemo(
    () => ({ push, pop, finish, registerSize, dismissTop }),
    [push, pop, finish, registerSize, dismissTop],
  )
  const view = React.useMemo<StackView>(
    () => ({ stack, displayed, outgoing: outgoing?.id ?? null, phase }),
    [stack, displayed, outgoing, phase],
  )

  // The shell shows once the dialog on show has declared its size — never a
  // frame at the wrong size. (Legacy dialogs without a height show at
  // content height.)
  const size = applied
  const shellOpen = displayed !== null && size !== undefined

  // One slot per open dialog (plus the one leaving), keyed by id, so a
  // dialog's node is attached ONCE and only its slot's role changes:
  //   showing — in flow, the frame's full size
  //   leaving — an overlay fading out over the one arriving
  //   parked  — display:none (a parent behind its child); the node stays
  //             attached, so its images don't reload when it returns
  const slots: StackEntry[] = outgoing && !stack.some((e) => e.id === outgoing.id) ? [...stack, outgoing] : stack
  const hiddenMain = (phase === "out" || phase === "resize") && !keep
  return (
    <StackActionsContext.Provider value={actions}>
      <StackViewContext.Provider value={view}>
        {children}
        <DialogPrimitive.Root
          open={shellOpen}
          onOpenChange={(o, details) => {
            if (!o) dismissTop(details)
          }}
        >
          <DialogPrimitive.Portal>
            <DialogPrimitive.Backdrop
              data-slot="dialog-overlay"
              className="fixed inset-0 isolate z-50 bg-black/10 duration-100 supports-backdrop-filter:backdrop-blur-xs data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0"
            />
            <DialogPrimitive.Popup
              data-slot="dialog-shell"
              className="fixed top-1/2 left-1/2 z-50 -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-xl bg-popover text-sm text-popover-foreground ring-1 ring-foreground/10 outline-none duration-100 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 dark:bg-[oklch(0.145_0_0)]"
              style={{
                width: size ? `min(${size.width}, calc(100vw - 3rem))` : undefined,
                height: size?.height ? `min(${size.height}, calc(100vh - 6rem))` : undefined,
                maxHeight: "calc(100vh - 6rem)",
                transition:
                  phase === "resize"
                    ? `width ${RESIZE_MS}ms ease-in-out, height ${RESIZE_MS}ms ease-in-out`
                    : undefined,
              }}
            >
              {slots.map((e) => {
                const role = e.id === displayed ? "showing" : e.id === outgoing?.id ? "leaving" : "parked"
                return (
                  <div
                    key={e.id}
                    ref={(el) => {
                      if (el && e.node.parentNode !== el) el.appendChild(e.node)
                    }}
                    className={
                      role === "showing"
                        ? "relative h-full w-full"
                        : role === "leaving"
                          ? "absolute inset-0"
                          : "hidden"
                    }
                    style={
                      role === "showing"
                        ? {
                            // Snaps to hidden at the start of a change-over
                            // (the leaving content fades in ITS slot); only
                            // fades on the way in. will-change through the
                            // morph: a composited layer is rasterised even
                            // at opacity 0, so the fade-in starts with the
                            // images already painted (a plain opacity-0
                            // subtree isn't painted until the fade runs —
                            // the arriving covers flashed in late).
                            opacity: hiddenMain ? 0 : 1,
                            willChange: phase === "idle" ? undefined : "opacity",
                            transition: phase === "in" ? `opacity ${FADE_MS}ms ease-in` : undefined,
                          }
                        : role === "leaving"
                          ? // A keyframe, not a transition: the role flips the
                            // moment the fade starts, and a transition needs a
                            // painted starting value.
                            { animation: `dialog-shell-fade-out ${FADE_MS}ms ease-out forwards` }
                          : undefined
                    }
                  />
                )
              })}
            </DialogPrimitive.Popup>
          </DialogPrimitive.Portal>
        </DialogPrimitive.Root>
      </StackViewContext.Provider>
    </StackActionsContext.Provider>
  )
}

interface DialogEntry {
  id: string
  registerSize: (size: FrameSize) => void
  /** Close just this dialog (a button's close). */
  requestClose: () => void
  /** The X: a dismiss (see StackEntry.dismiss). */
  dismiss: () => void
}
const DialogEntryContext = React.createContext<DialogEntry | null>(null)

/** Controls for the dialog you're rendered inside. `finish()` closes it as a
 *  completed job (see the stack notes above); `close()` is a plain dismiss. */
function useDialogStack() {
  const actions = React.useContext(StackActionsContext)
  const entry = React.useContext(DialogEntryContext)
  return React.useMemo(
    () => ({
      finish: () => {
        if (actions && entry) actions.finish(entry.id)
      },
      close: () => entry?.requestClose(),
    }),
    [actions, entry],
  )
}

/** The shell's morph phase as seen by the dialog you're rendered inside:
 *  "resize" while the frame animates to a size this dialog re-declared,
 *  "in" for the 200ms after — the moment to fade newly added content in —
 *  and "idle" otherwise (including whenever this dialog isn't on show). */
function useDialogPhase(): Phase {
  const view = React.useContext(StackViewContext)
  const entry = React.useContext(DialogEntryContext)
  if (!view || !entry || view.displayed !== entry.id) return "idle"
  return view.phase
}

interface DialogProps {
  open?: boolean
  onOpenChange?: (open: boolean, details?: CloseDetails) => void
  /** Completing this dialog also completes the one it was opened from. */
  finishesParent?: boolean
  /** What the X / a click outside / Escape does while this dialog is on
   *  top. "all" (default) clears the whole stack; "self" closes only this
   *  one and returns to the dialog beneath — for confirmations and other
   *  small boxes opened over something the user is still in. Buttons
   *  inside a dialog always close just that dialog, whatever this says. */
  dismiss?: "self" | "all"
  children?: React.ReactNode
}

function Dialog({ open, onOpenChange, finishesParent = false, dismiss = "all", children }: DialogProps) {
  const actions = React.useContext(StackActionsContext)
  const view = React.useContext(StackViewContext)
  if (!actions || !view) throw new Error("Dialog outside ModalStackProvider")
  const id = React.useId()
  const isOpen = !!open
  // The latest close handler, read at close time — never stale.
  const onOpenChangeRef = React.useRef(onOpenChange)
  onOpenChangeRef.current = onOpenChange

  const requestClose = React.useCallback((details?: CloseDetails) => {
    onOpenChangeRef.current?.(
      false,
      details ??
        // A programmatic close has no DOM event; the reason mirrors what a
        // Cancel button would produce so handlers can treat it as one.
        ({
          reason: "none",
          event: new Event("dialog-stack-close"),
          cancel: () => {},
          allowPropagation: () => {},
          isCanceled: false,
          isPropagationAllowed: false,
          trigger: undefined,
          preventUnmount: () => {},
          isUnmountPrevented: false,
        } as unknown as CloseDetails),
    )
  }, [])

  // The content portals into ONE node for the dialog's whole life. The
  // portal's container must never change: React remounts a portal whose
  // container differs, which would reset the content's state and remount
  // any dialog nested in it. The shell attaches the node to a slot of its
  // own once and never moves it.
  const [node] = React.useState(() => {
    const d = document.createElement("div")
    d.className = "h-full w-full"
    return d
  })

  React.useEffect(() => {
    if (!isOpen) return
    actions.push({ id, finishesParent, dismiss, requestClose, node })
    return () => actions.pop(id)
    // finishesParent / dismiss are fixed for a dialog's lifetime in practice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actions, isOpen, id, requestClose, node])

  // Keep rendering briefly after a close so the shell's exit animation (or
  // the morph back to the parent) has content to fade, not an empty frame.
  const [lingering, setLingering] = React.useState(false)
  const wasOpen = React.useRef(isOpen)
  React.useEffect(() => {
    if (wasOpen.current && !isOpen) {
      setLingering(true)
      const t = window.setTimeout(() => setLingering(false), FADE_MS + EXIT_MS)
      wasOpen.current = isOpen
      return () => window.clearTimeout(t)
    }
    wasOpen.current = isOpen
    if (isOpen) setLingering(false)
  }, [isOpen])

  const entry = React.useMemo<DialogEntry>(
    () => ({
      id,
      registerSize: (s) => actions.registerSize(id, s),
      requestClose,
      dismiss: () => actions.dismissTop(),
    }),
    [id, actions, requestClose],
  )

  // wasOpen covers the render in which `open` just flipped false: `lingering`
  // is only set in the effect after it, and returning null here for that one
  // render unmounted the whole content and remounted it a frame later (the
  // tiles' skeletons flashed, their images reloaded).
  if (!(isOpen || lingering || wasOpen.current)) return null
  return (
    <DialogEntryContext.Provider value={entry}>
      {createPortal(children, node)}
    </DialogEntryContext.Provider>
  )
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  size = "md",
  width,
  height,
  ...props
}: React.ComponentProps<"div"> & {
  showCloseButton?: boolean
  /** Named width (default md). */
  size?: DialogSize
  /** Any CSS length — overrides `size` for the odd one out. */
  width?: string
  /** Named height, or any CSS length. Undefined = content height (legacy —
   *  every dialog should declare one; the morph can't animate to "auto"). */
  height?: DialogHeight | (string & {})
}) {
  const entry = React.useContext(DialogEntryContext)
  const w = width ?? DIALOG_SIZES[size]
  const h = height === undefined ? undefined : (DIALOG_HEIGHTS as Record<string, string>)[height] ?? height
  React.useLayoutEffect(() => {
    entry?.registerSize({ width: w, height: h })
  }, [entry, w, h])
  return (
    <div
      data-slot="dialog-content"
      className={cn("relative flex h-full w-full flex-col gap-4 p-4", className)}
      {...props}
    >
      {children}
      {showCloseButton && (
        <Button
          data-slot="dialog-close"
          variant="ghost"
          className="absolute top-2 right-2"
          size="icon-sm"
          onClick={() => entry?.dismiss()}
        >
          <XIcon />
          <span className="sr-only">Close</span>
        </Button>
      )}
    </div>
  )
}

/** The scrolling middle of a fixed-size dialog: header and footer stay put,
 *  this takes the rest and scrolls when content is taller. */
function DialogBody({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-body"
      className={cn("min-h-0 flex-1 overflow-y-auto", className)}
      {...props}
    />
  )
}

// ---------------------------------------------------------------------------
// Content transition — for content that swaps INSIDE one dialog (a wizard's
// steps, search → review, tabs). Keyed by what's showing; a change fades the
// current content out, animates the box's height to the new content's,
// then fades the new content in. With fixed-size dialogs the box is the
// body, so this mostly matters for dialogs that haven't declared a height.
// ---------------------------------------------------------------------------

const OUT_MS = 120
const T_RESIZE_MS = 220
const IN_MS = 150
/** Swaps inside this window after mount are instant (see mountedAt). */
const ENTRANCE_MS = 250

type TPhase = "idle" | "out" | "resize" | "in"

function DialogTransition({
  contentKey,
  children,
  className,
}: {
  /** Identifies the content currently shown; a change runs the transition. */
  contentKey: string | number
  children: React.ReactNode
  className?: string
}) {
  const outerRef = React.useRef<HTMLDivElement | null>(null)
  const innerRef = React.useRef<HTMLDivElement | null>(null)
  const [phase, setPhase] = React.useState<TPhase>("idle")
  const [shownKey, setShownKey] = React.useState(contentKey)
  const [frozen, setFrozen] = React.useState<React.ReactNode>(null)
  const lastChildrenRef = React.useRef<React.ReactNode>(children)
  if (phase !== "out") lastChildrenRef.current = children
  const [height, setHeight] = React.useState<number | null>(null)
  const generation = React.useRef(0)
  const reduced =
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
  const mountedAt = React.useRef(0)
  React.useEffect(() => {
    mountedAt.current = performance.now()
  }, [])

  React.useEffect(() => {
    if (contentKey === shownKey) return
    if (reduced || performance.now() - mountedAt.current < ENTRANCE_MS) {
      setShownKey(contentKey)
      return
    }
    const gen = ++generation.current
    const outer = outerRef.current
    // Layout height, not the bounding rect: an ancestor's scale animation
    // would make a rect read short and pin the box too small.
    if (outer) setHeight(outer.offsetHeight)
    setFrozen(lastChildrenRef.current)
    setPhase("out")
    const t = window.setTimeout(() => {
      if (gen !== generation.current) return
      setFrozen(null)
      setShownKey(contentKey)
      setPhase("resize")
    }, OUT_MS)
    return () => window.clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contentKey])

  React.useLayoutEffect(() => {
    if (phase !== "resize") return
    const gen = generation.current
    const inner = innerRef.current
    const target = inner ? inner.offsetHeight : null
    let raf2 = 0
    const raf1 = window.requestAnimationFrame(() => {
      raf2 = window.requestAnimationFrame(() => {
        if (gen !== generation.current) return
        if (target != null) setHeight(target)
      })
    })
    const t = window.setTimeout(() => {
      if (gen !== generation.current) return
      setHeight(null)
      setPhase("in")
    }, T_RESIZE_MS + 20)
    return () => {
      window.cancelAnimationFrame(raf1)
      window.cancelAnimationFrame(raf2)
      window.clearTimeout(t)
    }
  }, [phase])

  React.useEffect(() => {
    if (phase !== "in") return
    const gen = generation.current
    const t = window.setTimeout(() => {
      if (gen === generation.current) setPhase("idle")
    }, IN_MS)
    return () => window.clearTimeout(t)
  }, [phase])

  const hidden = phase === "out" || phase === "resize"
  return (
    <div
      ref={outerRef}
      className={cn("min-h-0", className)}
      style={{
        height: height == null ? undefined : `${height}px`,
        overflow: phase === "idle" ? undefined : "hidden",
        transition: phase === "resize" ? `height ${T_RESIZE_MS}ms ease-in-out` : undefined,
      }}
    >
      <div
        ref={innerRef}
        style={{
          opacity: hidden ? 0 : 1,
          transition:
            phase === "out"
              ? `opacity ${OUT_MS}ms ease-out`
              : phase === "in"
                ? `opacity ${IN_MS}ms ease-in`
                : undefined,
        }}
      >
        {phase === "out" ? frozen : children}
      </div>
    </div>
  )
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex shrink-0 flex-col gap-2", className)}
      {...props}
    />
  )
}

function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  showCloseButton?: boolean
}) {
  const entry = React.useContext(DialogEntryContext)
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "-mx-4 -mb-4 mt-auto flex shrink-0 flex-row justify-end gap-2 rounded-b-xl border-t bg-muted/50 p-4",
        className
      )}
      {...props}
    >
      {children}
      {showCloseButton && (
        <Button variant="outline" onClick={() => entry?.requestClose()}>
          Close
        </Button>
      )}
    </div>
  )
}

function DialogTitle({ className, ...props }: React.ComponentProps<"h2">) {
  return (
    <h2
      data-slot="dialog-title"
      className={cn(
        "font-heading text-sm leading-none font-medium",
        className
      )}
      {...props}
    />
  )
}

function DialogDescription({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <p
      data-slot="dialog-description"
      className={cn(
        "text-sm text-muted-foreground *:[a]:underline *:[a]:underline-offset-3 *:[a]:hover:text-foreground",
        className
      )}
      {...props}
    />
  )
}

export {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTransition,
  ModalStackProvider,
  useDialogStack,
  useDialogPhase,
  DIALOG_SIZES,
  DIALOG_HEIGHTS,
}
export type { DialogSize, DialogHeight }
