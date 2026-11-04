import { buildApp } from "./app.js";

const PORT = parseInt(process.env.PORT ?? "8081", 10);
const HOST = process.env.HOST ?? "0.0.0.0";

async function main() {
  const app = await buildApp();

  await app.listen({ port: PORT, host: HOST });
  app.log.info(`C3 API v3.0.0 listening on ${HOST}:${PORT}`);
  app.log.info(`Swagger UI: http://${HOST}:${PORT}/docs`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
