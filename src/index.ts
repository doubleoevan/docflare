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

// types for vectorize query → d1 lookup → llm completion pipeline
type ChunkRow = { id: number; text: string; doc_url: string };
type EmbeddingResponse = { data: number[][] };
type LLMResponse = { response: string };

app.get("/ask", async (context) => {
    const question = context.req.query("q");
    if (!question) {
        return context.text("Missing q", 400);
    }
    const gateway = { id: context.env.AI_GATEWAY_ID };

    // embed the question with the same model used for indexing
    const embedded = (await context.env.AI.run(
        context.env.EMBEDDING_MODEL,
        { text: question },
        { gateway }
    )) as EmbeddingResponse;
    const queryVector = embedded.data[0];
    if (!queryVector) {
        return context.text("Embedding failed", 500);
    }

    // retrieve top-5 nearest chunks from vectorize
    const matches = await context.env.VECTOR_INDEX.query(queryVector, { topK: 5 });
    if (!matches.matches.length) {
        return context.json({ answer: "I couldn't find relevant context.", sources: [] });
    }

    // join back to d1 for the actual chunk text and source urls
    const ids = matches.matches.map((match) => Number(match.id));
    const placeholders = ids.map(() => "?").join(",");
    const { results } = await context.env.DB
        .prepare(`SELECT id, text, doc_url FROM chunks WHERE id IN (${placeholders})`)
        .bind(...ids)
        .all<ChunkRow>();

    // build numbered context block; the llm will cite as [1], [2], etc
    const retrievedContext = results.map((row, index) => `[${index + 1}] ${row.text}`).join("\n\n");
    const sources = results.map((row) => row.doc_url);

    // generate the answer with strict cite-or-refuse instructions
    const completion = (await context.env.AI.run(
        context.env.CHAT_MODEL,
        {
            messages: [
                {
                    role: "system",
                    content: "Answer using only the provided context. Cite sources as [1], [2], etc. If the context does not contain the answer, say so.",
                },
                {
                    role: "user",
                    content: `Context:\n${retrievedContext}\n\nQuestion: ${question}`,
                },
            ],
        },
        { gateway }
    )) as LLMResponse;

    return context.json({ answer: completion.response, sources });
});

export default app;
