import { z } from "zod";

export const appAgentJwtSettingsSchema = z.object({
  scope: z.enum(["app", "installation"]),
  enabled: z.boolean(),
  appEnabled: z.boolean(),
  effectiveEnabled: z.boolean(),
  canEnable: z.boolean(),
  audience: z.string(),
  expiresIn: z.literal(300),
});
export type AppAgentJwtSettings = z.infer<typeof appAgentJwtSettingsSchema>;
export const updateAppAgentJwtSettingsSchema = z.object({ enabled: z.boolean() }).strict();
