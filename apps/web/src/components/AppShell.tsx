import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import type { SettingsResult } from "../../../../src/contracts";
import { api, formatDate, isSettingsResult } from "../api";
import { cx } from "./ui";

const primary = [
  { to: "/", label: "Today", short: "Today" },
  { to: "/notes", label: "Notes", short: "Notes" },
  { to: "/add", label: "Add sources", short: "Add" },
  { to: "/history", label: "History", short: "History" },
];

const secondary = [
  { to: "/workflows", label: "Workflows" },
  { to: "/settings", label: "Settings" },
  { to: "/health", label: "Health" },
];

const linkClass = ({ isActive }: { isActive: boolean }) =>
  cx(
    "flex min-h-11 items-center rounded-md px-3 py-2 text-sm font-bold transition-colors duration-200 ease-expo",
    isActive ? "bg-ink text-paper" : "text-muted hover:bg-paper hover:text-ink",
  );

export function AppShell() {
  const location = useLocation();
  const main = useRef<HTMLElement>(null);
  const params = new URLSearchParams(location.search);
  const contentPath = JSON.stringify([location.pathname, params.get("pageId"), params.get("path")]);
  const previousContentPath = useRef(contentPath);
  const previousPathname = useRef(location.pathname);
  const settings = useQuery({
    queryKey: ["settings"],
    queryFn: ({ signal }) => api<SettingsResult>("/api/v1/settings", { signal }, isSettingsResult),
  });

  useEffect(() => {
    const pathname = location.pathname.toLowerCase().replace(/\/+$/, "") || "/";
    const routeTitle =
      primary.find((item) => item.to === pathname)?.label ??
      secondary.find((item) => item.to === pathname)?.label ??
      (/^\/history\/[^/]+$/.test(pathname) ? "Quiz history" : "Page not found");
    document.title = `${routeTitle} · Pi Scholar`;
    if (previousContentPath.current !== contentPath) {
      main.current?.focus({ preventScroll: previousPathname.current === location.pathname });
      previousContentPath.current = contentPath;
      previousPathname.current = location.pathname;
    }
  }, [contentPath, location.pathname]);

  return (
    <div className="min-h-screen">
      <aside
        className="fixed inset-y-0 left-0 hidden w-64 border-r border-line bg-canvas px-5 py-8 lg:flex lg:flex-col"
        aria-label="Application navigation"
      >
        <NavLink className="mb-10 block rounded-sm" to="/" aria-label="Pi Scholar home">
          <span className="block font-serif text-2xl font-semibold">Pi Scholar</span>
          <span className="eyebrow mt-1 block">A local field guide</span>
        </NavLink>
        <nav className="grid gap-1" aria-label="Primary">
          {primary.map((item) => (
            <NavLink className={linkClass} key={item.to} to={item.to} end={item.to === "/"}>
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="my-6 border-t border-line" />
        <nav className="grid gap-1" aria-label="Secondary">
          {secondary.map((item) => (
            <NavLink className={linkClass} key={item.to} to={item.to}>
              {item.label}
            </NavLink>
          ))}
        </nav>
      </aside>

      <div className="min-w-0 pb-24 lg:ml-64 lg:pb-0">
        <header className="sticky top-0 z-20 flex min-h-16 items-center justify-between border-b border-line bg-canvas px-4 sm:px-6 lg:hidden">
          <NavLink className="rounded-sm font-serif text-xl font-semibold" to="/">
            Pi Scholar
          </NavLink>
          <details className="relative">
            <summary className="flex min-h-11 cursor-pointer list-none items-center rounded-md border border-line bg-paper px-3 text-sm font-bold marker:content-none">
              More
            </summary>
            <nav
              className="absolute right-0 mt-2 grid w-44 gap-1 rounded-lg border border-line bg-paper p-2 shadow-quiet"
              aria-label="Secondary"
            >
              {secondary.map((item) => (
                <NavLink
                  className={linkClass}
                  key={item.to}
                  to={item.to}
                  onClick={(event) => event.currentTarget.closest("details")?.removeAttribute("open")}
                >
                  {item.label}
                </NavLink>
              ))}
            </nav>
          </details>
        </header>

        <main
          className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 sm:py-12 lg:px-10"
          id="main-content"
          ref={main}
          tabIndex={-1}
        >
          {settings.data?.settings.simulatedDate ? (
            <aside
              className="mb-8 rounded-lg border border-caution/40 bg-caution/10 p-4 sm:p-5"
              aria-label="Simulated learning date"
              role="status"
            >
              <p className="text-sm font-bold text-caution">Simulated learning date</p>
              <p className="mt-1">
                Pi Scholar is using{" "}
                <time dateTime={settings.data.settings.simulatedDate}>
                  {formatDate(settings.data.settings.simulatedDate, {
                    weekday: "long",
                    month: "long",
                    day: "numeric",
                    year: "numeric",
                  })}
                </time>{" "}
                for learning. Operational timestamps remain on real time.
              </p>
              <Link
                className="mt-3 inline-flex min-h-11 items-center font-bold underline decoration-accent decoration-2 underline-offset-4"
                to="/settings"
              >
                Open Settings
              </Link>
            </aside>
          ) : null}
          <Outlet />
        </main>
      </div>

      <nav
        className="safe-bottom fixed inset-x-0 bottom-0 z-30 grid grid-cols-4 border-t border-line bg-paper px-1 lg:hidden"
        aria-label="Primary"
      >
        {primary.map((item) => (
          <NavLink
            className={({ isActive }) =>
              cx(
                "flex min-h-14 items-center justify-center rounded-sm px-1 text-xs font-bold",
                isActive ? "text-ink underline decoration-accent decoration-4 underline-offset-8" : "text-muted",
              )
            }
            key={item.to}
            to={item.to}
            end={item.to === "/"}
          >
            {item.short}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
