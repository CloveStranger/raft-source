import { Button, Card, Input, Progress, ProgressIndicator, ProgressTrack, Status } from "raft-ui";
import Tooltip from "../ui/Tooltip";
import { useCallback, useMemo } from "react";
import type { ChangeEvent } from "react";
import { Check, CreditCard, Plus, X } from "lucide-react";
import { DEFAULT_BILLING_INTERVAL, FREE_MONTHLY_FILE_UPLOAD_LIMIT_BYTES, PLAN_CONFIG, PRO_AGENT_SEAT_BLOCK_SIZE, PRO_AGENT_SEAT_FRACTION, PRO_SEAT_ANNUAL_USD, PRO_SEAT_MONTHLY_USD, formatProAgentSeatFraction, getEffectiveLimits, isTrialActive } from "@botiverse/raft-shared";
import type { ServerPlan } from "@botiverse/raft-shared";
import type { BillingInfo, Server, ServerUsage } from "../../store/serverStore";
import ConfirmDialog from "../ConfirmDialog";
import api from "../../api/client";
import { FormattedMessage, useIntl } from "react-intl";
import SectionHeader from "../ui/SectionHeader";
import { getBillingControlsState, getSettingsBillingPlanPresentation } from "../../utils/billingControls";
import { formatGlobalTrialCutoffDate } from "../../utils/trialCutoff";
import { applyBillingSeatInputChange, applyBillingSeatInputCommit, getBillingCurrentTotalLabel, getBillingSeatCopyLabels, getBillingSeatDraftState, getBillingSeatInputValue, getBillingSelectedTotalLabels, getBillingTotalSummaryLabels } from "../../utils/billingSeatInput";
import type { BillingPricedTotal } from "../../utils/billingSeatInput";
import { BillingIntervalSegmentedControl } from "./SettingsSegmentedControls";
import { DowngradeWarningCard } from "./SettingsPanel";
import type { BillingSeatUpdatePreview, usePlanBillingDraft } from "./SettingsPanel";

