import { decodeHTML } from "entities";
import { XMLParser } from "fast-xml-parser";

/**
 * Média joint à un Article (podcast, image…), conservé en métadonnée (#6) :
 * ni téléchargé ni proxifié ici. RSS l'expose via `<enclosure>`, Atom via
 * `<link rel="enclosure">`.
 */
export interface FeedEnclosure {
  url: string;
  type?: string;
  length?: number;
}

/**
 * Item de flux normalisé. Sur-ensemble structurel de `ArticleItem`
 * (article-identity.ts) : peut être passé tel quel à `articleKey()`.
 */
export interface ParsedItem {
  /** guid RSS ou id Atom (sert à la clé de dédup). */
  guid: string | null;
  /** URL de l'article. */
  link: string | null;
  title: string | null;
  /** Contenu brut fourni par le flux (content:encoded / description / content). */
  content: string | null;
  /** Résumé texte (balises retirées, tronqué) pour l'affichage en #6. */
  summary: string | null;
  /** Date de publication ISO 8601 UTC, ou null si absente/illisible. */
  publishedAt: string | null;
  enclosures: FeedEnclosure[];
}

export interface ParsedFeed {
  title: string | null;
  items: ParsedItem[];
}

const SUMMARY_MAX = 280;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  trimValues: true,
  // Garder les valeurs en chaînes : évite de transformer un guid « 123 » en
  // nombre ou de mutiler une date.
  parseTagValue: false,
  parseAttributeValue: false,
  processEntities: true,
});

/**
 * Parse un flux RSS ou Atom à partir de ses octets bruts.
 *
 * Détection d'encodage en cascade (issue #6) :
 *   Content-Type charset → déclaration `<?xml encoding>` → BOM → UTF-8.
 * Le décodage final passe par `TextDecoder` (gère latin-1, windows-1252…).
 *
 * Renvoie toujours un `ParsedFeed` ; un document illisible ou non reconnu
 * donne `{ title: null, items: [] }` (l'appelant décide quoi en faire).
 */
export function parseFeed(
  bytes: Uint8Array,
  contentType?: string | null,
): ParsedFeed {
  const xml = decodeXml(bytes, contentType);

  let doc: Record<string, unknown>;
  try {
    doc = parser.parse(xml) as Record<string, unknown>;
  } catch {
    return { title: null, items: [] };
  }

  // RSS 2.0 / 0.9x : <rss><channel>…<item>
  const rss = doc.rss as Record<string, unknown> | undefined;
  if (rss?.channel) {
    const channel = first(rss.channel) as Record<string, unknown>;
    return {
      title: decodeEntities(textOf(channel.title)),
      items: asRecords(channel.item).map(parseRssItem),
    };
  }

  // Atom : <feed>…<entry>
  const feed = doc.feed as Record<string, unknown> | undefined;
  if (feed) {
    return {
      title: decodeEntities(textOf(feed.title)),
      items: asRecords(feed.entry).map(parseAtomEntry),
    };
  }

  // RSS 1.0 (RDF) : <rdf:RDF><channel> + <item> frères
  const rdf = doc["rdf:RDF"] as Record<string, unknown> | undefined;
  if (rdf) {
    const channel = first(rdf.channel) as Record<string, unknown> | undefined;
    return {
      title: decodeEntities(textOf(channel?.title)),
      items: asRecords(rdf.item).map(parseRssItem),
    };
  }

  return { title: null, items: [] };
}

// --- Extraction par format ---------------------------------------------------

function parseRssItem(item: Record<string, unknown>): ParsedItem {
  const content =
    textOf(item["content:encoded"]) ?? textOf(item.description) ?? null;
  return {
    guid: textOf(item.guid),
    link: textOf(item.link),
    title: decodeEntities(textOf(item.title)),
    content,
    summary: stripToSummary(content),
    publishedAt: toUtcIso(textOf(item.pubDate) ?? textOf(item["dc:date"])),
    enclosures: asArray(item.enclosure)
      .map(rssEnclosure)
      .filter((e): e is FeedEnclosure => e !== null),
  };
}

function parseAtomEntry(entry: Record<string, unknown>): ParsedItem {
  const links = asArray(entry.link);
  const content = textOf(entry.content) ?? textOf(entry.summary) ?? null;
  return {
    guid: textOf(entry.id),
    link: atomAlternateLink(links),
    title: decodeEntities(textOf(entry.title)),
    content,
    summary: stripToSummary(content),
    publishedAt: toUtcIso(textOf(entry.published) ?? textOf(entry.updated)),
    enclosures: links
      .filter((l) => attrOf(l, "rel") === "enclosure")
      .map(atomEnclosure)
      .filter((e): e is FeedEnclosure => e !== null),
  };
}

function atomAlternateLink(links: unknown[]): string | null {
  // Préfère rel="alternate" (ou rel absent) ; ignore self/enclosure.
  const preferred =
    links.find((l) => {
      const rel = attrOf(l, "rel");
      return rel === "alternate" || rel === null;
    }) ??
    links.find((l) => {
      const rel = attrOf(l, "rel");
      return rel !== "self" && rel !== "enclosure";
    });
  if (preferred) return attrOf(preferred, "href") ?? textOf(preferred);
  return links.length > 0 ? textOf(links[0]) : null;
}

function rssEnclosure(node: unknown): FeedEnclosure | null {
  return toEnclosure(attrOf(node, "url"), node);
}

function atomEnclosure(node: unknown): FeedEnclosure | null {
  return toEnclosure(attrOf(node, "href"), node);
}

