import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import {
  ARTICLES_COUNTS_KEY,
  ARTICLES_LIST_KEY,
  SEARCH_QUERY_KEY,
} from "../articles";
import { syncReplica } from "./replica";

/**
 * Intervalle de sync léger au premier plan (#72, ADR 0018). **Remplace** le poll
 * 60 s des listes : c'est désormais le moteur de sync qui fait remonter les
 * articles ingérés en arrière-plan, et toutes les vues lisent le réplica (#73).
 */
export const SYNC_INTERVAL_MS = 60_000;

/**
 * Câble les déclencheurs de sync du réplica (ADR 0018) : **montage** (premier
 * chargement en ligne), **focus** de l'onglet, event **`online`** (reconnexion),
 * et **intervalle léger** au premier plan. Après chaque passe réussie, invalide
 * **toutes** les listes local-first (#73) ET les compteurs locaux, pour que les
 * vues relisent le réplica fraîchement mis à jour (nouveaux articles serveur, et
 * compteurs exacts après sync).
 *
 * Un échec de sync (hors-ligne) est avalé : la vue continue d'afficher le
 * réplica déjà chargé (lecture locale, jamais bloquée par le réseau).
 */
export function useReplicaSync(): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    let cancelled = false;

    const refreshAfterSync = async () => {
      try {
        await syncReplica();
        if (cancelled) return;
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ARTICLES_LIST_KEY }),
          queryClient.invalidateQueries({ queryKey: ARTICLES_COUNTS_KEY }),
          queryClient.invalidateQueries({ queryKey: SEARCH_QUERY_KEY }),
        ]);
      } catch {
        // Hors-ligne ou erreur réseau : on garde l'affichage du réplica local.
      }
    };

    void refreshAfterSync();

    const onFocus = () => void refreshAfterSync();
    const onOnline = () => void refreshAfterSync();
    window.addEventListener("focus", onFocus);
    window.addEventListener("online", onOnline);
    const interval = window.setInterval(
      () => void refreshAfterSync(),
      SYNC_INTERVAL_MS,
    );

    return () => {
      cancelled = true;
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("online", onOnline);
      window.clearInterval(interval);
    };
  }, [queryClient]);
}
