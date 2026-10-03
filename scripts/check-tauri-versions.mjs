import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// An optional project directory allows checks against an isolated install/fixture.
const projectRoot = process.argv[2]
  ? resolve(process.argv[2])
  : fileURLToPath(new URL("../", import.meta.url));

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function majorMinor(version) {
  const match = /^(\d+)\.(\d+)\.\d+(?:[-+].*)?$/.exec(version);
  if (!match) throw new Error(`Invalid package version: ${version}`);
  return `${match[1]}.${match[2]}`;
}

try {
  const manifest = readJson(join(projectRoot, "package.json"));
  const lock = readFileSync(join(projectRoot, "src-tauri", "Cargo.lock"), "utf8");
  const rustVersions = new Map();

  // Cargo generates one [[package]] table for each resolved crate version.
  for (const block of lock.split(/^\[\[package\]\]\s*$/m).slice(1)) {
    const name = /^name = "([^"]+)"\r?$/m.exec(block)?.[1];
    const version = /^version = "([^"]+)"\r?$/m.exec(block)?.[1];
    if (name && version) {
      const versions = rustVersions.get(name) ?? new Set();
      versions.add(version);
      rustVersions.set(name, versions);
    }
  }

  const dependencies = { ...manifest.dependencies, ...manifest.devDependencies };
  const pairs = [["@tauri-apps/api", "tauri"]];
  for (const name of Object.keys(dependencies).sort()) {
    if (name.startsWith("@tauri-apps/plugin-")) {
      pairs.push([name, name.replace("@tauri-apps/", "tauri-")]);
    }
  }

  const failures = [];
  for (const [npmName, crateName] of pairs) {
    try {
      const npmVersion = readJson(join(projectRoot, "node_modules", npmName, "package.json")).version;
      const resolvedVersions = [...(rustVersions.get(crateName) ?? [])];
      if (resolvedVersions.length !== 1) {
        throw new Error(`Expected one ${crateName} version in Cargo.lock; found ${resolvedVersions.join(", ") || "none"}`);
      }
      const rustVersion = resolvedVersions[0];
      if (majorMinor(npmVersion) !== majorMinor(rustVersion)) {
        failures.push(`${npmName}@${npmVersion} does not match ${crateName}@${rustVersion} (major/minor must match)`);
      } else {
        console.log(`OK ${npmName}@${npmVersion} / ${crateName}@${rustVersion}`);
      }
    } catch (error) {
      failures.push(`${npmName}: ${error.message}`);
    }
  }

  if (failures.length > 0) {
    console.error(`Tauri JavaScript/Rust version check failed:\n${failures.map((message) => `- ${message}`).join("\n")}`);
    process.exitCode = 1;
  } else {
    console.log(`Tauri JavaScript/Rust versions match (${pairs.length} pairs).`);
  }
} catch (error) {
  console.error(`Cannot check Tauri versions: ${error.message}`);
  process.exitCode = 1;
}
