import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// Defaults are correct for this app: no ISR (every page is dynamic or static),
// no tag cache, no queue. Adding an R2 incremental cache would only matter if
// we introduced revalidated pages.
export default defineCloudflareConfig({});
