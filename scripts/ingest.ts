import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { globSync } from "glob";

// config — env vars override defaults so the script can target a deployed worker without code changes
const docsRoot = process.argv[2];
const productArea = process.argv[3] ?? "vectorize";
const ingestUrl = process.env.INGEST_URL ?? "http://localhost:8787/ingest";
const delayMs = Number(process.env.DELAY_MS ?? 250);

if (!docsRoot) {
    console.error("Usage: npm run ingest -- <path-to-cloudflare-docs> [product-area]");
    console.error("Example: npm run ingest -- ../cloudflare-docs vectorize");
    process.exit(1);
}

// find all markdown under the chosen product area
const docsPath = resolvePath(docsRoot, "src/content/docs", productArea);
const files = globSync(`${docsPath}/**/*.{md,mdx}`);

if (files.length === 0) {
    console.error(`No markdown files found under ${docsPath}`);
    console.error(`Check that the path exists and the product area is correct.`);
    process.exit(1);
}

console.log(`Found ${files.length} files in ${productArea}`);
console.log(`Ingesting to ${ingestUrl} with ${delayMs}ms delay between requests\n`);

// sequential with delay to stay under workers ai rate limits — parallel hits 429s fast on free tier
let successCount = 0;
let failureCount = 0;

for (let i = 0; i < files.length; i++) {
    const filePath = files[i];
    const text = readFileSync(filePath, "utf-8");

    // derive canonical published url from source path so citations link to developers.cloudflare.com
    const relativePath = filePath.split("/src/content/docs/")[1].replace(/\.(md|mdx)$/, "");
    const docUrl = `https://developers.cloudflare.com/${relativePath}/`;

    // post each file to /ingest and track outcome for the final summary
    const progress = `[${i + 1}/${files.length}]`;
    try {
        const response = await fetch(ingestUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text, doc_url: docUrl }),
        });

        if (response.ok) {
            successCount++;
            console.log(`${progress} OK   ${docUrl}`);
        } else {
            failureCount++;
            console.error(`${progress} FAIL ${response.status} ${docUrl}`);
        }
    } catch (error) {
        failureCount++;
        console.error(`${progress} FAIL ${error instanceof Error ? error.message : error} ${docUrl}`);
    }

    // skip the delay on the last iteration — no request follows it
    if (i < files.length - 1) {
        await new Promise((resolveTimer) => setTimeout(resolveTimer, delayMs));
    }
}

console.log(`\nDone: ${successCount} ingested, ${failureCount} failed`);