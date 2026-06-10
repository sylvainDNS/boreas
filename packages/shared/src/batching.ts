/**
 * Limites Cloudflare et découpage en lots, centralisés (#41). Seul propriétaire
 * des plafonds D1/R2 et de la logique de tranche : les call-sites (ingestion,
 * rétention, import OPML) dérivent leur taille de lot d'ici plutôt que de
 * redéfinir un nombre magique qui dépasserait silencieusement la limite.
 */

/** D1 plafonne une requête à 100 variables liées (paramètres bornés). */
export const D1_MAX_BOUND_PARAMS = 100;

/** R2 plafonne une suppression groupée à 1000 clés par appel `delete`. */
export const R2_DELETE_CHUNK = 1000;

/** Découpe un tableau en tranches de taille `size` (la dernière peut être partielle). */
export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/**
 * Nombre de lignes insérables par requête D1 sans dépasser la limite de
 * variables liées : `floor((100 - reserved) / colonnes par ligne)`. `reserved`
 * (défaut 1) laisse une marge pour d'éventuels paramètres hors-lignes.
 */
export function insertChunkSize(columnsPerRow: number, reserved = 1): number {
  return Math.floor((D1_MAX_BOUND_PARAMS - reserved) / columnsPerRow);
}

/**
 * Nombre de valeurs plaçables dans un `WHERE … IN (…)` sans dépasser la limite,
 * en réservant `reservedParams` variables pour le reste de la requête (ex. les
 * colonnes d'un `SET` sur un UPDATE).
 */
export function whereInChunkSize(reservedParams: number): number {
  return D1_MAX_BOUND_PARAMS - reservedParams;
}
