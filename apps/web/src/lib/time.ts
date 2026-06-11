const rtf = new Intl.RelativeTimeFormat("fr", { numeric: "auto" });

const DIVISIONS: { amount: number; unit: Intl.RelativeTimeFormatUnit }[] = [
  { amount: 60, unit: "second" },
  { amount: 60, unit: "minute" },
  { amount: 24, unit: "hour" },
  { amount: 7, unit: "day" },
  { amount: 4.34524, unit: "week" },
  { amount: 12, unit: "month" },
  { amount: Number.POSITIVE_INFINITY, unit: "year" },
];

/**
 * Met en forme une date ISO en libellé relatif français (« il y a 14 min »,
 * « hier »…). Repli « récemment » si la date est absente ou illisible — en #6,
 * la date de publication d'un flux peut manquer.
 *
 * Une date dans le futur (flux menteur ou décalage d'horloge) est plafonnée à
 * l'instant présent : on affiche « maintenant » plutôt que « dans 1 an ». C'est
 * un plafonnement **cosmétique** côté front ; le tri SQL conserve la date brute
 * (ADR 0015).
 */
export function formatRelativeTime(iso: string | null | undefined): string {
  if (!iso) return "récemment";
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "récemment";

  const now = Date.now();
  let duration = (Math.min(ms, now) - now) / 1000; // secondes ; négatif = passé
  for (const division of DIVISIONS) {
    if (Math.abs(duration) < division.amount) {
      return rtf.format(Math.round(duration), division.unit);
    }
    duration /= division.amount;
  }
  return "récemment";
}
