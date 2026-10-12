import { useCallback, useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useServerPermissions } from "../../hooks/useServerPermissions";
import { useServerStore } from "../../store/serverStore";
import CreateJointChannelDialog from "./CreateJointChannelDialog";

/** Feature-owned link intent, available even when a sidebar is hidden. */
export default function JointChannelLinkIntent() {
  const location = useLocation();
  const navigate = useNavigate();
  const serverId = useServerStore((state) => state.current?.id);
  const { capabilities } = useServerPermissions();
  const [openedFor, setOpenedFor] = useState<string | null>(null);
  const close = useCallback(() => setOpenedFor(null), []);
  useEffect(() => {
    const query = new URLSearchParams(location.search);
    if (query.get("dialog") !== "create-joint-channel") return;
    query.delete("dialog");
    navigate({ pathname: location.pathname, search: query.toString(), hash: location.hash }, { replace: true });
    if (serverId && capabilities.federateChannels) setOpenedFor(serverId);
  }, [location.search, location.pathname, location.hash, navigate, serverId, capabilities.federateChannels]);
  return openedFor === serverId && capabilities.federateChannels
    ? <CreateJointChannelDialog onClose={close} /> : null;
}
