import type { Plugin } from "vite";

const isSourcemapOutsidePackageWarning = (msg: string): boolean =>
  msg.includes("Sourcemap for") &&
  msg.includes("points to a source file outside its package");

/**
 * Masque les warnings « Sourcemap ... points to a source file outside its
 * package ». Ils proviennent des dépendances de linkedom (css-select,
 * domutils, entities, nth-check) qui publient des sourcemaps pointant vers des
 * chemins hors de leur package npm : bénins, mais ils polluent la sortie des
 * tests.
 *
 * Vitest écrase `config.customLogger` avec le sien, donc l'option de config est
 * sans effet. On patche plutôt le logger résolu dans `configResolved`, hook qui
 * s'exécute après que Vitest a posé son logger.
 */
export function silenceSourcemapWarnings(): Plugin {
  return {
    name: "boreas:silence-sourcemap-warnings",
    configResolved(config) {
      const { logger } = config;
      const originalWarnOnce = logger.warnOnce.bind(logger);
      const originalWarn = logger.warn.bind(logger);
      logger.warnOnce = (msg, options) => {
        if (isSourcemapOutsidePackageWarning(msg)) return;
        originalWarnOnce(msg, options);
      };
      logger.warn = (msg, options) => {
        if (isSourcemapOutsidePackageWarning(msg)) return;
        originalWarn(msg, options);
      };
    },
  };
}
