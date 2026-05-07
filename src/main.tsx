import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import "flag-icons/css/flag-icons.min.css";
import App from "./App";
import { LanguageProvider } from "./i18n/LanguageContext";
import { applyRandomAccentTheme } from "./lib/accentTheme";
import "./index.css";

applyRandomAccentTheme();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <LanguageProvider>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </LanguageProvider>
  </React.StrictMode>,
);