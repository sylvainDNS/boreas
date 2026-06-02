/** Marque Boréas (pastille « B » + nom). Source unique pour la sidebar,
 *  l'en-tête mobile et la page de connexion. */
export function BrandLogo({
  markClassName = "size-8",
  labelClassName = "text-lg",
}: {
  markClassName?: string;
  labelClassName?: string;
}) {
  return (
    <span className="flex items-center gap-2">
      <span
        className={`grid place-items-center rounded-card bg-accent font-semibold text-accent-fg ${markClassName}`}
      >
        B
      </span>
      <span className={`font-semibold ${labelClassName}`}>Boréas</span>
    </span>
  );
}
