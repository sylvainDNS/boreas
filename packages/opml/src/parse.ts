import { XMLParser } from "fast-xml-parser";

/**
 * Flux extrait d'un document OPML, prêt à être abonné. `folderName` traduit la
 * **hiérarchie OPML** : le conteneur immédiat (outline parent sans `xmlUrl`)
 * devient le Folder de rattachement (modèle Folder mono-niveau, #13). Un flux à
 * la racine du `<body>` n'a pas de Folder (`null`).
 */
export interface OpmlFeed {
  url: string;
  title: string | null;
  folderName: string | null;
}

// Config alignée sur le parser de flux (`feed-parser.ts`) : on garde les
// attributs (xmlUrl, text…), on ne convertit pas les valeurs en nombres et on
// décode les entités (&amp;…).
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  trimValues: true,
  parseTagValue: false,
  parseAttributeValue: false,
  processEntities: true,
});

/**
 * Forme brute d'un `<outline>` après parsing : ses attributs sont préfixés `@_`
 * et ses enfants `outline` peuvent être absents, un objet unique ou un tableau.
 */
interface RawOutline {
  "@_xmlUrl"?: string;
  "@_text"?: string;
  "@_title"?: string;
  outline?: RawOutline | RawOutline[];
}

/** Normalise un enfant `outline` (absent / objet / tableau) en tableau. */
function asOutlineArray(
  node: RawOutline | RawOutline[] | undefined,
): RawOutline[] {
  if (!node) return [];
  return Array.isArray(node) ? node : [node];
}

/** Libellé d'un conteneur : `text` puis repli sur `title`, sinon `null`. */
function outlineLabel(outline: RawOutline): string | null {
  const label = outline["@_text"] ?? outline["@_title"];
  const trimmed = label?.trim();
  return trimmed ? trimmed : null;
}

/** N'accepte que des URLs http(s) — écarte les xmlUrl vides ou exotiques. */
function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Parse un document OPML et en extrait la liste des flux, dédupliquée par URL
 * (première occurrence gagnante). La règle de hiérarchie ne descend que d'un
 * niveau : `folderName` est le libellé du **conteneur immédiat** ; toute
 * imbrication plus profonde est aplatie sur ce conteneur.
 *
 * Tolérant aux entrées malformées : un document illisible ou sans `<body>`
 * exploitable renvoie `{ feeds: [] }` (l'appelant décide quoi en faire).
 */
export function parseOpml(xml: string): { feeds: OpmlFeed[] } {
  let doc: { opml?: { body?: RawOutline } };
  try {
    doc = parser.parse(xml);
  } catch {
    return { feeds: [] };
  }

  const body = doc.opml?.body;
  if (!body) return { feeds: [] };

  const feeds: OpmlFeed[] = [];
  const seen = new Set<string>();

  const visit = (outline: RawOutline, folderName: string | null): void => {
    const xmlUrl = outline["@_xmlUrl"]?.trim();
    if (xmlUrl && isHttpUrl(xmlUrl)) {
      // Outline = flux. Dédup par URL au sein de l'OPML.
      if (!seen.has(xmlUrl)) {
        seen.add(xmlUrl);
        feeds.push({
          url: xmlUrl,
          title: outlineLabel(outline),
          folderName,
        });
      }
      return;
    }

    // Outline = conteneur (ou outline sans xmlUrl valide). Ses enfants directs
    // se rattachent à *ce* conteneur ; on ne descend pas le folderName plus bas
    // (un sous-conteneur redéfinit le rattachement de ses propres enfants).
    const label = outlineLabel(outline);
    for (const child of asOutlineArray(outline.outline)) {
      visit(child, label);
    }
  };

  // Les outlines de premier niveau n'ont pas de conteneur parent.
  for (const top of asOutlineArray(body.outline)) {
    visit(top, null);
  }

  return { feeds };
}
