import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import type { SettingsResult } from "../../../../src/contracts";
import { api, formatDate, isSettingsResult } from "../api";

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
  cn(buttonVariants({ variant: isActive ? "default" : "ghost", size: "lg" }), "min-h-11 w-full justify-start");

export function AppShell() {
  const location = useLocation();
  const activePath = location.pathname.toLowerCase().replace(/\/+$/, "") || "/";
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
    <div className="min-h-screen bg-background text-foreground">
      <aside
        className="fixed inset-y-0 left-0 hidden w-64 border-r border-border bg-background px-5 py-8 lg:flex lg:flex-col"
        aria-label="Application navigation"
      >
        <NavLink className="mb-10 block rounded-lg" to="/" aria-label="Pi Scholar home">
          <span className="block text-2xl font-semibold">Pi Scholar</span>
          <span className="mt-1 block text-xs font-medium uppercase tracking-widest text-muted-foreground">
            A local field guide
          </span>
        </NavLink>
        <nav className="grid gap-1" aria-label="Primary">
          {primary.map((item) => (
            <NavLink className={linkClass} key={item.to} to={item.to} end={item.to === "/"}>
              {item.label}
            </NavLink>
          ))}
        </nav>
        <Separator className="my-6" />
        <nav className="grid gap-1" aria-label="Secondary">
          {secondary.map((item) => (
            <NavLink className={linkClass} key={item.to} to={item.to}>
              {item.label}
            </NavLink>
          ))}
        </nav>
      </aside>

      <div className="min-w-0 pb-24 lg:ml-64 lg:pb-0">
        <header className="sticky top-0 z-20 flex min-h-16 items-center justify-between border-b border-border bg-background px-4 sm:px-6 lg:hidden">
          <NavLink className="rounded-lg text-xl font-semibold" to="/">
            Pi Scholar
          </NavLink>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button className="min-h-11" type="button" variant="outline">
                More
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" aria-label="Secondary" className="w-44">
              {secondary.map((item) => (
                <DropdownMenuItem
                  asChild
                  className={cn(
                    buttonVariants({
                      variant: activePath === item.to ? "default" : "ghost",
                      size: "lg",
                    }),
                    "min-h-11 w-full justify-start",
                  )}
                  key={item.to}
                >
                  <NavLink to={item.to}>{item.label}</NavLink>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </header>

        <main
          className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 sm:py-12 lg:px-10"
          id="main-content"
          ref={main}
          tabIndex={-1}
        >
          {settings.data?.settings.simulatedDate ? (
            <Alert aria-label="Simulated learning date" className="mb-8" role="status">
              <AlertTitle>Simulated learning date</AlertTitle>
              <AlertDescription>
                <p>
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
                  className={cn(buttonVariants({ variant: "link" }), "h-auto min-h-11 justify-start p-0")}
                  to="/settings"
                >
                  Open Settings
                </Link>
              </AlertDescription>
            </Alert>
          ) : null}
          <Outlet />
        </main>
      </div>

      <nav
        className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-4 border-t border-border bg-background px-1 pb-[max(env(safe-area-inset-bottom),var(--spacing))] lg:hidden"
        aria-label="Primary"
      >
        {primary.map((item) => (
          <NavLink
            className={({ isActive }) =>
              cn(
                buttonVariants({ variant: isActive ? "default" : "ghost" }),
                "h-auto min-h-14 rounded-none px-1 text-xs",
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
