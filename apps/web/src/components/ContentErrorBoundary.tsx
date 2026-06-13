import { Component, type ReactNode } from "react";

/**
 * Isole le rendu du contenu d'article : si le pipeline de coloration (`ArticleContent`,
 * ADR 0017) échoue — exception au rendu, ou chunk lazy injoignable — on retombe sur
 * `fallback` au lieu de faire planter tout le lecteur. Restaure la garantie de l'ancien
 * `dangerouslySetInnerHTML` : un article s'affiche toujours, au pire sans coloration.
 */
export class ContentErrorBoundary extends Component<
  { fallback: ReactNode; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
