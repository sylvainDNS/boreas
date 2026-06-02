import type { ReactNode } from "react";

/** État vide réutilisable (lecteur sans sélection, vue sans articles…). */
export function EmptyState({
  icon = "📭",
  title,
  children,
}: {
  icon?: string;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="grid h-full place-items-center p-8 text-center">
      <div className="max-w-xs">
        <div className="mb-3 text-4xl" aria-hidden>
          {icon}
        </div>
        <p className="font-medium text-text">{title}</p>
        {children && <p className="mt-1 text-muted text-sm">{children}</p>}
      </div>
    </div>
  );
}
