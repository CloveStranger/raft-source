import { useIntl } from "react-intl";
import { useAgentDisplayState } from "../../store/agentStore";
import { formatAgentDisplayStateText } from "../../utils/activity";
import StatusDot from "../ui/StatusDot";

export function CreatedAgentStatusDot({ agentId }: { agentId: string }) {
  const intl = useIntl();
  const displayState = useAgentDisplayState(agentId);
  const activityText = formatAgentDisplayStateText(intl, displayState);
  return <StatusDot activity={displayState.activity} title={activityText} />;
}
