import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

console.log("Building NGT Chain MCP v1.7.1...");

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
    "C:\\Users\\Harsh\\Desktop\\newnet\\ngtchain-icon\\icon.png",
  ].filter(Boolean);

  const iconSource = iconCandidates.find((candidate) => fs.existsSync(candidate));
  if (!iconSource) {
    console.error("icon.png was not found next to the package, in mcpb/, ICON_PATH, or the Desktop ngtchain-icon folder.");
    process.exit(1);
  }
  fs.copyFileSync(iconSource, path.join(buildDir, "icon.png"));
  console.log("Copied icon.png from " + iconSource);

  const outputFileName = "ngtchain-1.7.1.mcpb";
  const outputPath = path.join(__dirname, outputFileName);
  if (fs.existsSync(outputPath)) fs.rmSync(outputPath);

  console.log("Packaging into " + outputFileName + "...");
  if (process.platform === "win32") {
    execSync(
      'powershell Compress-Archive -Path "' + buildDir + '\\*" -DestinationPath "' + outputPath + '" -Force',
      { stdio: "inherit" }
    );
  } else {
    execSync('cd "' + buildDir + '" && zip -r "' + outputPath + '" .', { stdio: "inherit" });
  }

  console.log("Bundle created at: " + outputPath);
} catch (error) {
  console.error("Build and packaging failed:", error);
  process.exit(1);
}
