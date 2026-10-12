import assert from "node:assert/strict";
import { cleanup, fireEvent, render } from "@testing-library/react";
import Modal from "../src/components/Modal";
import { TestIntlProvider } from "./helpers/intl";

afterEach(() => cleanup());

// task #20 follow-up (Artea): in the forward composer, pressing Escape to close
// the @mention list closed the whole forward dialog and dropped the note. The
// mention list already marks its Escape with preventDefault; Modal now leaves
// such an Escape to the child that handled it.

function renderModal(props: { closeOnEscape?: boolean } = {}) {
  let closed = 0;
  const view = render(
    <TestIntlProvider>
      <Modal onClose={() => { closed += 1; }} {...props}>
        <input
          data-testid="field"
          onKeyDown={(e) => {
            if (e.key === "Escape" && e.currentTarget.dataset.popupOpen === "1") e.preventDefault();
          }}
        />
      </Modal>
    </TestIntlProvider>,
  );
  const field = view.getByTestId("field") as HTMLInputElement;
  return { field, closed: () => closed };
}

test("Escape closes the modal when nothing inside handled it", () => {
  const { field, closed } = renderModal();
  fireEvent.keyDown(field, { key: "Escape" });
  assert.equal(closed(), 1);
});

test("Escape handled by a child (preventDefault) leaves the modal open", () => {
  const { field, closed } = renderModal();
  field.dataset.popupOpen = "1";
  fireEvent.keyDown(field, { key: "Escape" });
  assert.equal(closed(), 0, "the child's Escape must not close the modal");
  field.dataset.popupOpen = "0";
  fireEvent.keyDown(field, { key: "Escape" });
  assert.equal(closed(), 1, "the next, unhandled Escape still closes it");
});

test("closeOnEscape={false} never closes on Escape", () => {
  const { field, closed } = renderModal({ closeOnEscape: false });
  fireEvent.keyDown(field, { key: "Escape" });
  assert.equal(closed(), 0);
});
