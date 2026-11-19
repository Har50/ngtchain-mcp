import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VERSION = "1.7.2";

console.log(`Building NGT Chain MCP v${VERSION}...`);

try {
  console.log("Compiling TypeScript...");
  execSync("npm run build", { stdio: "inherit" });

  const buildDir = path.join(__dirname, "dist-mcpb");
  if (fs.existsSync(buildDir)) {
    fs.rmSync(buildDir, { recursive: true, force: true });
  }
  fs.mkdirSync(buildDir);

  console.log("Copying bundle assets...");
  fs.cpSync(path.join(__dirname, "dist"), path.join(buildDir, "dist"), { recursive: true });
  fs.copyFileSync(path.join(__dirname, "manifest.json"), path.join(buildDir, "manifest.json"));

  const iconCandidates = [
    path.join(__dirname, "icon.png"),
    path.join(__dirname, "mcpb", "icon.png"),
    process.env.ICON_PATH,
  ].filter(Boolean);
  const iconSource = iconCandidates.find((candidate) => fs.existsSync(candidate));
  if (!iconSource) {
    console.error("icon.png was not found next to the package, in mcpb/, or ICON_PATH.");
    process.exit(1);
  }
  fs.copyFileSync(iconSource, path.join(buildDir, "icon.png"));
  console.log("Copied icon.png from " + iconSource);

  // Runtime deps only: no typescript / @types. Resolve @ngtchain/client from npm
  // (file:./client is for local monorepo-style builds of this public repo).
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8"));
  const clientPkg = JSON.parse(fs.readFileSync(path.join(__dirname, "client", "package.json"), "utf8"));
  const bundlePkg = {
    name: pkg.name,
    version: pkg.version,
    type: pkg.type,
    main: pkg.main,
    bin: pkg.bin,
    engines: pkg.engines,
    dependencies: {
      ...pkg.dependencies,
      "@ngtchain/client": clientPkg.version,
    },
  };
  delete bundlePkg.dependencies["@types/node"];
  fs.writeFileSync(path.join(buildDir, "package.json"), JSON.stringify(bundlePkg, null, 2) + "\n");

  console.log("Installing production dependencies (omit=dev, omit=peer)...");
  execSync("npm install --omit=dev --omit=peer --ignore-scripts", {
    cwd: buildDir,
    stdio: "inherit",
  });

  // Refuse package-own secrets/tests only (deps may ship their own test/ folders).
  const banned = [];
  for (const name of fs.readdirSync(buildDir)) {
    if (name === "node_modules" || name === "dist") continue;
    if (/^\.env($|\.)/i.test(name) || /^wallet\.json$/i.test(name) || /\.(pem|key)$/i.test(name)) {
      banned.push(name);
    }
    if (name === "test" || name === "tests") banned.push(name);
  }
  if (banned.length) {
    console.error("Refusing to pack secrets or package test files:\n" + banned.join("\n"));
    process.exit(1);
  }
  if (fs.existsSync(path.join(buildDir, "node_modules", "typescript"))) {
    console.error("typescript was installed; refuse packing peer/dev bloat.");
    process.exit(1);
  }

  const outputFileName = `ngtchain-${VERSION}.mcpb`;
  const outputPath = path.join(__dirname, outputFileName);
  if (fs.existsSync(outputPath)) fs.rmSync(outputPath);

  console.log("Packaging into " + outputFileName + "...");
  // Prefer tar's zip writer (handles large node_modules); fall back to zip(1).
  const zipPath = outputPath + ".zip";
  if (fs.existsSync(zipPath)) fs.rmSync(zipPath);
  try {
    execSync(`tar -a -c -f "${zipPath}" -C "${buildDir}" .`, { stdio: "inherit" });
  } catch {
    execSync(`cd "${buildDir}" && zip -r "${zipPath}" .`, { stdio: "inherit" });
  }
  fs.renameSync(zipPath, outputPath);

  console.log("Bundle created at: " + outputPath);
} catch (error) {
  console.error("Build and packaging failed:", error);
  process.exit(1);
}
