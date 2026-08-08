// Creates a local stub for react-devtools-core so `bun build --compile` can
// resolve Ink's dynamic devtools import. Ink only loads it when DEV=true,
// which never happens in production. See package.json postinstall.
import { mkdirSync, writeFileSync } from "node:fs";

const dir = new URL("../node_modules/react-devtools-core/", import.meta.url).pathname;
mkdirSync(dir, { recursive: true });
writeFileSync(
  dir + "package.json",
  JSON.stringify({ name: "react-devtools-core", version: "0.0.0", main: "index.js" }, null, 2),
);
writeFileSync(
  dir + "index.js",
  "// Stub: Ink devtools only used when DEV=true. Never bundled into production behavior.\nexport default { connectToDevTools: () => {} };\n",
);
console.log("react-devtools-core stub created");
