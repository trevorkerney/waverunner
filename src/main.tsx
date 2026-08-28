import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource-variable/geist";
import { polyfillCountryFlagEmojis } from "country-flag-emoji-polyfill";
import App from "./App";

// Windows renders flag emoji as bare letter pairs ("US") — this injects the
// "Twemoji Country Flags" subset font so 🇺🇸-style codepoints actually draw
// as flags (used by the release picker's country column).
polyfillCountryFlagEmojis();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
