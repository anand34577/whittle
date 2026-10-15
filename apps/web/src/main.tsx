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
import "./styles/themes.css";
import { App } from "./App";
import { useApp } from "./state/store";
import { designApi } from "./state/designApi";
import { dimensionPick } from "./state/constraintOps";
import { COMMANDS } from "./state/commands";
import { handlePick } from "./state/actions";

// Debugging, end-to-end tests and scripting: `await whittle.api.run("get_design", {})`.
(window as unknown as { whittle: unknown }).whittle = { useApp, api: designApi, dimensionPick, commands: COMMANDS, handlePick };

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);