import {
  type ButtonHTMLAttributes,
  cloneElement,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type ReactElement,
  type ReactNode,
  type TextareaHTMLAttributes,
  useId,
} from "react";

export function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "danger" | "quiet";
};

export function Button({ className, variant = "primary", type = "button", ...props }: ButtonProps) {
  const styles = {
    primary: "border-ink bg-ink text-paper hover:bg-accent hover:text-accent-ink hover:border-accent",
    secondary: "border-line bg-paper text-ink hover:border-ink",
    danger: "border-danger bg-danger text-paper hover:brightness-90",
    quiet: "border-transparent bg-transparent text-ink hover:bg-canvas",
  }[variant];

  return (
    <button
      className={cx(
        "inline-flex min-h-11 items-center justify-center rounded-md border px-4 py-2 text-sm font-bold transition-colors duration-200 ease-expo disabled:cursor-not-allowed disabled:opacity-50",
        styles,
        className,
      )}
      type={type}
      {...props}
    />
  );
}

export function Card({ className, ...props }: HTMLAttributes<HTMLElement>) {
  return (
    <section className={cx("rounded-lg border border-line bg-paper p-5 shadow-quiet sm:p-6", className)} {...props} />
  );
}

export function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "positive" | "caution" | "danger";
}) {
  const styles = {
    neutral: "border-line bg-canvas text-muted",
    positive: "border-positive/30 bg-positive/10 text-positive",
    caution: "border-caution/30 bg-caution/10 text-caution",
    danger: "border-danger/30 bg-danger/10 text-danger",
  }[tone];
  return (
    <span className={cx("inline-flex rounded-full border px-2.5 py-1 text-xs font-bold", styles)}>{children}</span>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactElement<{ id?: string }>;
}) {
  const generatedId = useId();
  const id = children.props.id ?? generatedId;
  return (
    <div className="grid gap-2 text-sm font-bold text-ink">
      <label htmlFor={id}>{label}</label>
      {cloneElement(children, { id })}
      {hint ? <span className="font-normal text-muted">{hint}</span> : null}
    </div>
  );
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cx("control", className)} />;
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={cx("control min-h-32 resize-y", className)} />;
}

export function StateView({
  title,
  children,
  tone = "neutral",
}: {
  title: string;
  children: ReactNode;
  tone?: "neutral" | "danger";
}) {
  return (
    <div
      className={cx("rounded-lg border bg-paper p-6", tone === "danger" ? "border-danger/40" : "border-line")}
      role={tone === "danger" ? "alert" : "status"}
    >
      <h2 className="font-serif text-2xl font-semibold">{title}</h2>
      <div className="mt-2 max-w-prose text-muted">{children}</div>
    </div>
  );
}

export function Spinner({ label = "Loading" }: { label?: string }) {
  return (
    <div className="flex min-h-40 items-center justify-center gap-3 text-muted" role="status">
      <span className="size-5 animate-spin rounded-full border-2 border-line border-t-ink" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}
