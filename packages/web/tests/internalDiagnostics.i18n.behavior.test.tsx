import assert from "node:assert/strict";
import "./helpers/domSetup";
import type { ReactElement } from "react";
import { cleanup, render } from "@testing-library/react";
import { useIntl } from "react-intl";

import { TestIntlProvider } from "./helpers/intl";
import { getEnvironmentLabelMessageId } from "../src/utils/devMode";
import { en as enMessages } from "../src/i18n/messages/en";
import { zhCn as zhMessages } from "../src/i18n/messages/zh-cn";

// Internal diagnostics (Task 6): reviewed findings migrate off baseline debt
// into catalog MessageIds. Environment badge labels must render through intl —
// deployment env *identifiers* (slockdev / staging / web-preview) stay
// untranslated.

const en = enMessages as Record<string, string>;
const zh = zhMessages as Record<string, string>;

const DIAGNOSTIC_IDS = [
  "env.badge.webPreview",
  "env.badge.dev",
  "env.badge.staging",
] as const;

const EN_VALUES: Record<(typeof DIAGNOSTIC_IDS)[number], string> = {
  "env.badge.webPreview": "Web Preview",
  "env.badge.dev": "Dev",
  "env.badge.staging": "Staging",
};

afterEach(() => {
  cleanup();
});

function renderZh(node: ReactElement) {
  return render(<TestIntlProvider locale="zh-cn">{node}</TestIntlProvider>);
}

test("catalog pins the environment-badge diagnostic MessageIds with preserved English meaning", () => {
  for (const id of DIAGNOSTIC_IDS) {
    assert.equal(en[id], EN_VALUES[id], `${id} English source drifted`);
    assert.ok(zh[id], `${id} missing from zh-cn`);
    assert.notEqual(zh[id], en[id], `${id} is still English in zh-cn`);
    assert.match(zh[id], /\p{Script=Han}/u, `${id} has no Chinese characters`);
  }
});

function EnvironmentBadgeProbe({ env }: { env: string }) {
  const { formatMessage } = useIntl();
  const id = getEnvironmentLabelMessageId(env);
  if (!id) return <span data-testid="env-badge">none</span>;
  return <span data-testid="env-badge">{formatMessage({ id })}</span>;
}

test("environment badges resolve slockdev/staging/web-preview through MessageIds", () => {
  assert.equal(getEnvironmentLabelMessageId("slockdev"), "env.badge.dev");
  assert.equal(getEnvironmentLabelMessageId("staging"), "env.badge.staging");
  assert.equal(getEnvironmentLabelMessageId("web-preview"), "env.badge.webPreview");
  assert.equal(getEnvironmentLabelMessageId("production"), null);
  assert.equal(getEnvironmentLabelMessageId(undefined), null);

  const cases = [
    ["slockdev", "env.badge.dev"],
    ["staging", "env.badge.staging"],
    ["web-preview", "env.badge.webPreview"],
  ] as const;

  for (const [env, id] of cases) {
    cleanup();
    const { getByTestId } = renderZh(<EnvironmentBadgeProbe env={env} />);
    assert.equal(getByTestId("env-badge").textContent, zh[id], `${env} badge`);
    assert.notEqual(getByTestId("env-badge").textContent, en[id], `${env} still English`);
  }
});
