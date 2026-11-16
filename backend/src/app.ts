import express from "express";
import { buildRevision } from "./build-revision.js";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import { rateLimit } from "express-rate-limit";
import { ZodError } from "zod";
import pino from "pino";
import { api } from "./routes/api.js";
import { rows } from "./database/pool.js";
import { ApiError } from "./utilities/errors.js";
export const logger = pino({
  redact: ["password", "token", "authorization", "cookie", "DATABASE_URL"],
});
export const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(helmet());
const origins = () =>
  (process.env.FRONTEND_ORIGINS || "http://localhost:5173")
    .split(",")
    .map((s) => s.trim().replace(/\/+$/, ""))
    .filter(Boolean);

const isAllowedOrigin = (url?: string) => {
  if (!url) return false;
  const normalized = url.trim().replace(/\/+$/, "");
  if (origins().includes(normalized)) return true;
  if (/^https:\/\/nexbank-adbms[a-z0-9-]*\.vercel\.app$/.test(normalized)) return true;
  if (normalized === "https://nexbank-adbms.vercel.app") return true;
  return false;
};

app.use(
  cors({
    origin: (origin, cb) => {
      const normalized = (origin || "").trim().replace(/\/+$/, "");
      cb(null, !normalized || isAllowedOrigin(normalized));
    },
    credentials: true,
    allowedHeaders: ["Content-Type", "Authorization", "Idempotency-Key"],
  }),
);
app.use(express.json({ limit: "32kb" }));
app.use(cookieParser());
app.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  let origin = (req.headers.origin || "").trim().replace(/\/+$/, "");
  if (!origin && req.headers.referer) {
    try {
      origin = new URL(req.headers.referer).origin;
    } catch {}
  }
  if (!origin && req.headers["x-forwarded-host"]) {
    origin = `https://${req.headers["x-forwarded-host"]}`;
  }
  if (
    ["POST", "PATCH", "DELETE", "PUT"].includes(req.method) &&
    !isAllowedOrigin(origin)
  ) {
    logger.warn({ origin, headers: req.headers }, "Blocked untrusted origin");
    return next(new ApiError(403, "Untrusted request origin"));
  }
  next();
});
app.use("/api", rateLimit({ windowMs: 60000, limit: 200 }));
app.get("/health/live", (_req, res) => res.json({ status: "ok" }));
app.get("/health/ready", async (_req, res, next) => {
  try {
    await rows("SELECT 1");
    res.json({ status: "ready", revision: buildRevision });
  } catch (err: any) {
    logger.error({ err: err?.message || err }, "Database readiness check failed");
    next(new ApiError(503, "Database unavailable"));
  }
});
app.use("/api", api);
app.use((_req, _res, next) => next(new ApiError(404, "Route not found")));
app.use(
  (
    err: any,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    let status = 500,
      message = "Service unavailable";
    if (err instanceof ZodError) {
      status = 400;
      message = err.issues.map((x) => x.message).join("; ");
    } else if (err instanceof ApiError) {
      status = err.status;
      message = err.message;
    } else if (err.code === "P2002" || err.errno === 1062) {
      status = 409;
      message = "Record already exists";
    } else if (err.sqlState === "45000") {
      message = err.sqlMessage;
      status = message === "FORBIDDEN" ? 403 : 409;
    } else if (err instanceof Error && /amount|decimals/.test(err.message)) {
      status = 400;
      message = err.message;
    }
    if (status === 500)
      logger.error(
        { code: err.code || "INTERNAL", message: err?.message, stack: err?.stack },
        "Request failed",
      );
    res.status(status).json({ error: message });
  },
);
