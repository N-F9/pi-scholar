import { Link } from "react-router-dom";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";

export function NotFoundPage() {
  return (
    <Empty role="status" className="items-start border border-border bg-card p-6 text-left">
      <EmptyHeader className="items-start">
        <EmptyTitle className="text-2xl font-semibold" role="heading" aria-level={2}>
          Page not found
        </EmptyTitle>
        <EmptyDescription className="mt-2 max-w-prose">The address does not match a Pi Scholar page.</EmptyDescription>
      </EmptyHeader>
      <EmptyContent className="mt-4 items-start">
        <Link className="font-bold underline decoration-primary decoration-2 underline-offset-4" to="/">
          Return to Today
        </Link>
      </EmptyContent>
    </Empty>
  );
}
