import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { AppShell } from "./components/AppShell";
import { AddPage } from "./pages/Add";
import { HealthPage } from "./pages/Health";
import { HistoryDetailPage, HistoryPage } from "./pages/History";
import { NotesPage } from "./pages/Notes";
import { NotFoundPage } from "./pages/NotFound";
import { SettingsPage } from "./pages/Settings";
import { TodayPage } from "./pages/Today";
import { WorkflowsPage } from "./pages/Workflows";
import "./styles.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
      staleTime: 10_000,
    },
    mutations: {
      retry: false,
    },
  },
});

const root = document.getElementById("root");
if (!root) throw new Error("Application root is missing");

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route element={<AppShell />}>
            <Route index element={<TodayPage />} />
            <Route path="notes" element={<NotesPage />} />
            <Route path="add" element={<AddPage />} />
            <Route path="history" element={<HistoryPage />} />
            <Route path="history/:date" element={<HistoryDetailPage />} />
            <Route path="workflows" element={<WorkflowsPage />} />
            <Route path="settings" element={<SettingsPage />} />
            <Route path="health" element={<HealthPage />} />
            <Route path="*" element={<NotFoundPage />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
