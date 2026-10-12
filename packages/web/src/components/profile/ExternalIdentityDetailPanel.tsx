import type { ExternalMessageAuthorProjection } from "@botiverse/raft-shared";
import { ProfilePanelBody } from "raft-ui";
import { X } from "lucide-react";
import { useMemo } from "react";
import { useIntl } from "react-intl";
import AvatarSlot from "../ui/AvatarSlot";
import CloseButton from "../ui/CloseButton";
import PanelHeader, { PROFILE_HEADER_SURFACE_CLASS } from "../ui/PanelHeader";
import SectionEyebrow from "../ui/SectionEyebrow";
import {
  EXTERNAL_ACTOR_KIND_MESSAGE_IDS,
  formatExternalProviderLabel,
} from "../message/externalIdentityPresentation";

const HEADER_CONTAINER_PROPS = { "data-testid": "external-identity-header", className: PROFILE_HEADER_SURFACE_CLASS };

export default function ExternalIdentityDetailPanel({
  profile,
  onBack,
  onClose,
}: {
  profile: ExternalMessageAuthorProjection;
  onBack?: () => void;
  onClose: () => void;
}) {
  const { formatMessage } = useIntl();
  const headerBack = onBack ?? onClose;
  const providerLabel = formatExternalProviderLabel(profile.provider, formatMessage);
  const actorKindLabel = formatMessage({
    id: EXTERNAL_ACTOR_KIND_MESSAGE_IDS[profile.actorKind ?? "unknown"],
  });
  const subtitle = providerLabel
    ? formatMessage(
        { id: "message.externalIdentity.providerAndKind" },
        { provider: providerLabel, kind: actorKindLabel },
      )
    : actorKindLabel;
  const mobileBackProps = useMemo(() => ({
    "data-testid": "external-mobile-back",
    title: formatMessage({ id: "common.announcement.back" }),
  }), [formatMessage]);

  return (
    <>
      <PanelHeader
        title={profile.displayName}
        subtitle={subtitle}
        iconSlot={
          <AvatarSlot
            context="panel-header"
            type="app"
            appAvatarUrl={profile.avatarUrl}
            appInitials={profile.displayName}
          />
        }
        iconAlwaysVisible
        iconKind="avatar"
        onMobileBack={headerBack}
        backButtonVisibility={onBack ? "always" : "responsive"}
        mobileBackProps={mobileBackProps}
        containerProps={HEADER_CONTAINER_PROPS}
        actions={
          <CloseButton
            onClick={onClose}
            className={`size-7 items-center justify-center ${onBack ? "flex" : "hidden md:flex"}`}
            title={formatMessage({ id: "common.close" })}
          >
            <X size={14} />
          </CloseButton>
        }
      />

      <ProfilePanelBody className="flex-1 overflow-y-auto bg-layer-panel font-sans theme-brutal:bg-white">
        {profile.workspaceName ? (
          <div
            data-testid="external-identity-source"
            className="border-b border-line-muted px-5 py-3 theme-brutal:border-black/10"
          >
            <SectionEyebrow as="div" className="mb-1">
              {formatMessage({ id: "member.detail.from" })}
            </SectionEyebrow>
            <div className="text-sm font-bold text-foreground-strong theme-brutal:text-black">
              {profile.workspaceName}
            </div>
          </div>
        ) : null}

        <div className="flex items-start gap-4 px-5 py-5">
          <AvatarSlot
            context="profile-tile"
            type="app"
            appAvatarUrl={profile.avatarUrl}
            appInitials={profile.displayName}
          />
          <div className="min-w-0 flex-1 pt-0.5">
            <div className="truncate text-lg font-bold text-foreground-strong theme-brutal:text-black">
              {profile.displayName}
            </div>
            <div className="truncate font-mono text-xs text-foreground-muted theme-brutal:text-black/60">
              {subtitle}
            </div>
            <div className="mt-2 text-sm text-foreground-muted theme-brutal:text-black/60">
              {formatMessage({ id: "message.externalIdentity.externalProjection" })}
            </div>
          </div>
        </div>
      </ProfilePanelBody>
    </>
  );
}
