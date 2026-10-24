import * as esbuild from "esbuild";
import { polyfillNode } from "esbuild-plugin-polyfill-node";
import { readFile } from "node:fs/promises";


const production = process.argv.includes("--production");


async function main() {
  const ctx = await esbuild.context({
    entryPoints: ["src/extension.ts", "src/server.ts"],
    bundle: true,
    format: "cjs",
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: "node",
    outdir: "dist",
    external: ["vscode"],
    logLevel: "silent",
    plugins: [
      stanLanguageServerPatchPlugin,
      esbuildProblemMatcherPlugin /* add to the end of plugins array */,
    ],
  });

  const webctx = await esbuild.context({
    entryPoints: ["src/web/extension.ts", "src/web/server.ts"],
    bundle: true,
    format: 'cjs',
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: 'browser',
    outdir: 'dist/web',
    external: ['vscode'],
    logLevel: 'warning',
    // Node.js global to browser globalThis
    define: {
      global: 'globalThis',
    },
    plugins: [
      polyfillNode({
        globals: true,
        process: true,
      }),
      stanLanguageServerPatchPlugin,
      esbuildProblemMatcherPlugin /* add to the end of plugins array */
    ]
  });

  await Promise.all([ctx.rebuild(), webctx.rebuild()]);
  await Promise.all([ctx.dispose(), webctx.dispose()]);
}

/**
 * Fixes to the bundled stan-language-server completions, applied at build time so they survive
 * reinstalls. Each search string must match exactly once, so a language server update that
 * changes this code fails the build instead of silently dropping the fix.
 */
const LANGUAGE_SERVER_PATCHES = [
  {
    // stanc only lists _lpdf/_lpmf signatures; also suggest the matching _lupdf/_lupmf names.
    search: "const uniqueFunctions = [...new Set([...functionNames, ...manual_functions])];",
    replace: [
      "const unnormalized = functionNames.filter((n) => /_lp[dm]f$/.test(n)).map((n) => n.replace(/_lp([dm])f$/, \"_lup$1f\"));",
      "  const uniqueFunctions = [...new Set([...functionNames, ...unnormalized, ...manual_functions])];",
    ].join("\n"),
  },
  {
    // TrieSearch dedupes items by label by default, so snippets sharing a label with a keyword
    // (data, model, for, if, ...) were dropped. Key items on kind + label instead.
    search: [
      "var COMPLETION_TRIE = new TrieSearch(\"label\", {",
      "  splitOnRegEx: /[\\s_]/g,",
      "  min: 0",
      "});",
    ].join("\n"),
    replace: [
      "var COMPLETION_TRIE = new TrieSearch(\"label\", {",
      "  splitOnRegEx: /[\\s_]/g,",
      "  min: 0,",
      "  idFieldOrFunction: (item) => `${item.kind}:${item.label}`",
      "});",
    ].join("\n"),
  },
];

/** @type {import('esbuild').Plugin} */
const stanLanguageServerPatchPlugin = {
  name: "stan-language-server-patch",

  setup(build) {
    build.onLoad(
      { filter: /stan-language-server[\\/]dist[\\/]server[\\/]index\.js$/ },
      async args => {
        let contents = (await readFile(args.path, "utf8")).replace(/\r\n/g, "\n");
        for (const { search, replace } of LANGUAGE_SERVER_PATCHES) {
          const count = contents.split(search).length - 1;
          if (count !== 1) {
            throw new Error(
              `stan-language-server patch expected 1 match, found ${count}: ${search.split("\n")[0]}`,
            );
          }
          contents = contents.replace(search, () => replace);
        }
        return { contents, loader: "js" };
      },
    );
  },
};

/**
 * This plugin hooks into the build process to print errors in a format that the problem matcher in
 * Visual Studio Code can understand.
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
  name: "esbuild-problem-matcher",

  setup(build) {
    build.onStart(() => {
      console.log("[watch] build started");
    });
    build.onEnd(result => {
      result.errors.forEach(({ text, location }) => {
        console.error(`✘ [ERROR] ${text}`);
        console.error(
          `    ${location.file}:${location.line}:${location.column}:`,
        );
      });
      console.log("[watch] build finished");
    });
  },
};

main().catch(e => {
  console.error(e);
  process.exit(1);
});
