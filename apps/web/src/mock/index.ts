// Données factices pour peupler le shell de #4 (revue de design).
// Remplacées par les vraies données via l'API au fil des tranches #6+.

export interface MockFeed {
  id: string;
  name: string;
  unread: number;
}

export interface MockFolder {
  id: string;
  name: string;
  feeds: MockFeed[];
}

export interface MockArticle {
  id: string;
  /** Identifiant du Feed source (jointure stable, contrairement au nom). */
  feedId: string;
  feedName: string;
  title: string;
  excerpt: string;
  time: string;
  unread: boolean;
  saved: boolean;
}

export const folders: MockFolder[] = [
  {
    id: "tech",
    name: "Tech & Dev",
    feeds: [
      { id: "verge", name: "The Verge", unread: 12 },
      { id: "hn", name: "Hacker News", unread: 47 },
      { id: "css", name: "CSS-Tricks", unread: 3 },
    ],
  },
  {
    id: "actu",
    name: "Actualité",
    feeds: [
      { id: "lemonde", name: "Le Monde", unread: 8 },
      { id: "mediapart", name: "Mediapart", unread: 0 },
    ],
  },
  {
    id: "perso",
    name: "Blogs perso",
    feeds: [
      { id: "fabrice", name: "Fabrice Bellard", unread: 1 },
      { id: "danluu", name: "Dan Luu", unread: 2 },
    ],
  },
];

export const totalUnread = folders.reduce(
  (sum, f) => sum + f.feeds.reduce((s, feed) => s + feed.unread, 0),
  0,
);

export const articles: MockArticle[] = [
  {
    id: "a1",
    feedId: "verge",
    feedName: "The Verge",
    title: "Le futur des navigateurs web est en train de se réécrire",
    excerpt:
      "Entre moteurs de rendu alternatifs et intégrations d'IA locales, les éditeurs repensent ce qu'est un navigateur en 2026.",
    time: "il y a 14 min",
    unread: true,
    saved: false,
  },
  {
    id: "a2",
    feedId: "hn",
    feedName: "Hacker News",
    title: "Show HN : un lecteur RSS qui tient entièrement sur Cloudflare",
    excerpt:
      "Workers, D1, R2 et Queues pour un coût quasi nul. Retour d'expérience après six mois en production.",
    time: "il y a 38 min",
    unread: true,
    saved: false,
  },
  {
    id: "a3",
    feedId: "danluu",
    feedName: "Dan Luu",
    title:
      "Pourquoi les interfaces lentes nous coûtent plus cher qu'on ne croit",
    excerpt:
      "Une analyse chiffrée de la latence perçue et de son effet cumulé sur la productivité d'une journée de travail.",
    time: "il y a 2 h",
    unread: true,
    saved: false,
  },
  {
    id: "a4",
    feedId: "lemonde",
    feedName: "Le Monde",
    title: "Climat : les engagements 2030 revus à la hausse",
    excerpt:
      "Les nouvelles trajectoires d'émissions présentées cette semaine marquent une inflexion notable.",
    time: "il y a 3 h",
    unread: true,
    saved: false,
  },
  {
    id: "a5",
    feedId: "css",
    feedName: "CSS-Tricks",
    title: "Maîtriser oklch() pour des palettes cohérentes en clair et sombre",
    excerpt:
      "Pourquoi raisonner en luminance perceptuelle change la façon de construire un système de couleurs.",
    time: "il y a 5 h",
    unread: false,
    saved: false,
  },
  {
    id: "a6",
    feedId: "fabrice",
    feedName: "Fabrice Bellard",
    title: "Un compresseur d'images neuronal en moins de 200 ko",
    excerpt:
      "Démonstration d'un modèle minimal embarquable directement dans le navigateur.",
    time: "hier",
    unread: false,
    saved: true,
  },
];

export const articleBody: string[] = [
  "J'ai longtemps cherché un lecteur RSS qui ne dépende d'aucun service tiers, sans abonnement mensuel, et qui reste sous mon contrôle. La plupart des solutions auto-hébergées demandent un serveur à maintenir — exactement ce que je voulais éviter.",
  "L'idée : tout faire tenir sur la plateforme Cloudflare. Le SPA est servi par Pages, l'API tourne sur un Worker, l'ingestion des flux passe par un Cron déclenchant des Queues, le tout stocké dans D1 pour les métadonnées et R2 pour le contenu extrait et les images.",
  "Le point le plus délicat fut l'extraction du contenu complet : chaque article est nettoyé puis archivé dès son arrivée, afin qu'il reste lisible même si la source disparaît. Les images sont reproxifiées et signées pour préserver la vie privée.",
  "Six mois plus tard, l'ensemble tourne sans intervention. Le backoff sur les flux défaillants évite de gaspiller des ressources, et la purge à 60 jours garde la base légère.",
];

// --- Sélecteurs : jointure article↔feed par `feedId` (jamais par le nom).
// Source unique de la logique de filtrage, partagée par les routes. À remplacer
// par les requêtes API au fil des tranches #6+.

export const unreadArticles = (): MockArticle[] =>
  articles.filter((a) => a.unread);

export const savedArticles = (): MockArticle[] =>
  articles.filter((a) => a.saved);

export const feedById = (feedId: string): MockFeed | undefined =>
  folders.flatMap((f) => f.feeds).find((f) => f.id === feedId);

export const folderById = (folderId: string): MockFolder | undefined =>
  folders.find((f) => f.id === folderId);

export const articlesByFeed = (feedId: string): MockArticle[] =>
  articles.filter((a) => a.feedId === feedId);

export const articlesByFolder = (folderId: string): MockArticle[] => {
  const feedIds = new Set(folderById(folderId)?.feeds.map((f) => f.id));
  return articles.filter((a) => feedIds.has(a.feedId));
};
