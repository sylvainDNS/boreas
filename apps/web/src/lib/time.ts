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
 */
export function formatRelativeTime(iso: string | null | undefined): string {
  if (!iso) return "récemment";
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "récemment";

  let duration = (ms - Date.now()) / 1000; // secondes ; négatif = passé
  for (const division of DIVISIONS) {
    if (Math.abs(duration) < division.amount) {
      return rtf.format(Math.round(duration), division.unit);
    }
    duration /= division.amount;
  }
  return "récemment";
}
