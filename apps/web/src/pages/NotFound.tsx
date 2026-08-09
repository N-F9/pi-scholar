import { Link } from "react-router-dom";
import { StateView } from "../components/ui";

export function NotFoundPage() {
  return (
    <StateView title="Page not found">
      <p>The address does not match a Pi Scholar page.</p>
      <Link className="mt-4 inline-block font-bold underline decoration-accent decoration-2 underline-offset-4" to="/">
        Return to Today
      </Link>
    </StateView>
  );
}