function toEnclosure(url: string | null, node: unknown): FeedEnclosure | null {
  if (!url) return null;
  const enclosure: FeedEnclosure = { url };
  const type = attrOf(node, "type");
  if (type) enclosure.type = type;
  const lengthRaw = attrOf(node, "length");
  if (lengthRaw && /^\d+$/.test(lengthRaw)) {
    enclosure.length = Number(lengthRaw);
  }
  return enclosure;
}

// --- Décodage / encodage -----------------------------------------------------

const WINDOWS_1252_LABELS = new Set([
  "windows-1252",
  "cp1252",
  "x-cp1252",
  "win1252",
  "1252",
  "ansi",
]);

function decodeXml(bytes: Uint8Array, contentType?: string | null): string {
  const label = detectEncoding(bytes, contentType).toLowerCase();
  // windows-1252 est décodé en propre : certains runtimes (Node small-ICU)
  // le ramènent à latin-1 et perdent €, guillemets typographiques, etc.
  if (WINDOWS_1252_LABELS.has(label)) {
    return decodeWindows1252(bytes);
  }
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    // Étiquette inconnue du runtime → repli UTF-8.
    return new TextDecoder("utf-8").decode(bytes);
  }
}

// Spécificités windows-1252 sur 0x80–0x9F (le reste est identique à latin-1).
// Les positions non définies (0x81, 0x8D, 0x8F, 0x90, 0x9D) gardent l'octet.
const CP1252_HIGH: Record<number, number> = {
  128: 0x20ac,
  130: 0x201a,
  131: 0x0192,
  132: 0x201e,
  133: 0x2026,
  134: 0x2020,
  135: 0x2021,
  136: 0x02c6,
  137: 0x2030,
  138: 0x0160,
  139: 0x2039,
  140: 0x0152,
  142: 0x017d,
  145: 0x2018,
  146: 0x2019,
  147: 0x201c,
  148: 0x201d,
  149: 0x2022,
  150: 0x2013,
  151: 0x2014,
  152: 0x02dc,
  153: 0x2122,
  154: 0x0161,
  155: 0x203a,
  156: 0x0153,
  158: 0x017e,
  159: 0x0178,
};

function decodeWindows1252(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) {
    out += String.fromCodePoint(CP1252_HIGH[byte] ?? byte);
  }
  return out;
}

function detectEncoding(
  bytes: Uint8Array,
  contentType?: string | null,
): string {
  // 1. charset du Content-Type.
  const ct = (contentType ?? "").toLowerCase();
  const charset = ct.match(/charset\s*=\s*"?([^";]+)"?/);
  if (charset?.[1]) return charset[1].trim();

  // 2. déclaration <?xml … encoding="…"?> (lue en latin1, ASCII-compatible).
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 512));
  const declared = head.match(/<\?xml[^>]*encoding\s*=\s*["']([^"']+)["']/i);
  if (declared?.[1]) return declared[1].trim();

  // 3. BOM.
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return "utf-8";
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return "utf-16le";
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return "utf-16be";

  // 4. défaut.
  return "utf-8";
}

// --- Normalisation des dates -------------------------------------------------

/**
 * Normalise une date RSS (RFC 822) ou Atom (RFC 3339) en ISO 8601 UTC.
 * Renvoie `null` si absente ou non parsable. Les dates futures sont conservées
 * telles quelles : le tri de la liste se fait sur `fetched_at`, pas dessus.
 */
function toUtcIso(raw: string | null): string | null {
  if (!raw) return null;
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toISOString();
}

// --- Helpers de lecture XML --------------------------------------------------

function asArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/** Comme `asArray`, mais ne garde que les nœuds objets (item/entry). */
function asRecords(value: unknown): Record<string, unknown>[] {
  return asArray(value).filter(
    (node): node is Record<string, unknown> =>
      typeof node === "object" && node !== null,
  );
}

function first(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : value;
}

/** Texte d'un nœud : chaîne directe, `#text` (attributs/CDATA), ou null. */
function textOf(node: unknown): string | null {
  if (node === null || node === undefined) return null;
  if (typeof node === "string") return node.trim() || null;
  if (typeof node === "number" || typeof node === "boolean") {
    return String(node);
  }
  if (typeof node === "object") {
    const text = (node as Record<string, unknown>)["#text"];
    if (text !== undefined) return textOf(text);
  }
  return null;
}

/** Valeur d'un attribut `@_name` d'un nœud, ou null. */
function attrOf(node: unknown, name: string): string | null {
  if (node && typeof node === "object") {
    const value = (node as Record<string, unknown>)[`@_${name}`];
    if (value !== undefined && value !== null) {
      return String(value).trim() || null;
    }
  }
  return null;
}

/**
 * Décode les entités HTML (numériques `&#8217;` et nommées `&eacute;`) d'un
 * texte. fast-xml-parser ne décode que les 5 entités XML standard : titres et
 * résumés doivent être décodés explicitement, comme le corps l'est via linkedom
 * (sinon les flux WordPress affichent `caf&eacute;` / `&#038;`).
 * Ne pas appliquer aux URLs (`&copy=…` deviendrait `©=…`).
 */
function decodeEntities(value: string | null): string | null {
  return value === null ? null : decodeHTML(value);
}

/** Réduit un contenu HTML à un résumé texte tronqué. */
function stripToSummary(html: string | null): string | null {
  if (!html) return null;
  // Retire les balises d'abord, puis décode les entités (collapse `&nbsp;`
  // (U+00A0) et les autres blancs en espace simple via \s).
  const text = decodeHTML(html.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;
  if (text.length <= SUMMARY_MAX) return text;
  return `${text.slice(0, SUMMARY_MAX).trimEnd()}…`;
}
