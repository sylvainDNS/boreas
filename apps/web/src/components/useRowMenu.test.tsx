import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useRowMenu } from "./useRowMenu";

describe("useRowMenu", () => {
  it("openAt ouvre le menu aux coordonnées viewport fournies (#120)", () => {
    const { result } = renderHook(() => useRowMenu());

    expect(result.current.isOpen).toBe(false);
    expect(result.current.position).toBeNull();

    act(() => result.current.openAt(10, 20));

    expect(result.current.isOpen).toBe(true);
    expect(result.current.position).toEqual({ x: 10, y: 20 });
  });

  it("close referme un menu ouvert par openAt", () => {
    const { result } = renderHook(() => useRowMenu());

    act(() => result.current.openAt(5, 5));
    expect(result.current.isOpen).toBe(true);

    act(() => result.current.close());
    expect(result.current.isOpen).toBe(false);
    expect(result.current.position).toBeNull();
  });
});
