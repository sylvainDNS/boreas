import { parseHTML } from "linkedom";

/**
 * Flux candidat découvert dans le HTML d'une page de site (#12). `title` est
 * l'attribut `title` du `<link>` quand le site le fournit (sert d'étiquette dans
 * le sélecteur multi-flux du SPA), sinon `null`.
 */
export interface DiscoveredFeed {
  /** URL absolue du flux, résolue contre l'URL de la page. */
  url: string;
  title: string | null;
  type: "rss" | "atom";
}

// Types MIME des `<link rel="alternate">` reconnus comme flux, mappés vers la
// famille exposée au SPA. On s'en tient strictement à RSS/Atom (l'issue #12) :
// `application/xml` / `text/xml` génériques sont trop ambigus pour distinguer un
// flux d'une autre ressource XML, on ne les retient pas.
const FEED_TYPES: Record<string, "rss" | "atom"> = {
  "application/rss+xml": "rss",
  "application/atom+xml": "atom",
};

/**
 * Découvre les flux annoncés par une page de site via ses balises
 * `<link rel="alternate" type="application/rss+xml|atom+xml" href="...">`
 * (auto-découverte, #12). Pur et synchrone.
 *
 * - `rel` est traité jeton par jeton, insensible à la casse (`rel` peut contenir
 *   plusieurs valeurs, ex. `"alternate home"`).
 * - `href` est résolu en URL absolue contre `siteUrl` ; les liens sans `href`,
 *   invalides, ou non-http(s) sont ignorés (garde anti-SSRF cohérente avec le
 *   fetch d'ingestion).
 * - Dédoublonnage par URL résolue (premier `<link>` gagnant), ordre du document
 *   conservé — le SPA présente les candidats dans l'ordre où le site les déclare.
 *
 * Renvoie `[]` quand la page n'expose aucun flux (cas 0 candidat).
 */
export function discoverFeeds(html: string, siteUrl: string): DiscoveredFeed[] {
  const { document } = parseHTML(html);
  const found: DiscoveredFeed[] = [];
  const seen = new Set<string>();

  for (const link of document.querySelectorAll("link")) {
    const rel = link.getAttribute("rel")?.toLowerCase() ?? "";
    if (!rel.split(/\s+/).includes("alternate")) continue;

    const mime = link.getAttribute("type")?.trim().toLowerCase() ?? "";
    const type = FEED_TYPES[mime];
    if (!type) continue;

    const href = link.getAttribute("href")?.trim();
    if (!href) continue;

    let resolved: URL;
    try {
      resolved = new URL(href, siteUrl);
    } catch {
      continue; // href non résoluble (ni absolu, ni base valide)
    }
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") {
      continue;
    }

    const url = resolved.toString();
    if (seen.has(url)) continue;
    seen.add(url);

    const title = link.getAttribute("title")?.trim();
    found.push({ url, title: title || null, type });
  }

  return found;
}
