/**
 * Runtime form v2 copy by request language (packages/runtime-form README,
 * "Protocol v2"). The form structure is the same in every language; only the
 * display strings in `uiSchema.localization` and the generic option labels of an
 * option source change.
 *
 * A client asks with `Accept-Language` (BCP 47) on the v2 form, edit form and
 * option-source requests; a client that sends none gets English, exactly as
 * before. Translations are keyed by the English string, so copy that has no
 * translation yet stays English instead of disappearing. Chinese wording follows
 * the web app's zh-cn messages (packages/web/src/i18n/messages/zh-cn.ts).
 */
import type { Response } from "express";
import type { RuntimeFormV2Definition, RuntimeFormV2Option } from "@botiverse/raft-runtime-form";

export type RuntimeFormCopyLocale = "en" | "zh-CN";

const ZH_CN: Readonly<Record<string, string>> = Object.freeze({
  // Field labels
  "API Key": "API 密钥",
  "API URL": "API URL",
  "Base URL": "Base URL",
  "Claude Command": "Claude 命令",
  "Effort": "推理强度",
  "Environment Variables": "环境变量",
  "Fast mode": "快速模式",
  "Fast tier": "快速档",
  "Load local Pi extensions": "加载本机 Pi 扩展",
  "Model": "模型",
  "Model ID": "模型 ID",
  "Provider": "提供方",
  "Reasoning": "推理强度",
  "Supports image input": "支持图片输入",
  "Thinking effort": "思考强度",
  "Tier": "档位",
  // Field hints
  "Available values are declared by the selected model.": "可选值由所选模型决定。",
  "Available values depend on the selected model.": "可选值取决于所选模型。",
  "Built-in Pi is ready to use without local runtime setup. It uses the provider key entered here.":
    "内置 Pi 无需本地运行时设置即可使用。它会使用这里填写的提供方密钥。",
  "Configured uses your machine's Pi auth.json. Other options inject the matching API key as an env var so the Pi SDK picks it up — no auth.json edit on your machine.":
    "已配置模式会使用你机器上的 Pi auth.json。其他选项会把对应 API 密钥注入为环境变量，让 Pi SDK 自动读取——无需修改机器上的 auth.json。",
  "Default leaves Claude Code provider settings untouched. Custom sets ANTHROPIC_BASE_URL and ANTHROPIC_API_KEY for this agent.":
    "默认模式不改动 Claude Code 提供方设置。自定义模式会为此 Agent 设置 ANTHROPIC_BASE_URL 和 ANTHROPIC_API_KEY。",
  "Enable only when this gateway endpoint and model accept images.": "仅当此 gateway endpoint 和模型接受图片时开启。",
  "Executable path or command name; Slock adds the Claude stream-json runtime arguments.":
    "可执行文件路径或命令名；Slock 会追加 Claude stream-json 运行时参数。",
  "Launch this runtime with higher speed at a higher cost per token.": "以更高的单 token 成本换取更快的速度启动此运行时。",
  "Load enabled Pi extensions installed on the computer running this agent. Applying changes restarts a running agent.":
    "加载运行此 Agent 的电脑上已安装并启用的 Pi 扩展。应用更改会重启正在运行的 Agent。",
  "Models Claude Code accepts. You can also type a model ID.": "Claude Code 支持的模型。也可以直接填写模型 ID。",
  "Models GitHub Copilot CLI accepts. You can also type a model ID.": "GitHub Copilot CLI 支持的模型。也可以直接填写模型 ID。",
  "Models available from this computer's Codex CLI. You can also type a model ID.":
    "这台电脑上 Codex CLI 可用的模型。也可以直接填写模型 ID。",
  "Models available from this computer's Cursor CLI. You can also type a model ID.":
    "这台电脑上 Cursor CLI 可用的模型。也可以直接填写模型 ID。",
  "Models available from this computer's Grok CLI.": "这台电脑上 Grok CLI 可用的模型。",
  "Models available from this computer's Kimi CLI configuration.": "这台电脑上 Kimi CLI 配置中可用的模型。",
  "Models available from this computer's Kimi configuration.": "这台电脑上 Kimi 配置中可用的模型。",
  "Models available from this computer's OpenCode configuration.": "这台电脑上 OpenCode 配置中可用的模型。",
  "Models available from this computer's Pi configuration. You can also type a model ID.":
    "这台电脑上 Pi 配置中可用的模型。也可以直接填写模型 ID。",
  "Models the selected provider offers.": "所选提供方提供的模型。",
  "These will be injected into the runtime command environment.": "这些变量会注入到运行时命令的环境中。",
  "Use a model ID the selected provider supports.": "请填写所选提供方支持的模型 ID。",
  // Choice descriptions. Effort level names stay English, as in the web app.
  "Fast responses with lighter reasoning": "快速响应，推理较轻",
  "Balances speed and reasoning depth for everyday tasks": "在日常任务中平衡速度与推理深度",
  "Greater reasoning depth for complex problems": "针对复杂问题提供更深入的推理",
  "Extra high reasoning depth for complex problems": "针对复杂问题提供极高推理深度",
  "Maximum reasoning depth for the hardest problems": "针对最难的问题提供最大推理深度",
  "Maximum reasoning with automatic task delegation": "最大推理，并自动进行任务委派",
  "Lower latency": "更低延迟",
  // Generic option labels (model and provider names are never translated)
  "Auto": "自动",
  "Configured": "已配置",
  "Configured Default": "已配置的默认值",
  "Configured Default / Auto": "已配置的默认值 / 自动",
  "Custom": "自定义",
  "Default": "默认",
});

