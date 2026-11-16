import "dotenv/config";
import { app, logger } from "./app.js";
import { jwtSecret } from "./services/auth.js";
import { pool } from "./database/pool.js";
import { prisma } from "./repositories/users.js";
import { migrate } from "./database/migrate.js";

jwtSecret();
if (!process.env.DATABASE_URL) throw Error("DATABASE_URL required");

// Automatically apply database schema migrations on startup
try {
  const dbUrl = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
  logger.info("Applying database migrations...");
  await migrate(dbUrl);
  logger.info("Database migrations applied successfully.");
} catch (err: any) {
  logger.error({ err: err?.message || err }, "Migration failed on startup");
}

const port = Number(process.env.PORT || 4000);
const server = app.listen(port, "0.0.0.0", () =>
  logger.info({ port }, `NEXBANK API started on port ${port}`),
);
process.on("SIGTERM", () =>
  server.close(async () => {
    await pool.end();
    await prisma.$disconnect();
    process.exit(0);
  }),
);
