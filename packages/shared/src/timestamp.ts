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

/**
 * Horodatage epoch-ms (entier) des mutations de domaine : base de temps du
 * curseur de delta sync (`articles/feeds/folders.updated_at`, `tombstones.deleted_at` ;
 * ADR 0018). Centralisé ici, à côté de `sqlUtcNow`, pour que tous les sites de
 * bump partagent une source unique — un seul endroit à changer pour rendre
 * l'horloge injectable/testable, sans risquer qu'un site drifte vers un autre
 * format ou une autre base de temps.
 */
export function nowEpochMs(): number {
  return Date.now();
}