// Stryker disable all: Settings billing UI wiring is covered by billingSeatInput behavior tests, source-copy contracts, and visual preview screenshots.
export function PlanSectionContent({
  server,
  usage,
  billing,
  loadBilling,
  draft,
}: {
  server: Server;
  usage: ServerUsage | null;
  billing: BillingInfo | null;
  loadBilling: () => Promise<void>;
  draft: ReturnType<typeof usePlanBillingDraft>;
}) {
  const { formatMessage, locale: intlLocale } = useIntl();
  const {
    billingAction, setBillingAction,
    billingError, setBillingError,
    billingNotice, setBillingNotice,
    desiredSeatOverride, setDesiredSeatOverride,
    desiredSeatInput, setDesiredSeatInput,
    billingInterval, setBillingInterval,
    showCancelSubscriptionConfirm, setShowCancelSubscriptionConfirm,
    confirmBillingAction, setConfirmBillingAction,
    promotionCode, setPromotionCode,
    seatUpdatePreview, setSeatUpdatePreview,
  } = draft;

  const plan = (billing?.plan ?? server.plan) as ServerPlan;
  const config = PLAN_CONFIG[plan];
  const limits = getEffectiveLimits(plan);
  const pricedLimits = config.limits;
  const capacity = billing?.capacity;

  const agentCount = billing?.usage.agents ?? usage?.agents ?? 0;
  const humanCount = billing?.usage.humans;
  const usesUniversalSeats = capacity != null && capacity.maxUniversalSeats !== -1;
  const universalSeatLimit = usesUniversalSeats ? capacity?.maxUniversalSeats ?? 0 : 0;
  const usedHumanUniversalSeats = Math.max(0, humanCount ?? 0);
  const usedAgentUniversalSeats = Math.max(0, agentCount * PRO_AGENT_SEAT_FRACTION);
  const usedUniversalSeats = Math.max(
    0,
    billing?.usage.universalSeats ?? usedHumanUniversalSeats + usedAgentUniversalSeats,
  );
  const seatUsageScale = universalSeatLimit > 0 && usedUniversalSeats > universalSeatLimit
    ? universalSeatLimit / usedUniversalSeats
    : 1;
  const humanSeatUsagePercent = universalSeatLimit > 0
    ? Math.min(100, (usedHumanUniversalSeats * seatUsageScale / universalSeatLimit) * 100)
    : 0;
  const agentSeatUsagePercent = universalSeatLimit > 0
    ? Math.min(100, (usedAgentUniversalSeats * seatUsageScale / universalSeatLimit) * 100)
    : 0;
  const canManageBilling = billing?.permissions.canManageBilling === true;
  const billingControlsState = getBillingControlsState({
    plan: billing?.plan ?? server?.plan ?? null,
    subscriptionStatus: billing?.subscription?.status ?? null,
  });
  const isProPlan = plan === "pro";
  const showSeatUsage = isProPlan;
  const billingControlsDisabledReason = !canManageBilling
    ? formatMessage({ id: "billing.onlyServerOwnersCanChangeBilling" })
    : !billing?.stripeConfigured
      ? formatMessage({ id: "billing.paidPlansAreNotAvailableYet" })
      : null;
  const formatLimit = (value: number | undefined) => value == null
    ? "..."
    : value === -1 ? formatMessage({ id: "billing.unlimited" }) : String(value);
  const formatBytes = (value: number | undefined) => {
    if (value == null || value < 0) return formatMessage({ id: "billing.unlimited" });
    if (value >= 1024 * 1024) return `${Math.round(value / 1024 / 1024)} MB`;
    return `${Math.round(value / 1024)} KB`;
  };
  const formatSeatUsageNumber = (value: number) => value.toFixed(1).replace(/\.0$/, "");
  const finalTrialActive = isTrialActive();
  const formatUsd = (value: number) => Number.isInteger(value) ? String(value) : value.toFixed(2);
  const currentHumanSeats = billing?.provisioned.humans ?? 0;
  const currentAgentSeats = billing?.provisioned.agents ?? 0;
  const currentSeatQuantity = billing?.provisioned.proPackQuantity ?? 0;
  const minimumUsageSeatQuantity = Math.max(1, Math.ceil(usedUniversalSeats));
  const minimumSeatQuantity = isProPlan ? Math.max(1, currentSeatQuantity) : 1;
  const isCheckoutMode = billingControlsState.canCheckout;
  const isManageSeatMode = !isCheckoutMode && billingControlsState.canUpdatePacks && isProPlan;
  const showManagePlanSection = isCheckoutMode || billingControlsState.canUpdatePacks;
  const isCancelScheduled = billing?.subscription?.cancelAtPeriodEnd === true;
  const minimumManageSeatQuantity = Math.max(1, minimumUsageSeatQuantity);
  const defaultSeatInputQuantity = isManageSeatMode
    ? Math.max(minimumManageSeatQuantity, currentSeatQuantity)
    : Math.max(minimumUsageSeatQuantity, minimumSeatQuantity);
  const requestedSeatInputQuantity = desiredSeatOverride ?? defaultSeatInputQuantity;
  const draftRequestedSeatQuantity = requestedSeatInputQuantity;
  const billingSeatDraftState = getBillingSeatDraftState({
    requestedSeatQuantity: draftRequestedSeatQuantity,
    draftSeatQuantity: draftRequestedSeatQuantity,
    minimumUsageSeatQuantity,
    minimumSeatQuantity: isManageSeatMode ? 1 : minimumSeatQuantity,
  });
  const requestedSeatQuantity = billingSeatDraftState.requestedSeatQuantity;
  const draftSeatQuantity = billingSeatDraftState.draftSeatQuantity;
  const draftProvisionedAgentSeats = draftSeatQuantity * PRO_AGENT_SEAT_BLOCK_SIZE;
  const requestedHumanSeatCapacity = requestedSeatQuantity;
  const requestedAgentSeatCapacity = requestedSeatQuantity * PRO_AGENT_SEAT_BLOCK_SIZE;
  const draftBelowRequiredCoverage = billingSeatDraftState.belowCurrentUsage;
  const managePlanTitle = isCheckoutMode
    ? formatMessage({ id: "billing.upgradeToPro" })
    : isManageSeatMode ? (formatMessage({ id: "billing.manageSeats" })) : formatMessage({ id: "billing.managePlan" });
  const currentBillingInterval = billing?.subscription?.billingInterval ?? billing?.price?.billingInterval ?? DEFAULT_BILLING_INTERVAL;
  const currentBillingIntervalLabel = currentBillingInterval === "annual" ? formatMessage({ id: "billing.yearly" }) : formatMessage({ id: "billing.monthly" });
  const currentTotalLabel = billing?.price
    ? getBillingCurrentTotalLabel(
      currentBillingInterval,
      billing.price.monthlyUsd,
      billing.price.annualUsd,
      formatUsd,
    )
    : null;
  const currentPlanPresentation = getSettingsBillingPlanPresentation(
    plan,
    config.displayName,
    currentHumanSeats,
    currentAgentSeats,
    currentSeatQuantity,
    formatProAgentSeatFraction(),
  );
  const currentPlanDisplayName = formatMessage({ id: currentPlanPresentation.displayName });
  const currentPlanDescription = formatMessage(
    { id: currentPlanPresentation.description },
    currentPlanPresentation.descriptionValues,
  );
  const pricedFileUploadLimitLabel = plan === "free" ? `${formatBytes(FREE_MONTHLY_FILE_UPLOAD_LIMIT_BYTES)}/${formatMessage({ id: "billing.month" })}` : formatMessage({ id: "billing.unlimited" });
  const comparePlansHref = "https://raft.build/#pricing";
  const currentIncludedFeatures = currentPlanPresentation.includedFeatures.map((id) => formatMessage({ id }));
  const currentNotIncludedFeatures = currentPlanPresentation.notIncludedFeatures.map((id) => formatMessage({ id }));
  const hasNotIncludedFeatures = currentNotIncludedFeatures.length > 0;
  const selectedTotalLabels = getBillingSelectedTotalLabels(
    isManageSeatMode ? currentBillingInterval : billingInterval,
    draftSeatQuantity,
    PRO_SEAT_MONTHLY_USD,
    PRO_SEAT_ANNUAL_USD,
    formatUsd,
  );
  // Priced totals arrive as {id, amount}; the "/ year" | "/ 年" period is part of
  // the translation now, so there is nothing left to patch after the fact.
  const formatPricedTotal = (total: BillingPricedTotal | null) =>
    total == null ? null : formatMessage({ id: total.id }, { amount: total.amount });
  const localizedSelectedTotalLabels = {
    totalLabel: formatPricedTotal(selectedTotalLabels.totalLabel)!,
    originalLabel: formatPricedTotal(selectedTotalLabels.originalLabel),
  };
  const localizedCurrentTotalLabel = formatPricedTotal(currentTotalLabel);
  const seatDelta = draftSeatQuantity - currentSeatQuantity;
  const additionalSeats = Math.max(0, seatDelta);
  const removedSeats = Math.max(0, -seatDelta);
  const normalizedPromotionCode = promotionCode.trim();
  const formatBillingAmount = (amount: number, currency: string) => new Intl.NumberFormat(
    intlLocale.toLowerCase().startsWith("zh") ? "zh-CN" : "en-US",
    { style: "currency", currency: currency.toUpperCase() },
  ).format(amount / 100);
  const formatSeatLabel = (count: number) => formatMessage({ id: "billing.seatCount" }, { count });
  const formatHumanCapacityLabel = (count: number) => formatMessage({ id: "billing.upToHumans" }, { count });
  const formatAgentCapacityLabel = (count: number) => formatMessage({ id: "billing.orAgents" }, { count });
  const handleSeatInputChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    applyBillingSeatInputChange(
      event.currentTarget.value,
      setDesiredSeatInput,
      setDesiredSeatOverride,
    );
  }, [setDesiredSeatInput, setDesiredSeatOverride]);
  const seatInputMinimum = isManageSeatMode ? minimumManageSeatQuantity : Math.max(minimumUsageSeatQuantity, minimumSeatQuantity);
  // Stryker disable next-line BlockStatement: component wiring delegates to billingSeatInput helpers covered by DOM-gate behavior tests.
  const commitSeatInput = useCallback(() => {
    applyBillingSeatInputCommit(
      desiredSeatInput,
      requestedSeatInputQuantity,
      seatInputMinimum,
      setDesiredSeatOverride,
      setDesiredSeatInput,
    );
  }, [desiredSeatInput, requestedSeatInputQuantity, seatInputMinimum, setDesiredSeatInput, setDesiredSeatOverride]);
  const noSeatChangeSelected = requestedSeatQuantity === currentSeatQuantity;
  const updateSeatButtonDisabled = !!billingControlsDisabledReason
    || draftBelowRequiredCoverage
    || billingAction != null
    || (!isCancelScheduled && noSeatChangeSelected);
  const updateSeatButtonTitle = billingControlsDisabledReason
    ?? (draftBelowRequiredCoverage
      ? formatMessage({ id: "billing.keepAtLeastSeats" }, { min: minimumUsageSeatQuantity })
      : null)
    ?? (isCancelScheduled
      ? noSeatChangeSelected
        ? formatMessage({ id: "billing.reactivateThisProSubscriptionBeforeTheCurren" })
        : formatMessage({ id: "billing.reactivateThisSubscriptionAndUpdateSeats" })
      : noSeatChangeSelected
        ? formatMessage({ id: "billing.enterADifferentSeatTotal" })
      : formatMessage({ id: "billing.reviewProSeatUpdateBeforeConfirming" }));
  const updateSeatButtonLabel = isCancelScheduled
    ? noSeatChangeSelected ? formatMessage({ id: "billing.reactivateSubscription" }) : formatMessage({ id: "billing.reactivateAndUpdateSeats" })
    : formatMessage({ id: "billing.reviewSeatUpdate" });
  const updateSeatButtonBusyLabel = billingAction === "preview"
    ? formatMessage({ id: "billing.reviewing" })
    : isCancelScheduled && noSeatChangeSelected ? formatMessage({ id: "billing.reactivating" }) : formatMessage({ id: "billing.updating" });
  const capacityLabel = isManageSeatMode
    ? seatDelta > 0
      ? formatMessage({ id: "billing.addsSeats" }, { seats: formatSeatLabel(additionalSeats) })
      : seatDelta < 0
        ? formatMessage({ id: "billing.removesSeats" }, { seats: formatSeatLabel(removedSeats) })
        : formatMessage({ id: "billing.keepsCurrentSeats" })
    : formatMessage({ id: "billing.selectedSeats" }, { seats: formatSeatLabel(draftSeatQuantity) });
  const billingSeatCopyMode = isManageSeatMode ? "manageSeats" : "default";
  const billingSeatCopyLabels = getBillingSeatCopyLabels(billingSeatCopyMode);
  const billingTotalSummaryLabels = getBillingTotalSummaryLabels(
    billingSeatCopyMode,
    isManageSeatMode ? currentBillingInterval : billingInterval,
  );
  // The two `localized…Labels` objects used to hold a full parallel Chinese copy
  // of these label groups behind `locale === "zh-CN"`, so every label existed
  // twice and could drift independently. The ids carry both languages now, so
  // the branch is gone and there is only one place to change a label.
  // Format at this boundary so the ~11 consumers below keep receiving STRINGS.
  // Without this the ids typecheck perfectly and the UI renders the literal text
  // "billing.totalSeats" — the same trap as the plan-presentation change in
  // #5774: the type system proves every value is a valid id and says nothing
  // about whether the consumer formats it.
  const localizedBillingSeatCopyLabels = {
    seatQuantityLabel: formatMessage({ id: billingSeatCopyLabels.seatQuantityLabel }),
    seatSummaryLabel: formatMessage({ id: billingSeatCopyLabels.seatSummaryLabel }),
    billableSeatsSummaryLabel: formatMessage({ id: billingSeatCopyLabels.billableSeatsSummaryLabel }),
    capacitySummaryLabel: formatMessage({ id: billingSeatCopyLabels.capacitySummaryLabel }),
    quantityHelpLabel: formatMessage(
      { id: billingSeatCopyLabels.quantityHelpLabel },
      { capacity: capacityLabel },
    ),
  };
  const localizedBillingTotalSummaryLabels = {
    currentTotalLabel: billingTotalSummaryLabels.currentTotalLabel
      ? formatMessage({ id: billingTotalSummaryLabels.currentTotalLabel })
      : null,
    totalLabel: formatMessage({ id: billingTotalSummaryLabels.totalLabel }),
  };
  const billingSeatDraftError = draftBelowRequiredCoverage
    ? isManageSeatMode
      ? formatMessage({ id: "billing.keepAtLeastSeats" }, { min: minimumUsageSeatQuantity })
      : formatMessage({ id: "billing.enterAtLeastSeats" }, { min: minimumUsageSeatQuantity })
    : null;
  // Stryker disable next-line StringLiteral: validated by source-copy contracts and visual preview, not by the DOM mutation corpus.
  const managePlanInputPrompt = isCheckoutMode
    ? formatMessage({ id: "billing.enterTheNumberOfSeatsToBuy" })
    : formatMessage({ id: "billing.enterTheTotalSeatsAfterThisUpdate" });
  const seatInputValue = getBillingSeatInputValue(desiredSeatInput, requestedSeatInputQuantity);
  const seatSummaryValue = draftSeatQuantity;

  const handleCheckout = useCallback(async () => {
    if (billingControlsDisabledReason || !billingControlsState.canCheckout) return;
    setBillingError("");
    setBillingNotice("");
    setBillingAction("checkout");
    try {
      const { data } = await api.post("/billing/checkout", {
        targetPlan: "pro",
        billingInterval,
        seatQuantity: requestedSeatQuantity,
        humanSeatQuantity: requestedHumanSeatCapacity,
        agentSeatQuantity: requestedAgentSeatCapacity,
        successUrl: window.location.href,
        cancelUrl: window.location.href,
      });
      window.location.href = data.url;
    } catch (err: any) {
      setBillingError(err.response?.data?.error || formatMessage({ id: "billing.failedToStartCheckout" }));
      setBillingAction(null);
    }
  }, [
    billingControlsDisabledReason,
    billingControlsState.canCheckout,
    billingInterval,
    formatMessage,
    requestedAgentSeatCapacity,
    requestedHumanSeatCapacity,
    requestedSeatQuantity,
    setBillingAction,
    setBillingError,
    setBillingNotice,
  ]);

  const handlePortal = useCallback(async () => {
    if (billingControlsDisabledReason || !billingControlsState.canOpenPortal) return;
    setBillingError("");
    setBillingNotice("");
    setBillingAction("portal");
    try {
      const { data } = await api.post("/billing/portal", {
        returnUrl: window.location.href,
      });
      window.location.href = data.url;
    } catch (err: any) {
      setBillingError(err.response?.data?.error || formatMessage({ id: "billing.failedToOpenBillingPortal" }));
      setBillingAction(null);
    }
  }, [billingControlsDisabledReason, billingControlsState.canOpenPortal, formatMessage, setBillingAction, setBillingError, setBillingNotice]);

  const handlePackQuantityUpdate = useCallback(async () => {
    if (billingControlsDisabledReason || !billingControlsState.canUpdatePacks) return;
    setBillingError("");
    setBillingNotice("");
    setBillingAction("update");
    try {
      const { data } = await api.post("/billing/seat-pack-quantity", {
        seatQuantity: requestedSeatQuantity,
        humanSeatQuantity: requestedHumanSeatCapacity,
        agentSeatQuantity: requestedAgentSeatCapacity,
        ...(seatUpdatePreview ? { previewToken: seatUpdatePreview.previewToken } : {}),
      });
      if (data.status === "pending_payment") {
        setBillingNotice(formatMessage({ id: "billing.seatUpdateIsPendingStripePaymentConfirmation" }));
      } else if (data.status === "unchanged") {
        setBillingNotice(formatMessage({ id: "billing.seatQuantitiesAreAlreadyUpToDate" }));
      } else if (data.status === "reactivated") {
        setBillingNotice(formatMessage({ id: "billing.subscriptionReactivatedYourCurrentProSeatCap" }));
      } else if (data.status === "updated" || data.effectiveAt === "current") {
        setBillingNotice(formatMessage({ id: "billing.seatUpdateConfirmedCapacityHasBeenRefreshedFro" }));
      } else {
        setBillingNotice(formatMessage({ id: "billing.seatUpdateRequestedCapacityWillUpdateAfterStri" }));
      }
      await loadBilling();
      setDesiredSeatOverride(null);
      setDesiredSeatInput(null);
      setPromotionCode("");
      setSeatUpdatePreview(null);
    } catch (err: any) {
      setBillingError(err.response?.data?.error || formatMessage({ id: "billing.failedToUpdateSeats" }));
    } finally {
      setBillingAction(null);
    }
  }, [
    billingControlsDisabledReason,
    billingControlsState.canUpdatePacks,
    formatMessage,
    loadBilling,
    requestedAgentSeatCapacity,
    requestedHumanSeatCapacity,
    requestedSeatQuantity,
    seatUpdatePreview,
    setBillingAction,
    setBillingError,
    setBillingNotice,
    setDesiredSeatInput,
    setDesiredSeatOverride,
    setPromotionCode,
    setSeatUpdatePreview,
  ]);

  const handleCancelSubscription = useCallback(async () => {
    if (billingControlsDisabledReason || !billingControlsState.canOpenPortal) return;
    setBillingError("");
    setBillingNotice("");
    setBillingAction("cancel");
    try {
      await api.post("/billing/cancel");
      await loadBilling();
      setBillingNotice(formatMessage({ id: "billing.subscriptionCancellationScheduledForTheEndOf" }));
      setShowCancelSubscriptionConfirm(false);
    } catch (err: any) {
      setBillingError(err.response?.data?.error || formatMessage({ id: "billing.failedToCancelSubscription" }));
    } finally {
      setBillingAction(null);
    }
  }, [
    billingControlsDisabledReason,
    billingControlsState.canOpenPortal,
    formatMessage,
    loadBilling,
    setBillingAction,
    setBillingError,
    setBillingNotice,
    setShowCancelSubscriptionConfirm,
  ]);

  const openCheckoutConfirm = useCallback(() => {
    if (billingControlsDisabledReason || billingSeatDraftError || !billingControlsState.canCheckout) return;
    setConfirmBillingAction("checkout");
  }, [billingControlsDisabledReason, billingControlsState.canCheckout, billingSeatDraftError, setConfirmBillingAction]);

  const openSeatUpdateConfirm = useCallback(async () => {
    if (updateSeatButtonDisabled || !billingControlsState.canUpdatePacks) return;
    setBillingError("");
    setBillingNotice("");
    setSeatUpdatePreview(null);
    if (seatDelta <= 0 || !normalizedPromotionCode) {
      setConfirmBillingAction("update");
      return;
    }
    setBillingAction("preview");
    try {
      const { data } = await api.post<BillingSeatUpdatePreview>("/billing/seat-pack-quantity/preview", {
        seatQuantity: requestedSeatQuantity,
        humanSeatQuantity: requestedHumanSeatCapacity,
        agentSeatQuantity: requestedAgentSeatCapacity,
        promotionCode: normalizedPromotionCode,
      });
      setSeatUpdatePreview(data);
      setConfirmBillingAction("update");
    } catch (err: unknown) {
      const axiosErr = err as { response?: { data?: { error?: string } } };
      setBillingError(axiosErr.response?.data?.error || formatMessage({ id: "billing.failedToPreviewSeatUpdate" }));
    } finally {
      setBillingAction(null);
    }
  }, [
    billingControlsState.canUpdatePacks,
    formatMessage,
    normalizedPromotionCode,
    requestedAgentSeatCapacity,
    requestedHumanSeatCapacity,
    requestedSeatQuantity,
    seatDelta,
    setBillingAction,
    setBillingError,
    setBillingNotice,
    setConfirmBillingAction,
    setSeatUpdatePreview,
    updateSeatButtonDisabled,
  ]);

  const handleOpenCancelSubscriptionConfirm = useCallback(
    () => setShowCancelSubscriptionConfirm(true),
    [setShowCancelSubscriptionConfirm],
  );
  const handleCloseCancelSubscriptionConfirm = useCallback(
    () => setShowCancelSubscriptionConfirm(false),
    [setShowCancelSubscriptionConfirm],
  );
  const handlePromotionCodeChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setPromotionCode(event.currentTarget.value);
    setSeatUpdatePreview(null);
  }, [setPromotionCode, setSeatUpdatePreview]);
  const handleCloseBillingConfirm = useCallback(() => {
    setConfirmBillingAction(null);
    setSeatUpdatePreview(null);
  }, [setConfirmBillingAction, setSeatUpdatePreview]);
  const humanSeatIndicatorStyle = useMemo(() => ({ width: `${humanSeatUsagePercent}%` }), [humanSeatUsagePercent]);
  const agentSeatIndicatorStyle = useMemo(() => ({ width: `${agentSeatUsagePercent}%` }), [agentSeatUsagePercent]);

  return (
    <div className="mb-6">
      <SectionHeader
        className="mb-3"
        icon={<CreditCard size={16} />}
        label={formatMessage({ id: "billing.currentPlan" })}
      />

      {/* Downgrade warning */}
      {server?.planDowngradedAt && (
        <DowngradeWarningCard server={server} usage={usage} />
      )}

      {/* Free trial notice */}
      {plan === "free" && finalTrialActive && (
        <div className="mb-4 border border-line-muted theme-brutal:border-2 theme-brutal:border-black bg-primary-soft theme-brutal:bg-soft-signal/30 shadow-raft-sm theme-brutal:shadow-brutal-sm p-4">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-sm font-bold">{formatMessage({ id: "billing.finalTrialPeriod" })}</span>
          </div>
          <p className="text-xs text-foreground-muted theme-brutal:text-black/60 font-mono">
                  {formatMessage(
                    { id: "billing.trialActiveThrough" },
                    {
                      date: formatGlobalTrialCutoffDate(intlLocale),
                    },
                  )}
          </p>
        </div>
      )}

      <div
        className="mb-6 border border-line-muted bg-layer-panel shadow-raft-sm theme-brutal:border-2 theme-brutal:border-black theme-brutal:bg-white theme-brutal:shadow-brutal-sm"
        data-testid="billing-current-plan-card"
      >
        <div className="border-b-2 border-line-muted theme-brutal:border-black bg-layer-canvas-muted theme-brutal:bg-brutal-cream px-4 py-4">
          <div className="flex flex-wrap items-center gap-3">
            <div className="min-w-0">
              <div className="text-lg font-bold text-foreground-strong theme-brutal:text-black">{currentPlanDisplayName}</div>
              <div className="text-sm text-foreground-muted theme-brutal:text-black/60">
                {currentPlanDescription}
              </div>
            </div>
          </div>
        </div>

        <div className={`grid gap-4 p-4 ${hasNotIncludedFeatures ? "lg:grid-cols-2" : ""}`}>
          <div>
            <div className="mb-3 text-sm font-bold text-foreground-strong theme-brutal:text-black">{formatMessage({ id: "billing.included" })}</div>
            <div className="space-y-3">
              {currentIncludedFeatures.map((feature) => (
                <div key={feature} className="flex items-start gap-3 text-sm text-foreground-strong theme-brutal:text-black">
                  <Check size={16} className="mt-0.5 shrink-0 text-green-700" />
                  <span>{feature}</span>
                </div>
              ))}
            </div>
          </div>

          {hasNotIncludedFeatures && (
            <div>
              <div className="mb-3 text-sm font-bold text-foreground-muted theme-brutal:text-black/60">{formatMessage({ id: "billing.notIncluded" })}</div>
              <div className="space-y-3">
                {currentNotIncludedFeatures.map((feature) => (
                  <div key={feature} className="flex items-start gap-3 text-sm text-foreground-strong theme-brutal:text-black">
                    <X size={16} className="mt-0.5 shrink-0 text-brutal-red" />
                    <span>{feature}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="border-t-2 border-line-muted theme-brutal:border-black/10 px-4 py-4">
          {showSeatUsage && usesUniversalSeats && (
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs font-bold text-foreground-strong theme-brutal:text-black">{formatMessage({ id: "billing.seat" })}</span>
                <span className="text-xs font-mono text-foreground-muted theme-brutal:text-black/60">
                  {formatSeatUsageNumber(usedUniversalSeats)} / {formatLimit(universalSeatLimit)} {formatMessage({ id: "billing.used" })}
                </span>
              </div>
              <Progress value={Math.min(100, humanSeatUsagePercent + agentSeatUsagePercent)} aria-label={formatMessage({ id: "billing.seat" })}>
              <ProgressTrack className="flex !overflow-hidden">
                {humanSeatUsagePercent > 0 && (
                  <Tooltip content={formatMessage(
                    { id: "billing.humansUsingSeats" },
                    {
                      people: humanCount ?? 0,
                      seatsText: formatSeatUsageNumber(usedHumanUniversalSeats),
                      seatCount: usedHumanUniversalSeats,
                    },
                  )}>
                  <ProgressIndicator
                    className="rounded-none h-full bg-primary-strong theme-brutal:bg-soft-signal"
                    style={humanSeatIndicatorStyle}
                    data-slot="progress-indicator"
                  />
                  </Tooltip>
                )}
                {agentSeatUsagePercent > 0 && (
                  <Tooltip content={formatMessage(
                    { id: "billing.agentsUsingSeats" },
                    {
                      people: agentCount,
                      seatsText: formatSeatUsageNumber(usedAgentUniversalSeats),
                      seatCount: usedAgentUniversalSeats,
                    },
                  )}>
                  <ProgressIndicator
                    className="rounded-none h-full bg-accent-strong theme-brutal:bg-brutal-pink"
                    style={agentSeatIndicatorStyle}
                    data-slot="progress-indicator"
                  />
                  </Tooltip>
                )}
              </ProgressTrack>
              </Progress>
              <div className="flex flex-wrap items-center gap-4 text-xs">
                <div className="flex items-center gap-2">
                  <span className="flex items-center gap-2 font-bold text-foreground-strong">
                    <Status variant="primary" size="sm" />
                    {formatMessage({ id: "billing.humans" })}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="flex items-center gap-2 font-bold text-foreground-strong">
                    <Status variant="accent" size="sm" />
                    {formatMessage({ id: "billing.agents" })}
                  </span>
                </div>
              </div>
            </div>
          )}
          {showSeatUsage && !usesUniversalSeats && (
            <div className="grid gap-3 sm:grid-cols-2">
              {humanCount != null && (
                <div className="flex items-center justify-between gap-3">
                  <span className="text-xs font-bold text-foreground-strong theme-brutal:text-black">{formatMessage({ id: "billing.humans" })}</span>
                  <span className="text-xs font-mono text-foreground-muted theme-brutal:text-black/60">
                    {humanCount} / {formatLimit(capacity?.maxHumans)}
                  </span>
                </div>
              )}
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs font-bold text-foreground-strong theme-brutal:text-black">{formatMessage({ id: "billing.agents" })}</span>
                <span className="text-xs font-mono text-foreground-muted theme-brutal:text-black/60">
                  {agentCount} / {formatLimit(capacity?.maxAgents ?? limits.maxAgents)}
                </span>
              </div>
            </div>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            {plan === "free" && (
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs font-bold text-foreground-strong theme-brutal:text-black">{formatMessage({ id: "billing.messageHistory" })}</span>
                <span className="text-xs font-mono text-foreground-muted theme-brutal:text-black/60">
                  {pricedLimits.messageHistoryDays === -1 ? formatMessage({ id: "billing.unlimited" }) : `${pricedLimits.messageHistoryDays} ${formatMessage({ id: "billing.days" })}`}
                </span>
              </div>
            )}
            {plan === "free" && billing?.fileUploadQuota && (
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs font-bold text-foreground-strong theme-brutal:text-black">{formatMessage({ id: "billing.fileUploads" })}</span>
                <span className="text-xs font-mono text-foreground-muted theme-brutal:text-black/60">
                  {billing.fileUploadQuota.limited
                    ? `${formatBytes(billing.fileUploadQuota.usedBytes)} / ${formatBytes(billing.fileUploadQuota.limitBytes)} ${formatMessage({ id: "billing.thisMonth" })}`
                    : pricedFileUploadLimitLabel}
                </span>
              </div>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t-2 border-line-muted theme-brutal:border-black/10 px-4 py-4">
          {billingControlsState.canOpenPortal ? (
            <div className="flex min-w-0 flex-wrap gap-2">
              <div className="flex flex-wrap gap-2">
                <Tooltip content={billingControlsDisabledReason ?? formatMessage({ id: "billing.openStripeBillingPortal" })}>
                <Button
                  variant="outline" size="sm"
                  type="button"
                  disabled={!!billingControlsDisabledReason || billingAction != null}
                  onClick={handlePortal}
                  data-slot="button"
                >
                  {billingAction === "portal" ? formatMessage({ id: "billing.opening" }) : formatMessage({ id: "billing.billingPortal" })}
                </Button>
                </Tooltip>
                {!isCancelScheduled && (
                  <Tooltip content={billingControlsDisabledReason ?? formatMessage({ id: "billing.cancelTheWholeProSubscriptionAtPeriodEnd" })}>
                  <Button
                    variant="outline" size="sm"
                    type="button"
                    disabled={!!billingControlsDisabledReason || billingAction != null}
                    onClick={handleOpenCancelSubscriptionConfirm}
                    data-slot="button"
                  >
                    {formatMessage({ id: "billing.cancelSubscription2" })}
                  </Button>
                  </Tooltip>
                )}
              </div>
            </div>
          ) : (
            <span />
          )}
          <Button
            render={<a href={comparePlansHref} aria-label={formatMessage({ id: "billing.seeAllFeaturesAndComparePlans" })} />}
            nativeButton={false}
            size="sm"
            variant="outline"
          >
            <FormattedMessage id="billing.seeAllFeaturesAndComparePlans" />
          </Button>
        </div>
      </div>

      {showManagePlanSection && (
        <>
          <SectionHeader
            className="mb-3"
            icon={isCheckoutMode ? <CreditCard size={16} /> : <Plus size={16} />}
            label={managePlanTitle}
          />

          <div className="mb-6 grid gap-4 border border-line-muted bg-layer-panel theme-brutal:border-2 theme-brutal:border-black theme-brutal:bg-white p-4 shadow-raft-sm theme-brutal:shadow-brutal-sm lg:grid-cols-[minmax(0,1fr)_280px]">
            <div>
              {isCheckoutMode && (
                <div className="mb-4">
                  <div className="mb-2 text-sm font-bold text-foreground-strong theme-brutal:text-black">{formatMessage({ id: "billing.howOftenDoYouWantToBeBilled" })}</div>
                  <BillingIntervalSegmentedControl
                    value={billingInterval}
                    onValueChange={setBillingInterval}
                    disabled={!!billingControlsDisabledReason || billingAction != null}
                  />
                </div>
              )}

              {billing?.subscription && (
                <div className="mb-4 text-xs font-mono text-foreground-muted theme-brutal:text-black/60">
                  {formatMessage({ id: "billing.billingInterval" })}: {isCancelScheduled
                    ? formatMessage(
                        { id: "billing.intervalWithCancellationScheduled" },
                        { interval: currentBillingIntervalLabel },
                      )
                    : currentBillingIntervalLabel}
                </div>
              )}

              <div className="flex min-w-0 flex-col gap-3">
                <span className="text-sm font-bold text-foreground-strong theme-brutal:text-black">
                  {managePlanInputPrompt}
                </span>
                <div className="flex flex-wrap items-end gap-3">
                  <label className="flex flex-col gap-1">
                    <span className="text-xs font-bold text-foreground-muted theme-brutal:text-black/60">{localizedBillingSeatCopyLabels.seatQuantityLabel}</span>
                    <Input
                      className="w-28 text-sm font-mono"
                      type="text"
                      inputMode="numeric"
                      pattern="[0-9]*"
                      min={isManageSeatMode ? minimumManageSeatQuantity : Math.max(minimumUsageSeatQuantity, minimumSeatQuantity)}
                      step={1}
                      aria-label={localizedBillingSeatCopyLabels.seatQuantityLabel}
                      value={seatInputValue}
                      disabled={!!billingControlsDisabledReason || billingAction != null}
                      onChange={handleSeatInputChange}
                      onBlur={commitSeatInput}
                    />
                  </label>
                  {isManageSeatMode && seatDelta > 0 && (
                    <label className="flex w-64 max-w-full flex-col gap-1">
                      <span className="text-xs font-bold text-foreground-muted theme-brutal:text-black/60">{formatMessage({ id: "billing.promotionCodeOptional" })}</span>
                      <Input
                        className="w-full text-sm font-mono uppercase"
                        type="text"
                        autoComplete="off"
                        aria-label={formatMessage({ id: "billing.promotionCodeOptional" })}
                        value={promotionCode}
                        disabled={!!billingControlsDisabledReason || billingAction != null}
                        onChange={handlePromotionCodeChange}
                      />
                    </label>
                  )}
                </div>
                {isManageSeatMode && seatDelta > 0 && (
                  <span className="text-[11px] font-mono text-foreground-muted theme-brutal:text-black/50">
                    {formatMessage({ id: "billing.enterACodeApprovedForExistingSeatUpdate" })}
                  </span>
                )}
                <span className="text-xs font-mono text-foreground-muted theme-brutal:text-black/60">
                    {localizedBillingSeatCopyLabels.quantityHelpLabel} {formatMessage(
                      { id: "billing.seatCoverageHelp" },
                      { min: minimumUsageSeatQuantity, price: PRO_SEAT_MONTHLY_USD },
                    )}
                </span>
                {billingSeatDraftError && (
                  <span className="text-xs font-mono text-brutal-red">
                    {billingSeatDraftError}
                  </span>
                )}
              </div>

              <div className="mt-4 flex flex-wrap gap-2">
                {isCheckoutMode && (
                  <Tooltip content={billingControlsDisabledReason ?? billingSeatDraftError ?? formatMessage(
                    { id: "billing.startCheckoutTitle" },
                    {
                      interval: formatMessage({
                        id: billingInterval === "annual" ? "billing.yearly" : "billing.monthly",
                      }),
                      seats: requestedSeatQuantity,
                    },
                  )}>
                  <Button
                    variant="accent" size="sm"
                    type="button"
                    disabled={!!billingControlsDisabledReason || !!billingSeatDraftError || billingAction != null}
                    onClick={openCheckoutConfirm}
                    data-slot="button"
                  >
                    {billingAction === "checkout" ? formatMessage({ id: "billing.opening" }) : formatMessage({ id: "billing.upgradeToPro" })}
                  </Button>
                  </Tooltip>
                )}
                {billingControlsState.canUpdatePacks && (
                  <Tooltip content={updateSeatButtonTitle}>
                  <Button
                    variant="accent" size="sm"
                    type="button"
                    disabled={updateSeatButtonDisabled}
                    onClick={openSeatUpdateConfirm}
                    data-slot="button"
                  >
                    {billingAction === "update" || billingAction === "preview" ? updateSeatButtonBusyLabel : updateSeatButtonLabel}
                  </Button>
                  </Tooltip>
                )}
              </div>
              {billingControlsDisabledReason && (
                <p className="mt-2 text-xs font-mono text-foreground-muted theme-brutal:text-black/60">{billingControlsDisabledReason}</p>
              )}
              {billingNotice && (
                <p className="mt-2 text-xs font-mono text-foreground-muted theme-brutal:text-black/60">{billingNotice}</p>
              )}
              {billingError && (
                <p className="mt-2 text-xs font-mono text-brutal-red">{billingError}</p>
              )}
            </div>

            <Card
              variant="option"
              data-testid="billing-summary-card"
              className="bg-layer-canvas-muted p-4 theme-brutal:border-black theme-brutal:bg-brutal-cream"
            >
              <div className="mb-3 text-xs font-bold uppercase tracking-widest text-foreground-muted theme-brutal:text-black/50">
                {isCheckoutMode ? formatMessage({ id: "billing.checkoutSummary" }) : isManageSeatMode ? (formatMessage({ id: "billing.manageSeatsSummary" })) : formatMessage({ id: "billing.subscriptionSummary" })}
              </div>
              <div className="space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm font-bold text-foreground-strong theme-brutal:text-black">{localizedBillingSeatCopyLabels.seatSummaryLabel}</span>
                  <span className="text-sm font-mono text-foreground-muted theme-brutal:text-black/60">{seatSummaryValue}</span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm font-bold text-foreground-strong theme-brutal:text-black">{localizedBillingSeatCopyLabels.billableSeatsSummaryLabel}</span>
                  <span className="text-sm font-mono text-foreground-muted theme-brutal:text-black/60">{draftSeatQuantity}</span>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm font-bold text-foreground-strong theme-brutal:text-black">{localizedBillingSeatCopyLabels.capacitySummaryLabel}</span>
                  <span className="inline-flex flex-col items-end text-sm font-mono leading-5 text-foreground-muted theme-brutal:text-black/60">
                    <span>{formatHumanCapacityLabel(draftSeatQuantity)}</span>
                    <span>{formatAgentCapacityLabel(draftProvisionedAgentSeats)}</span>
                  </span>
                </div>
                {isCheckoutMode ? (
                  <>
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-sm font-bold text-foreground-strong theme-brutal:text-black">{localizedBillingTotalSummaryLabels.totalLabel}</span>
                      <span className="inline-flex flex-col items-end text-sm font-mono leading-5 text-foreground-muted theme-brutal:text-black/60">
                        {localizedSelectedTotalLabels.originalLabel && (
                          <span className="text-foreground-muted theme-brutal:text-black/40 line-through">{localizedSelectedTotalLabels.originalLabel}</span>
                        )}
                        <span>{localizedSelectedTotalLabels.totalLabel}</span>
                      </span>
                    </div>
                  </>
                ) : (
                  <>
                    {isManageSeatMode && (
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-sm font-bold text-foreground-strong theme-brutal:text-black">{formatMessage({ id: "billing.currentSeats" })}</span>
                        <span className="text-sm font-mono text-foreground-muted theme-brutal:text-black/60">{currentSeatQuantity}</span>
                      </div>
                    )}
                    {isManageSeatMode && seatDelta !== 0 && (
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-sm font-bold text-foreground-strong theme-brutal:text-black">{seatDelta > 0 ? formatMessage({ id: "billing.addedCapacity" }) : formatMessage({ id: "billing.removedCapacity" })}</span>
                        <span className="inline-flex flex-col items-end text-sm font-mono leading-5 text-foreground-muted theme-brutal:text-black/60">
                          <span>{formatHumanCapacityLabel(Math.abs(seatDelta))}</span>
                          <span>{formatAgentCapacityLabel(Math.abs(seatDelta) * PRO_AGENT_SEAT_BLOCK_SIZE)}</span>
                        </span>
                      </div>
                    )}
                    {isManageSeatMode && localizedCurrentTotalLabel && localizedBillingTotalSummaryLabels.currentTotalLabel && (
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-sm font-bold text-foreground-strong theme-brutal:text-black">{localizedBillingTotalSummaryLabels.currentTotalLabel}</span>
                        <span className="text-sm font-mono text-foreground-muted theme-brutal:text-black/60">{localizedCurrentTotalLabel}</span>
                      </div>
                    )}
                    {isManageSeatMode && (
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-sm font-bold text-foreground-strong theme-brutal:text-black">{localizedBillingTotalSummaryLabels.totalLabel}</span>
                        <span className="inline-flex flex-col items-end text-sm font-mono leading-5 text-foreground-muted theme-brutal:text-black/60">
                          {localizedSelectedTotalLabels.originalLabel && (
                            <span className="text-foreground-muted theme-brutal:text-black/40 line-through">{localizedSelectedTotalLabels.originalLabel}</span>
                          )}
                          <span>{localizedSelectedTotalLabels.totalLabel}</span>
                        </span>
                      </div>
                    )}
                    <div className="border-t-2 border-line-muted theme-brutal:border-black pt-3 text-xs font-mono text-foreground-muted theme-brutal:text-black/60">
                      {formatMessage({ id: "billing.seatIncreasesMayBillImmediatelyAfterStripeConf" })}
                    </div>
                  </>
                )}
              </div>
            </Card>
          </div>
        </>
      )}

      {showCancelSubscriptionConfirm && (
        <ConfirmDialog
          chromeLocale="active"
          title={formatMessage({ id: "billing.cancelSubscription" })}
          message={formatMessage({ id: "billing.cancelTheWholeProSubscriptionAtTheEndOfTheCu" })}
          confirmLabel={formatMessage({ id: "billing.cancelSubscription2" })}
          loadingLabel={formatMessage({ id: "billing.canceling" })}
          confirmColor="bg-brutal-orange"
          onConfirm={handleCancelSubscription}
          onClose={handleCloseCancelSubscriptionConfirm}
        />
      )}
      {/* Stryker restore all: the real PlanSection composition test owns this complete dialog boundary. */}
      {confirmBillingAction && (
        <ConfirmDialog
          chromeLocale="active"
          title={confirmBillingAction === "checkout"
            ? formatMessage({ id: "billing.confirmProCheckout" })
            : formatMessage({ id: "billing.confirmSeatUpdate" })}
          message={(
            <div className="space-y-2">
              <p>
                {confirmBillingAction === "checkout"
                  ? formatMessage({ id: "billing.youAreAboutToStartProCheckout" })
                  : formatMessage({ id: "billing.youAreAboutToUpdateThisProSubscription" })}
              </p>
              <div className="font-mono text-xs">
                {confirmBillingAction === "update" ? (
                  <>
                    <div>{formatMessage({ id: "billing.currentSeats" })}: {currentSeatQuantity}</div>
                    {seatDelta > 0 && <div>{formatMessage({ id: "billing.seatsToAdd" })}: {additionalSeats}</div>}
                    {seatDelta < 0 && <div>{formatMessage({ id: "billing.seatsToRemove" })}: {removedSeats}</div>}
                    <div>{formatMessage({ id: "billing.totalSeatsAfterUpdate" })}: {draftSeatQuantity}</div>
                    <div>{formatMessage({ id: "billing.capacityAfterUpdate" })}: {formatMessage(
                        { id: "billing.capacityPair" },
                        {
                          human: formatHumanCapacityLabel(draftSeatQuantity),
                          agent: formatAgentCapacityLabel(draftProvisionedAgentSeats),
                        },
                      )}</div>
                    {seatUpdatePreview && (
                      <>
                        {seatUpdatePreview.promotion && (
                          <div>{formatMessage({ id: "billing.appliedPromotion" })}: {seatUpdatePreview.promotion.code}</div>
                        )}
                        <div>{formatMessage({ id: "billing.estimatedProratedCharge" })}: {formatBillingAmount(seatUpdatePreview.prorationAmount, seatUpdatePreview.currency)}</div>
                        {seatUpdatePreview.discountAmount > 0 && (
                          <div>{formatMessage({ id: "billing.discount" })}: {formatBillingAmount(-seatUpdatePreview.discountAmount, seatUpdatePreview.currency)}</div>
                        )}
                        <div>
                          {currentBillingInterval === "annual" ? formatMessage({ id: "billing.estimatedNextYearlyTotal" }) : formatMessage({ id: "billing.estimatedNextMonthlyTotal" })}: {formatBillingAmount(seatUpdatePreview.recurringAmount, seatUpdatePreview.currency)}
                        </div>
                      </>
                    )}
                  </>
                ) : (
                  <>
                    <div>{formatMessage({ id: "billing.seats" })}: {draftSeatQuantity}</div>
                    <div>{formatMessage({ id: "billing.capacity" })}: {formatMessage(
                        { id: "billing.capacityPair" },
                        {
                          human: formatHumanCapacityLabel(draftSeatQuantity),
                          agent: formatAgentCapacityLabel(draftProvisionedAgentSeats),
                        },
                      )}</div>
                  </>
                )}
                <div>{localizedBillingTotalSummaryLabels.totalLabel}: {localizedSelectedTotalLabels.totalLabel}</div>
              </div>
              <p>
                {confirmBillingAction === "checkout"
                  ? formatMessage({ id: "billing.theNextPageIsStripeCheckoutWhereThePaymentAmou" })
                  : seatDelta > 0
                    ? formatMessage({ id: "billing.stripeMayBillThisSeatIncreaseImmediatelyAfterY" })
                    : seatDelta < 0
                      ? formatMessage({ id: "billing.stripeWillUpdateTheSubscriptionQuantityAfterYo" })
                      : formatMessage({ id: "billing.stripeWillReactivateThisSubscriptionWithoutCha" })}
              </p>
              {seatUpdatePreview && (
                <p>{formatMessage({ id: "billing.thisStripeEstimateExpiresAfter5MinutesRe" })}</p>
              )}
            </div>
          )}
          confirmLabel={confirmBillingAction === "checkout"
            ? formatMessage({ id: "billing.continueToStripe" })
            : formatMessage({ id: "billing.confirmAndUpdateSeats" })}
          loadingLabel={confirmBillingAction === "checkout"
            ? formatMessage({ id: "billing.opening2" })
            : formatMessage({ id: "billing.updating2" })}
          confirmColor="bg-brutal-pink"
          onConfirm={confirmBillingAction === "checkout" ? handleCheckout : handlePackQuantityUpdate}
          onClose={handleCloseBillingConfirm}
        />
      )}
      {/* Stryker disable all: remaining billing wiring is covered by the broader billing contract suite. */}
    </div>
  );
}
// Stryker restore all
