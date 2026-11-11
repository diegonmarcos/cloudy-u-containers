// cloud-services-mcp start-up smoke check (#1659).
// THE DEFECT: src/code/shared and src/code/registry are symlinks into a sibling service. The
// sibling was renamed (c3-services-api -> cloudy-all-api) and the links were not, so they dangled;
// the ship engine only materialises links whose target exists, the image shipped with a dangling
// /app/shared, and the container died at start with
//   ERR_MODULE_NOT_FOUND: Cannot find module '/app/shared/libs/binds.js' imported from /app/mcp/http.ts
// and stayed down (restart "no").
// This walks the import graph from the real entry point (the file entrypoint.sh runs) and requires
// every relative import to resolve to a file, the way tsx resolves it (.js -> .ts). It also requires
// every symlink under src/code to resolve. No install, no network.
import { readFileSync, existsSync, lstatSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CODE = join(dirname(fileURLToPath(import.meta.url)), "code");
let pass = 0, fail = 0;
const check = (n, c, d = "") => c ? (pass++, console.log(`PASS ${n}`)) : (fail++, console.error(`FAIL ${n}${d ? ` - ${d}` : ""}`));

const ep = readFileSync(join(CODE, "entrypoint.sh"), "utf8").match(/tsx\s+(\S+\.ts)/);
check("S1 entrypoint.sh names a tsx entry file", !!ep);
const entry = join(CODE, ep ? ep[1] : "mcp/http.ts");
check("S2 the entry file exists", existsSync(entry), entry);

const dangling = [];
for (const name of readdirSync(CODE)) {
  const p = join(CODE, name);
  if (lstatSync(p).isSymbolicLink() && !existsSync(p)) dangling.push(name);
}
check("S3 no dangling symlink under src/code (the engine ships a dangling link as is)", dangling.length === 0, dangling.join(", "));

const resolveImport = (from, spec) => {
  const base = resolve(dirname(from), spec);
  const cands = [base, base.replace(/\.js$/, ".ts"), base.replace(/\.js$/, ".tsx"), base.replace(/\.mjs$/, ".mts"),
    `${base}.ts`, join(base, "index.ts")];
  return cands.find(c => existsSync(c) && statSync(c).isFile()) || null;
};
const seen = new Set(), missing = [];
const walk = (file) => {
  if (seen.has(file)) return;
  seen.add(file);
  const src = readFileSync(file, "utf8").replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const re = /(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+)["'](\.{1,2}\/[^"']+)["']/gm;
  for (const m of src.matchAll(re)) {
    if (/\.json$/.test(m[1])) { if (!existsSync(resolve(dirname(file), m[1]))) missing.push(`${file.slice(CODE.length + 1)} -> ${m[1]}`); continue; }
    const r = resolveImport(file, m[1]);
    if (!r) missing.push(`${file.slice(CODE.length + 1)} -> ${m[1]}`);
    else if (/\.(ts|tsx|mts)$/.test(r)) walk(r);
  }
};
if (existsSync(entry)) walk(entry);
check(`S4 every relative import reachable from the entry resolves (${seen.size} files walked)`, missing.length === 0, missing.slice(0, 10).join(" | "));
check("S5 the walk reached the shared and registry trees", [...seen].some(f => f.includes("/shared/libs/binds.ts")) && [...seen].some(f => f.includes("/registry/")));
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
