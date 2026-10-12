import { toast as sonner, type ExternalToast } from "sonner";

/** The app's toast: sonner's, with one rule on top (user's call,
 *  2026-10-03). A toast that carries a sentence to READ — info, warning,
 *  error — stays until dismissed (the Toaster shows a close button);
 *  a plain confirmation (`toast(...)`, `toast.success(...)`) keeps sonner's
 *  short timer. He missed what an info toast said and had no way back to
 *  it. A call that sets its own `duration` wins. */
const STAYS: ExternalToast = { duration: Infinity };

type Msg = Parameters<typeof sonner>[0];

export const toast = Object.assign(
  (message: Msg, data?: ExternalToast) => sonner(message, data),
  sonner,
  {
    info: (message: Msg, data?: ExternalToast) => sonner.info(message, { ...STAYS, ...data }),
    warning: (message: Msg, data?: ExternalToast) =>
      sonner.warning(message, { ...STAYS, ...data }),
    error: (message: Msg, data?: ExternalToast) => sonner.error(message, { ...STAYS, ...data }),
  },
);
