import { buildApp } from "./app.js";
import { readConfig } from "./config.js";

const config = readConfig();
const app = await buildApp(config);
await app.listen({ host: "0.0.0.0", port: config.port, listenTextResolver: () => "Server listening" });
