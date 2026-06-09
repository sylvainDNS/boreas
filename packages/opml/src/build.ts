import { XMLBuilder } from "fast-xml-parser";

/** Feed à exporter. `folderId` `null` = non classé (placé à la racine du body). */
export interface OpmlExportFeed {
  url: string;
  title: string | null;
  folderId: string | null;
}

/** Folder à exporter : devient un outline conteneur nommé. */
export interface OpmlExportFolder {
  id: string;
  name: string;
}

/** Outline sérialisé : attributs préfixés `@_`, enfants `outline` optionnels. */
interface OutlineNode {
  "@_text": string;
  "@_title": string;
  "@_type"?: string;
  "@_xmlUrl"?: string;
  outline?: OutlineNode[];
}

const builder = new XMLBuilder({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  format: true,
  suppressEmptyNode: true,
});

/** Outline d'un flux : `text`/`title` = titre (repli sur l'URL), `type="rss"`. */
function feedOutline(feed: OpmlExportFeed): OutlineNode {
  const label = feed.title ?? feed.url;
  return {
    "@_text": label,
    "@_title": label,
    "@_type": "rss",
    "@_xmlUrl": feed.url,
  };
}

/**
 * Construit un document OPML 2.0 à partir des Feeds et Folders. Les flux classés
 * sont regroupés sous l'outline conteneur de leur Folder ; les flux non classés
 * (et ceux dont le `folderId` ne correspond à aucun Folder fourni) sont placés à
 * la racine du `<body>`. Round-trip avec `parseOpml`.
 */
export function buildOpml(
  feeds: OpmlExportFeed[],
  folders: OpmlExportFolder[],
): string {
  const folderById = new Map(folders.map((f) => [f.id, f]));

  // Regroupe les flux par Folder existant ; le reste va à la racine.
  const byFolder = new Map<string, OpmlExportFeed[]>();
  const rootFeeds: OpmlExportFeed[] = [];
  for (const feed of feeds) {
    if (feed.folderId && folderById.has(feed.folderId)) {
      const bucket = byFolder.get(feed.folderId) ?? [];
      bucket.push(feed);
      byFolder.set(feed.folderId, bucket);
    } else {
      rootFeeds.push(feed);
    }
  }

  // Un outline conteneur par Folder, suivi des flux non classés à la racine. Un
  // Folder sans flux est exporté comme outline vide ; `parseOpml` n'en (re)crée
  // pas de Folder à l'import (il ne matérialise un Folder qu'à partir du
  // conteneur d'un flux) — un Folder vide ne survit donc pas à un aller-retour.
  const body: OutlineNode[] = [];
  for (const folder of folders) {
    body.push({
      "@_text": folder.name,
      "@_title": folder.name,
      outline: (byFolder.get(folder.id) ?? []).map(feedOutline),
    });
  }
  for (const feed of rootFeeds) {
    body.push(feedOutline(feed));
  }

  const xml = builder.build({
    opml: {
      "@_version": "2.0",
      head: { title: "Boréas" },
      body: { outline: body },
    },
  });

  return `<?xml version="1.0" encoding="UTF-8"?>\n${xml}`;
}
