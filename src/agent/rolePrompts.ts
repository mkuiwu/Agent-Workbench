import { promises as fs } from "node:fs";
import { resolve } from "node:path";

const ROLE_PROMPT_FILES: Record<string, string> = {
  manager: "manager.md",
  implementer: "implementer.md",
  reviewer: "reviewer.md",
};

const rolePromptCache = new Map<string, string>();

export async function getRoleSystemPrompt(role?: string): Promise<string | null> {
  if (!role || !(role in ROLE_PROMPT_FILES)) {
    return null;
  }

  const cached = rolePromptCache.get(role);
  if (cached) {
    return cached;
  }

  const fileName = ROLE_PROMPT_FILES[role];
  if (!fileName) {
    return null;
  }
  const filePath = resolve(process.cwd(), "agents", fileName);
  try {
    const text = (await fs.readFile(filePath, "utf8")).trim();
    if (!text) {
      return null;
    }
    rolePromptCache.set(role, text);
    return text;
  } catch {
    return null;
  }
}
