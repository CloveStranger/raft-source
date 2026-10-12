import { Textarea, Card, Button } from "raft-ui";
import { useCallback } from "react";
import { Trash2 } from "lucide-react";
import { useIntl } from "react-intl";
import FormField from "../ui/FormField";
import SlugInput from "../ui/SlugInput";
import type { JointInviteDraft, JointInviteDraftUpdate } from "./CreateJointChannelDialog";

export function JointInviteDraftCard({
  draft,
  index,
  canRemove,
  submitting,
  onUpdate,
  onRemove,
}: {
  draft: JointInviteDraft;
  index: number;
  canRemove: boolean;
  submitting: boolean;
  onUpdate: (id: string, updates: JointInviteDraftUpdate) => void;
  onRemove: (id: string) => void;
}) {
  const { formatMessage } = useIntl();
  const draftId = draft.id;
  const handleRemove = useCallback(() => onRemove(draftId), [onRemove, draftId]);
  const handleSlugChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => onUpdate(draftId, { targetServerSlug: event.target.value }),
    [onUpdate, draftId],
  );
  const handleInvitedPeopleChange = useCallback(
    (event: React.ChangeEvent<HTMLTextAreaElement>) => onUpdate(draftId, { invitedPeopleText: event.target.value }),
    [onUpdate, draftId],
  );

  return (
    <Card className="space-y-3 bg-layer-inset theme-brutal:bg-brutal-gray/20 p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="text-xs font-bold uppercase text-foreground-muted theme-brutal:text-black/60">
          {formatMessage({ id: "channel.createJoint.serverInviteIndex" }, { n: index + 1 })}
        </div>
        {canRemove && (
          <Button size="sm"
            variant="danger"
            type="button"
            onClick={handleRemove}
            disabled={submitting}
            className="p-1 disabled:opacity-50 disabled:cursor-not-allowed"
            aria-label={formatMessage({ id: "channel.createJoint.removeServerInvite" }, { n: index + 1 })}
          >
            <Trash2 size={14} />
          </Button>
        )}
      </div>
      <FormField label={formatMessage({ id: "channel.edit.serverSlugLabel" })} required>
        <SlugInput
          type="text"
          value={draft.targetServerSlug}
          onChange={handleSlugChange}
          placeholder="partner-workspace"
          required
        />
      </FormField>
      <FormField
        label={formatMessage({ id: "channel.edit.invitedPeopleLabel" })}
        required
        hint={formatMessage({ id: "channel.edit.invitedPeopleHint" })}
      >
        <Textarea
          value={draft.invitedPeopleText}
          onChange={handleInvitedPeopleChange}
          className="w-full"
          placeholder={formatMessage({ id: "channel.edit.invitedPeoplePlaceholder" })}
          rows={2}
          required
        />
      </FormField>
    </Card>
  );
}
