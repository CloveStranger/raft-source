import api from "../api/client";
import { captureFeedbackUnreadUpdate } from "./feedbackUnreadState";
import { desktopFeedbackMetadata } from "./agentIssueTicket";
import { createHandsFeedbackTransport } from "./createHandsFeedbackTransport";

export { desktopFeedbackMetadata };
export { feedbackTransportError } from "./createHandsFeedbackTransport";
export const handsFeedbackTransport = createHandsFeedbackTransport(api, {
  metadata: desktopFeedbackMetadata,
  captureUnread: captureFeedbackUnreadUpdate,
});
