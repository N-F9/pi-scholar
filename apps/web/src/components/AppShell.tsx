import { useEffect, useRef } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
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
  const previousPath = useRef(location.pathname);

  useEffect(() => {
    const pathname = location.pathname.replace(/\/+$/, "") || "/";
    const routeTitle =
      primary.find((item) => item.to === pathname)?.label ??
      secondary.find((item) => item.to === pathname)?.label ??
      (/^\/history\/[^/]+$/.test(pathname) ? "Quiz history" : "Page not found");
    document.title = `${routeTitle} · Pi Scholar`;
    if (previousPath.current !== location.pathname) {
      main.current?.focus({ preventScroll: true });
      previousPath.current = location.pathname;
    }
  }, [location.pathname]);

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
        <p className="mt-auto text-xs leading-5 text-muted">
          Your vault stays on this machine. Changes use the same local application boundary as Pi.
        </p>
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
