import assert from "node:assert/strict";
import "./helpers/domSetup";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, test } from "vitest";
import PanelResizeHandle from "../src/components/ui/PanelResizeHandle";

afterEach(() => cleanup());

test("PanelResizeHandle straddles the named edge and appears from the named breakpoint", () => {
  render(
    <>
      <PanelResizeHandle side="right" visibleFrom="sm" data-testid="right-sm" />
      <PanelResizeHandle side="left" visibleFrom="md" data-testid="left-md" />
    </>,
  );
  const rightSm = screen.getByTestId("right-sm");
  const leftMd = screen.getByTestId("left-md");
  assert.ok(rightSm.classList.contains("-right-1") && !rightSm.classList.contains("-left-1"));
  assert.ok(leftMd.classList.contains("-left-1") && !leftMd.classList.contains("-right-1"));
  assert.ok(rightSm.classList.contains("hidden") && rightSm.classList.contains("sm:block") && !rightSm.classList.contains("md:block"));
  assert.ok(leftMd.classList.contains("hidden") && leftMd.classList.contains("md:block") && !leftMd.classList.contains("sm:block"));
  for (const handle of [rightSm, leftMd]) {
    assert.ok(handle.classList.contains("cursor-col-resize"));
    assert.equal(handle.querySelectorAll("span").length, 1, "one divider hairline");
  }
});

test("PanelResizeHandle forwards pointer handlers and double click to the grab strip", () => {
  const seen: string[] = [];
  render(
    <PanelResizeHandle
      side="left"
      visibleFrom="md"
      data-testid="handle"
      onPointerDown={() => seen.push("down")}
      onPointerMove={() => seen.push("move")}
      onPointerUp={() => seen.push("up")}
      onPointerCancel={() => seen.push("cancel")}
      onDoubleClick={() => seen.push("double")}
    />,
  );
  const handle = screen.getByTestId("handle");
  fireEvent.pointerDown(handle);
  fireEvent.pointerMove(handle);
  fireEvent.pointerUp(handle);
  fireEvent.pointerCancel(handle);
  fireEvent.doubleClick(handle);
  assert.deepEqual(seen, ["down", "move", "up", "cancel", "double"]);
});