const TRANSLATIONS: Readonly<Record<Exclude<RuntimeFormCopyLocale, "en">, Readonly<Record<string, string>>>> = Object.freeze({
  "zh-CN": ZH_CN,
});

/** The zh-CN table, for tests that check every shipped string has a translation. */
export const RUNTIME_FORM_V2_ZH_CN_COPY = ZH_CN;

/**
 * The copy language for an `Accept-Language` header: the highest-q range that
 * names a language we have, else English. Any Chinese range picks zh-CN, the
 * only Chinese the clients ship.
 */
export function runtimeFormCopyLocale(acceptLanguage: string | undefined): RuntimeFormCopyLocale {
  if (!acceptLanguage) return "en";
  const ranges = acceptLanguage
    .split(",")
    .map((part, index) => {
      const [tag, ...params] = part.trim().split(";");
      const q = params.map((p) => p.trim().toLowerCase()).find((p) => p.startsWith("q="));
      const quality = q === undefined ? 1 : Number(q.slice(2));
      return { tag: tag.trim().toLowerCase(), quality: Number.isFinite(quality) ? quality : 0, index };
    })
    .filter((range) => range.tag !== "" && range.quality > 0)
    .sort((a, b) => b.quality - a.quality || a.index - b.index);
  for (const { tag } of ranges) {
    if (tag === "zh" || tag.startsWith("zh-")) return "zh-CN";
    if (tag === "en" || tag.startsWith("en-")) return "en";
  }
  return "en";
}

function translate(text: string, table: Readonly<Record<string, string>>): string {
  return Object.hasOwn(table, text) ? table[text] : text;
}

/** The form with its display copy in `locale`; English returns the form unchanged. */
export function localizeRuntimeFormV2<T extends RuntimeFormV2Definition>(form: T, locale: RuntimeFormCopyLocale): T {
  if (locale === "en") return form;
  const table = TRANSLATIONS[locale];
  const localization = form.uiSchema?.localization;
  if (!localization) return form;
  const localized = structuredClone(form);
  for (const copy of Object.values(localized.uiSchema!.localization!)) {
    if (typeof copy.label === "string") copy.label = translate(copy.label, table);
    if (typeof copy.hint === "string") copy.hint = translate(copy.hint, table);
    if (typeof copy.placeholder === "string") copy.placeholder = translate(copy.placeholder, table);
    for (const choice of Object.values(copy.choices ?? {})) {
      choice.label = translate(choice.label, table);
      if (typeof choice.description === "string") choice.description = translate(choice.description, table);
    }
  }
  return localized;
}

function localizeOptions(options: RuntimeFormV2Option[], table: Readonly<Record<string, string>>): RuntimeFormV2Option[] {
  return options.map((option) => (
    typeof option.label === "string" ? { ...option, label: translate(option.label, table) } : option
  ));
}

/** The option source with its generic option labels in `locale`; values never change. */
export function localizeRuntimeFormV2OptionSource<T extends { options?: unknown; optionsByValue?: unknown }>(
  source: T,
  locale: RuntimeFormCopyLocale,
): T {
  if (locale === "en") return source;
  const table = TRANSLATIONS[locale];
  const localized = { ...source };
  if (Array.isArray(source.options)) {
    localized.options = localizeOptions(source.options as RuntimeFormV2Option[], table);
  }
  if (source.optionsByValue && typeof source.optionsByValue === "object") {
    localized.optionsByValue = Object.fromEntries(
      Object.entries(source.optionsByValue as Record<string, RuntimeFormV2Option[]>).map(([value, options]) => [
        value,
        Array.isArray(options) ? localizeOptions(options, table) : options,
      ]),
    );
  }
  return localized;
}

/** Marks a localized response so caches keep one copy per language. */
export function setRuntimeFormCopyHeaders(res: Response, locale: RuntimeFormCopyLocale): void {
  res.setHeader("Content-Language", locale);
  res.vary("Accept-Language");
}
