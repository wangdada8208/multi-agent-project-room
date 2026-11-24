import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "./App";
import { initializeTheme } from "./lib/theme";
import { ToastContainer } from "./components/ui/Toast";
import "./styles.css";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/primitives.css";

initializeTheme();

const queryClient = new QueryClient();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
        <ToastContainer />
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
