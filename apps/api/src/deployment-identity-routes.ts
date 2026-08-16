import {
  API_VERSION_PREFIX,
  LEGACY_API_PREFIX,
} from "@server-foundation/api-contracts";
import { Hono } from "hono";

const createDeploymentIdentityRouter = (tenantUuid: string) => {
  const router = new Hono();
  router.get("/deployment/tenant", (context) => context.json({ tenantUuid }));
  return router;
};

export const mountDeploymentIdentityRoutes = (
  app: Hono<any>,
  tenantUuid: string,
): void => {
  app.route(LEGACY_API_PREFIX, createDeploymentIdentityRouter(tenantUuid));
  app.route(API_VERSION_PREFIX, createDeploymentIdentityRouter(tenantUuid));
};
