import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import "flag-icons/css/flag-icons.min.css";
import App from "./App";
import { LanguageProvider } from "./i18n/LanguageContext";
import { applyStoredAccentTheme } from "./lib/accentTheme";
import "./index.css";

const userAgent = navigator.userAgent;

if (
  /Chrome|CriOS|Chromium/.test(userAgent) &&
  !/Edg|OPR|Opera|Safari\/.*Version/.test(userAgent)
) {
  document.documentElement.classList.add("browser-chrome");
}

applyStoredAccentTheme();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <LanguageProvider>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </LanguageProvider>
  </React.StrictMode>,
);
