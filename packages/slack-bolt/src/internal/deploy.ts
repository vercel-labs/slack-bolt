// A deployment gets its environment variables when it's created. So the
// build that creates a branch's app, and saves the app's variables, belongs
// to a deployment that will never have them: a new one has to replace it.
import { messageOf, problem } from "./errors";
import type { Log } from "./log";
import type { Vercel } from "./vercel";

/**
 * Metadata on a deployment started here, naming the deployment it replaces.
 */
export const REDEPLOY_META = "vercelSlackRedeployOf";

/**
 * Whether this package started the deployment. A redeploy copies its
 * source's metadata, the mark included, so the mark only counts when it
 * names the deployment this one was made from.
 */
async function startedHere(vercel: Vercel, id: string): Promise<boolean> {
  try {
    const meta = await vercel.deploymentMeta(id);
    const source = meta[REDEPLOY_META];
    return (
      typeof source === "string" &&
      source !== "" &&
      (!meta.originalDeploymentId || meta.originalDeploymentId === source)
    );
  } catch {
    // Can't tell, so replace the deployment as usual.
    return false;
  }
}

/**
 * Starts a deployment that has the branch's variables and cancels this one,
 * which was built without `names`. Resolves with the new deployment, or
 * `undefined` when this deployment is itself a replacement: it already has
 * everything saved before it, so if it still lacks something another
 * wouldn't help, and each would start the next.
 *
 * @throws When the new deployment can't be started.
 */
export async function replaceDeployment(
  vercel: Vercel,
  deploymentId: string,
  names: string[],
  log: Log,
): Promise<{ id: string; url: string } | undefined> {
  const list = names.join(", ");

  if (await startedHere(vercel, deploymentId)) {
    log.warn(
      `This deployment was built without ${list}, and it was started to pick them up`,
    );
    log.note("Not starting another. Redeploy the branch yourself.");
    return undefined;
  }

  let next: { id: string; url: string };
  try {
    next = await vercel.redeploy(deploymentId, {
      [REDEPLOY_META]: deploymentId,
    });
  } catch (error) {
    throw problem(
      `This deployment was built without ${list}, and a new one couldn't be started: ${messageOf(error)}`,
      "The variables are saved. Redeploy the branch to use them.",
      error,
    );
  }
  log.ok(
    `Started a deployment that has ${list}${next.url ? `: https://${next.url}` : ""}`,
  );

  try {
    await vercel.cancelDeployment(deploymentId);
    log.note("Canceled this deployment, which the new one replaces.");
  } catch (error) {
    log.warn(
      `Couldn't cancel this deployment, which the new one replaces: ${messageOf(error)}`,
    );
  }
  return next;
}
