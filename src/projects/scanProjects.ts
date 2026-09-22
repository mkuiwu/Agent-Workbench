import { readdirSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";

export type ProjectEntry = {
  name: string;
  path: string;
};

const README_NAMES = new Set([
  "README",
  "README.md",
  "readme",
  "readme.md",
  "README.txt",
  "readme.txt",
]);

export function scanProjects(roots: string[]): ProjectEntry[] {
  const seen = new Set<string>();
  const projects: ProjectEntry[] = [];

  for (const root of roots) {
    let entries: string[] = [];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }

    for (const entry of entries.sort()) {
      if (entry.startsWith(".")) {
        continue;
      }

      const fullPath = resolve(root, entry);
      let isDir = false;
      try {
        isDir = statSync(fullPath).isDirectory();
      } catch {
        continue;
      }
      if (!isDir) {
        continue;
      }

      let childEntries: string[] = [];
      try {
        childEntries = readdirSync(fullPath);
      } catch {
        continue;
      }

      const hasGit = childEntries.includes(".git");
      const hasReadme = childEntries.some((name) => README_NAMES.has(name));
      if (!hasGit && !hasReadme) {
        continue;
      }

      if (seen.has(fullPath)) {
        continue;
      }
      seen.add(fullPath);
      projects.push({ name: basename(fullPath), path: fullPath });
    }
  }

  return projects.sort((a, b) => a.name.localeCompare(b.name));
}
