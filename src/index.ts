import { Hono } from "hono";
import type { IngestParams } from "./workflows/ingest";

export { IngestWorkflow } from "./workflows/ingest";

/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Bind resources to your worker in `wrangler.jsonc`. After adding bindings, a type definition for the
 * `Env` object can be regenerated with `npm run cf-typegen`.
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */
const app = new Hono<{ Bindings: Env }>();

app.post("/ingest", async (context) => {
    const body = await context.req.json<IngestParams>();
    if (!body.text || !body.doc_url) {
        return context.text("Missing text or doc_url", 400);
    }
    await context.env.INGEST_WORKFLOW.create({params: body});
    return context.text("Queued", 202);
});

export default app;
