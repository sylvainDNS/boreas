import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { UnreadDot } from "./Badge";

describe("UnreadDot", () => {
  it("ne rend rien quand il n'y a pas de non-lus", () => {
    const { container } = render(<UnreadDot hasUnread={false} />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByLabelText("non lu")).toBeNull();
  });

  it("rend un point étiqueté « non lu » quand il y a des non-lus", () => {
    render(<UnreadDot hasUnread />);
    expect(screen.getByLabelText("non lu")).toBeInTheDocument();
  });
});
