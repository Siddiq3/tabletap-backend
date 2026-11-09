// Runs the API as a normal Node server (Render, Railway, AWS ECS/Lightsail, a VPS).
// For AWS Lambda later: export `handle(app)` from "hono/aws-lambda" in a lambda.ts file instead.
import { serve } from "@hono/node-server";
import { app } from "./app";

const port = Number(process.env.PORT ?? 4000);
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Tabletap API listening on http://localhost:${info.port}`);
});
