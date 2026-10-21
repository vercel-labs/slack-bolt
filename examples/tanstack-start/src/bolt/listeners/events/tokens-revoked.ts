import type { AllMiddlewareArgs, SlackEventMiddlewareArgs } from "@slack/bolt";
import { installationStore } from "~/lib/installation-store";

// Slack sends this when tokens are revoked, e.g. a user removes their
// authorization. A revoked bot token means the installation can't be used,
// so forget it; revoked user tokens only remove those users' installations.
export const tokensRevokedCallback = async ({
  event,
  context,
}: AllMiddlewareArgs & SlackEventMiddlewareArgs<"tokens_revoked">) => {
  const query = {
    teamId: context.teamId,
    enterpriseId: context.enterpriseId,
    isEnterpriseInstall: context.isEnterpriseInstall ?? false,
  };

  if (event.tokens.bot?.length) {
    await installationStore.deleteInstallation?.(query);
    return;
  }
  for (const userId of event.tokens.oauth ?? []) {
    await installationStore.deleteInstallation?.({ ...query, userId });
  }
};
