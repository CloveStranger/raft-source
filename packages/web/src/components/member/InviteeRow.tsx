import { Button, Field, Input, Select, SelectContent, SelectIcon, SelectItem, SelectItemIndicator, SelectItemText, SelectList, SelectTrigger, SelectValue } from "raft-ui";
import { Trash2 } from "lucide-react";
import { useCallback } from "react";
import { useIntl } from "react-intl";
import type { InvitableRole, Invitee, InviteePatch } from "./InviteHumanDialog";

interface RoleItem {
  value: string;
  label: string;
}

/**
 * One email row: the address, its own role (when guests can be offered) and a
 * remove control. Split out so each row binds its handlers to its own id.
 */
export function InviteeRow({
  invitee,
  index,
  fieldIdPrefix,
  canOfferGuest,
  canRemove,
  roleItems,
  onUpdate,
  onRemove,
}: {
  invitee: Invitee;
  index: number;
  fieldIdPrefix: string;
  canOfferGuest: boolean;
  canRemove: boolean;
  roleItems: RoleItem[];
  onUpdate: (id: string, patch: InviteePatch) => void;
  onRemove: (id: string) => void;
}) {
  const { formatMessage } = useIntl();
  const { id } = invitee;
  const handleEmailChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => onUpdate(id, { email: event.target.value }),
    [id, onUpdate],
  );
  const handleRoleChange = useCallback(
    (value: string | null) => {
      if (value != null) onUpdate(id, { role: value as InvitableRole });
    },
    [id, onUpdate],
  );
  const handleRemove = useCallback(() => onRemove(id), [id, onRemove]);

  return (
    <div className="flex items-center gap-2">
      {/*
        * Each control gets its OWN `Field className="contents"`.
        *
        * Base UI's Field context hands every Input beneath it the
        * same control id and the same `aria-labelledby`, so a list
        * of rows would collapse into one id and every box would
        * announce the group's label. An inherited `aria-labelledby`
        * also outranks `aria-label`, so labelling them directly
        * does not help while they share a context. `contents` adds
        * no layout. (Found by @Dozy on PR #7010.)
        */}
      <Field className="contents">
        <Input
          id={`${fieldIdPrefix}-email-${id}`}
          type="email"
          aria-label={formatMessage({ id: "member.invite.emailLabel" })}
          value={invitee.email}
          onChange={handleEmailChange}
          className="min-w-0 flex-1"
          placeholder="name@company.com"
        />
      </Field>
      {canOfferGuest && (
        <Select
          // `chrome="field"` opts into rUI's field metric axis, so
          // the trigger takes the same height and typography as the
          // Input beside it. Its default chrome borrows the Button
          // size scale (32px / 14px) because the trigger is built on
          // Button — which is why the row read as two different
          // kinds of control. Hand-setting a height would have
          // matched only the number, not the type scale.
          chrome="field"
          value={invitee.role}
          onValueChange={handleRoleChange}
          items={roleItems}
        >
          <SelectTrigger
            id={`${fieldIdPrefix}-role-${id}`}
            className="w-28 shrink-0"
            aria-label={formatMessage({ id: "member.invite.roleLabel" })}
          >
            <SelectValue />
            <SelectIcon />
          </SelectTrigger>
          <SelectContent>
            <SelectList>
              {roleItems.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  <SelectItemText>{item.label}</SelectItemText>
                  <SelectItemIndicator />
                </SelectItem>
              ))}
            </SelectList>
          </SelectContent>
        </Select>
      )}
      {/* Hidden, not disabled, at one row: removing the last row
          leaves no way back to a usable form. */}
      {canRemove && (
        <Button
          type="button"
          size="icon-xs"
          variant="danger"
          onClick={handleRemove}
          aria-label={formatMessage({ id: "member.invite.removeInvitee" }, { index: index + 1 })}
        >
          <Trash2 size={14} />
        </Button>
      )}
    </div>
  );
}
