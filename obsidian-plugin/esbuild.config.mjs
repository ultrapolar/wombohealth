import esbuild from "esbuild";
import process from "process";
import builtins from "builtin-modules";

const mode = process.argv[2];

// `node esbuild.config.mjs stats` → bundle the pure math module for node tests.
if (mode === "stats") {
  await esbuild.build({
    entryPoints: ["src/stats.ts"],
    bundle: true,
    format: "esm",
    outfile: "test/stats.bundle.mjs",
    logLevel: "info",
  });
  process.exit(0);
}

const prod = mode === "production";

const ctx = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian", "electron", ...builtins],
  format: "cjs",
  target: "es2020",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
  logLevel: "info",
});

if (prod) {
  await ctx.rebuild();
  process.exit(0);
} else {
  await ctx.watch();
}
