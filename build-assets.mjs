import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { build } from "esbuild";

const root = process.cwd();
const cssSource = path.join(root, "css", "app.css");
const cssBuild = path.join(root, "css", "app.build.css");
const scriptFiles = [
  "sfx.js",
  "theme.js",
  "audio_mixer.js",
  "yt_sync.js",
  "webrtc.js",
  "supabase_p2p.js",
  "app.js"
];

const tailwindCli = path.join(root, "node_modules", "tailwindcss", "lib", "cli.js");
execFileSync(process.execPath, [tailwindCli, "-i", cssSource, "-o", cssBuild, "--minify"], {
  cwd: root,
  stdio: "inherit"
});

const appSource = [
  'import { createClient } from "@supabase/supabase-js";',
  "window.supabase = { createClient };",
  ...scriptFiles.map((file) => fs.readFileSync(path.join(root, "js", file), "utf8"))
].join("\n");

const bundlePath = path.join(root, "js", "app.bundle.js");
await build({
  stdin: { contents: appSource, resolveDir: root, sourcefile: "app.bundle.source.js" },
  outfile: bundlePath,
  bundle: true,
  minify: true,
  format: "iife",
  platform: "browser",
  target: "es2020",
  legalComments: "none"
});

const hashFile = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex").slice(0, 12);
const cssHash = hashFile(cssBuild);
const jsHash = hashFile(bundlePath);
const hashedCss = `app.${cssHash}.css`;
const hashedJs = `app.${jsHash}.js`;

fs.copyFileSync(cssBuild, path.join(root, "css", hashedCss));
fs.renameSync(bundlePath, path.join(root, "js", hashedJs));

const replaceInFile = (file, replacements) => {
  const filePath = path.join(root, file);
  let contents = fs.readFileSync(filePath, "utf8");
  for (const [from, to] of replacements) {
    contents = from instanceof RegExp ? contents.replace(from, to) : contents.replaceAll(from, to);
  }
  fs.writeFileSync(filePath, contents);
};

replaceInFile("index.html", [
  [/\.\/css\/app\.(?:HASH|[a-f0-9]{12})\.css/g, `./css/${hashedCss}`],
  [/\.\/js\/app\.(?:HASH|[a-f0-9]{12})\.js/g, `./js/${hashedJs}`]
]);
replaceInFile("sw.js", [
  [/llamaditas-pwa-(?:HASH|[a-f0-9]{12})/g, `llamaditas-pwa-${jsHash}`],
  [/\.\/css\/app\.(?:HASH|[a-f0-9]{12})\.css/g, `./css/${hashedCss}`],
  [/\.\/js\/app\.(?:HASH|[a-f0-9]{12})\.js/g, `./js/${hashedJs}`]
]);

for (const file of fs.readdirSync(path.join(root, "css"))) {
  if (/^app\.[a-f0-9]{12}\.css$/.test(file) && file !== hashedCss) fs.rmSync(path.join(root, "css", file));
}
for (const file of fs.readdirSync(path.join(root, "js"))) {
  if (/^app\.[a-f0-9]{12}\.js$/.test(file) && file !== hashedJs) fs.rmSync(path.join(root, "js", file));
}

console.log(`Built ${hashedCss} and ${hashedJs}`);