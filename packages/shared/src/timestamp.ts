/**
 * Horodatage UTC au format de la valeur par défaut SQL des tables
 * (`strftime('%Y-%m-%dT%H:%M:%SZ', 'now')`, sans millisecondes).
 *
 * Les colonnes `fetched_at`/`created_at` peuvent être posées soit par ce code,
 * soit par le défaut SQL ; produire exactement le même format garantit un tri
 * lexical cohérent (la pagination keyset compare `fetched_at` en texte).
 */
export function sqlUtcNow(date: Date = new Date()): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}
