import assert from "node:assert/strict";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "./helpers/domSetup";
import { TestIntlProvider } from "./helpers/intl";
import { RuntimeFormV2ChoiceCombobox, runtimeChoiceMatches } from "../src/components/agent/RuntimeChoiceCombobox";
import type { RuntimeOption } from "../src/components/agent/RuntimeConfigFields";

const MODELS: RuntimeOption[] = [
  { value: "openai/gpt-6.1-sol", label: "GPT 6.1 Sol" },
  { value: "deepseek/deepseek-flash", label: "DeepSeek V4.1 Flash" },
  { value: "bare-id", label: "bare-id" },
];

function renderField(props: { value?: string; allowCustom?: boolean; customValue?: boolean; onChange?: (next: string, custom: boolean) => void; emptyOption?: RuntimeOption } = {}) {
  return render(
    <TestIntlProvider>
      <RuntimeFormV2ChoiceCombobox
        common={{ label: "Model", required: true }}
        options={MODELS}
        value={props.value ?? ""}
        onValueChange={props.onChange ?? (() => {})}
        emptyOption={props.emptyOption}
        allowCustom={props.allowCustom ?? false}
        customValue={props.customValue}
        placeholder="Model"
        testId="model"
      />
    </TestIntlProvider>,
  );
}

afterEach(() => cleanup());

test("search matches the name, the stored id and the group", () => {
  assert.equal(runtimeChoiceMatches(MODELS[0]!, "sol"), true);
  assert.equal(runtimeChoiceMatches(MODELS[0]!, "OPENAI/gpt"), true);
  assert.equal(runtimeChoiceMatches({ ...MODELS[1]!, group: "Exe Dev" }, "exe"), true);
  assert.equal(runtimeChoiceMatches(MODELS[1]!, "sol"), false);
});

test("each word of the search must match somewhere, in any order", () => {
  assert.equal(runtimeChoiceMatches(MODELS[0]!, "gpt sol"), true);
  assert.equal(runtimeChoiceMatches(MODELS[0]!, "sol  openai"), true);
  assert.equal(runtimeChoiceMatches(MODELS[0]!, "gpt flash"), false);
});

test("typing filters the list; the field shows the selected name, and the stored value is the id", () => {
  let saved = "";
  renderField({ onChange: (next) => { saved = next; } });
  const input = screen.getByTestId("model") as HTMLInputElement;
  fireEvent.change(input, { target: { value: "flash" } });
  assert.equal(screen.queryAllByRole("option").length, 1);
  const option = screen.getByRole("option", { name: "DeepSeek V4.1 Flash" });
  assert.ok(option.textContent?.includes("deepseek/deepseek-flash"), "the id is shown under the name");
  fireEvent.click(option);
  assert.equal(saved, "deepseek/deepseek-flash");
});

test("a field without custom values never offers the typed text", () => {
  renderField();
  fireEvent.change(screen.getByTestId("model"), { target: { value: "my-org/other" } });
  assert.equal(screen.queryAllByTestId("model-use-custom").length, 0);
});

test("a custom value field offers the typed text and stores it as typed", () => {
  const saved: Array<[string, boolean]> = [];
  renderField({ allowCustom: true, onChange: (next, custom) => { saved.push([next, custom]); } });
  fireEvent.change(screen.getByTestId("model"), { target: { value: "my-org/other" } });
  fireEvent.click(screen.getByTestId("model-use-custom"));
  fireEvent.change(screen.getByTestId("model"), { target: { value: "sol" } });
  fireEvent.click(screen.getByRole("option", { name: "GPT 6.1 Sol" }));
  assert.deepEqual(saved, [["my-org/other", true], ["openai/gpt-6.1-sol", false]]);
});

test("a typed custom value reads as custom, not as a choice that went missing", () => {
  renderField({ allowCustom: true, customValue: true, value: "my-org/other" });
  const input = screen.getByTestId("model") as HTMLInputElement;
  assert.equal(input.value, "my-org/other");
  assert.equal(screen.queryAllByTestId("model-unlisted").length, 0);
  fireEvent.focus(input);
  fireEvent.keyDown(input, { key: "ArrowDown" });
  screen.getByRole("option", { name: /my-org\/other.*Custom/ });
});

test("a saved value that is not listed stays as the field's value and says so", () => {
  renderField({ value: "deepseek/deepseek-v4-flash" });
  assert.equal((screen.getByTestId("model") as HTMLInputElement).value, "deepseek/deepseek-v4-flash");
  screen.getByTestId("model-unlisted");
});

test("an optional field's default choice is stored as empty", () => {
  let saved = "x";
  renderField({ emptyOption: { value: "__default__", label: "Runtime default" }, value: "bare-id", onChange: (next) => { saved = next; } });
  const input = screen.getByTestId("model");
  fireEvent.focus(input);
  fireEvent.keyDown(input, { key: "ArrowDown" });
  fireEvent.click(screen.getByRole("option", { name: "Runtime default" }));
  assert.equal(saved, "");
});

test("the runtime form's model field: a listed pick clears custom mode, a typed model sets it", async () => {
  const { default: RuntimeConfigFields } = await import("../src/components/agent/RuntimeConfigFields");
  const calls: string[] = [];
  render(
    <TestIntlProvider locale="en">
      <RuntimeConfigFields
        runtime="claude"
        onRuntimeChange={() => undefined}
        runtimeOptions={[{ value: "claude", label: "Claude Code" }]}
        model="opus"
        onModelChange={(next) => calls.push(`model:${next}`)}
        customModelMode={false}
        onCustomModelModeChange={(custom) => calls.push(`custom:${custom}`)}
        modelOptions={[{ value: "opus", label: "Claude Opus" }, { value: "sonnet", label: "Claude Sonnet" }]}
        runtimeModels={{ source: { kind: "unsupported" }, models: [], loading: false, rescan: () => undefined }}
        providerMode="default"
        onProviderModeChange={() => undefined}
        providerApiUrl=""
        onProviderApiUrlChange={() => undefined}
        providerApiKey=""
        onProviderApiKeyChange={() => undefined}
        builtInProviderMode="deepseek"
        onBuiltInProviderModeChange={() => undefined}
        piProviderMode="configured"
        onPiProviderModeChange={() => undefined}
        piProviderApiKey=""
        onPiProviderApiKeyChange={() => undefined}
        reasoningEffort={null}
        onReasoningEffortChange={() => undefined}
        command=""
        onCommandChange={() => undefined}
        envVarEntries={[]}
        onEnvVarEntriesChange={() => undefined}
      />
    </TestIntlProvider>,
  );
  const box = screen.getByTestId("runtime-model-combobox") as HTMLInputElement;
  assert.equal(box.value, "Claude Opus");
  fireEvent.change(box, { target: { value: "claude sonnet" } });
  fireEvent.click(screen.getByRole("option", { name: "Claude Sonnet" }));
  fireEvent.change(box, { target: { value: "claude-next-preview" } });
  fireEvent.click(screen.getByTestId("runtime-model-combobox-use-custom"));
  assert.deepEqual(calls, ["custom:false", "model:sonnet", "custom:true", "model:claude-next-preview"]);
});
