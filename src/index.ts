#!/usr/bin/env node
import { createRequire } from "node:module";
import { createInterface } from "node:readline";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SpeedianceAPI } from "./api.js";
import { SpeedianceClient } from "./client.js";
import { SessionStore, loadSettings } from "./config.js";
import { createServer } from "./server.js";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

function ask(question: string, hidden = false): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  if (hidden) {
    // Echo nothing while the password is typed.
    (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string) => {
      if (s.includes(question)) process.stderr.write(s);
    };
  }
  return new Promise((resolve) =>
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stderr.write("\n");
      resolve(answer.trim());
    }),
  );
}

async function main() {
  const command = process.argv[2] ?? "serve";
  const settings = loadSettings();
  const store = new SessionStore(settings.homeDir);

  if (command === "login") {
    const email = settings.email ?? (await ask("Speediance email: "));
    const password = settings.password ?? (await ask("Speediance password: ", true));
    const client = new SpeedianceClient({ ...settings, email, password }, store);
    const session = await client.login(email, password);
    console.error(`Signed in as ${session.email} (user ${session.userId}, ${session.unit}, ${session.region}).`);
    console.error(`Session saved to ${store.path}.`);
    return;
  }
  if (command === "logout") {
    store.clear();
    console.error("Removed the saved Speediance session.");
    return;
  }
  if (command === "version" || command === "--version") {
    console.log(version);
    return;
  }
  if (command !== "serve") {
    console.error("Usage: eau-gm-manager-mcp [serve | login | logout | version]");
    process.exit(64);
  }

  const client = new SpeedianceClient(settings, store);
  if (!client.session && !client.canLogin()) {
    console.error(
      "Warning: not signed in. Run `eau-gm-manager-mcp login` or set SPEEDIANCE_EMAIL and SPEEDIANCE_PASSWORD. Tools will return an error until then.",
    );
  }
  const server = createServer(new SpeedianceAPI(client, settings.homeDir), version);
  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
