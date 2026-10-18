import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "./styles/tokens.css";
import "./styles/app.css";
import "./styles/enhance.css";
import "./styles/platform.css";
import "./styles/controls.css";
import "./styles/feedback.css";
import "./styles/themes.css";
import "./styles/assist.css";
import { App } from "./App";
import { ErrorBoundary } from "./ui/ErrorBoundary";
import { useApp } from "./state/store";
import { designApi } from "./state/designApi";
import { dimensionPick } from "./state/constraintOps";
import { COMMANDS } from "./state/commands";
import { handlePick } from "./state/actions";

// Debugging, end-to-end tests and scripting: `await whittle.api.run("get_design", {})`. Off in normal use, so a
// script injected into the page doesn't get the whole app handed to it; turn it on with
// `localStorage.setItem("whittle.debug", "1")` and reload.
let debug = import.meta.env.DEV;
try {
  debug ||= localStorage.getItem("whittle.debug") === "1";
} catch {
  /* storage may be unavailable */
}
if (debug) (window as unknown as { whittle: unknown }).whittle = { useApp, api: designApi, dimensionPick, commands: COMMANDS, handlePick };

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);