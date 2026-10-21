import type { AllMiddlewareArgs, SlackEventMiddlewareArgs } from "@slack/bolt";
import { installationStore } from "@/lib/installation-store";

// Slack sends this once a workspace or org removes the app. Its tokens are
// already revoked, so Bolt doesn't authorize it; just forget the installation.
export const appUninstalledCallback = async ({
  context,
}: AllMiddlewareArgs & SlackEventMiddlewareArgs<"app_uninstalled">) => {
  await installationStore.deleteInstallation?.({
    teamId: context.teamId,
    enterpriseId: context.enterpriseId,
    isEnterpriseInstall: context.isEnterpriseInstall ?? false,
  });
};
