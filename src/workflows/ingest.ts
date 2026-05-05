import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";

export type IngestParams = { text: string; doc_url: string };

type ChunkRecord = { id: number };
type EmbeddingResponse = { data: number[][] };

export class IngestWorkflow extends WorkflowEntrypoint<Env, IngestParams> {
	async run(event: WorkflowEvent<IngestParams>, step: WorkflowStep): Promise<void> {
		const { text, doc_url } = event.payload;
		const gateway = { id: this.env.AI_GATEWAY_ID };

		// split into chunks once - durable so retries don't re-split
		const chunks = await step.do("split text", async () => {
			const splitter = new RecursiveCharacterTextSplitter();
			const documents = await splitter.createDocuments([text]);
			return documents.map((document) => document.pageContent);
		});

		for (let i = 0; i < chunks.length; i++) {
			const chunk = chunks[i];

			// insert a chunk into D1, get the auto-assigned ID back
			const record = await step.do(`insert chunk ${i}`, async (): Promise<ChunkRecord> => {
				const row = await this.env.DB
					.prepare("INSERT INTO chunks (text, doc_url, chunk_index) VALUES (?, ?, ?) RETURNING id")
					.bind(chunk, doc_url, i)
					.first<ChunkRecord>();
				if (!row) {
					throw new Error(`Failed to insert chunk ${i}`);
				}
				return row;
			});

			// embed via Workers AI through the Gateway
			const embedding = await step.do(`embed chunk ${i}`, async (): Promise<number[]> => {
				const result = (await this.env.AI.run(
					this.env.EMBEDDING_MODEL,
					{ text: chunk },
					{ gateway }
				)) as EmbeddingResponse;
				const values = result.data[0];
				if (!values) {
					throw new Error(`Embedding failed for chunk ${i}`);
				}
				return values;
			});

			// upsert vector to Vectorize, keyed by the D1 row ID
			await step.do(`upsert vector ${i}`, async () => {
				await this.env.VECTOR_INDEX.upsert([
					{ id: record.id.toString(), values: embedding },
				]);
			});
		}
	}
}
