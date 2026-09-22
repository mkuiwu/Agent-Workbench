export type TaskType = "code" | "team" | "status";

export function classifyTask(text: string): { taskType: TaskType; content: string } {
  const trimmed = text.trim();
  if (trimmed.startsWith("/team ")) {
    return {
      taskType: "team",
      content: trimmed.slice("/team ".length).trim(),
    };
  }
  const explicitPrefixes = ["/code ", "/sh ", "/run ", "/ask ", "/cd "];
  for (const prefix of explicitPrefixes) {
    if (trimmed.startsWith(prefix)) {
      return {
        taskType: "code",
        content: trimmed.slice(prefix.length).trim(),
      };
    }
  }
  if (isStatusQuery(trimmed)) {
    return {
      taskType: "status",
      content: trimmed,
    };
  }
  return {
    taskType: "code",
    content: trimmed,
  };
}

function isStatusQuery(text: string): boolean {
  if (!text || text.length > 24) {
    return false;
  }

  return [
    /^(搞好没|搞好了没|搞好了吗)[?？]?$/,
    /^(搞定没|搞定了吗)[?？]?$/,
    /^(好没|好了吗)[?？]?$/,
    /^(完成没|完成了吗)[?？]?$/,
    /^(做完没|做完了吗)[?？]?$/,
    /^(进度|进度咋样|进度怎么样|进度如何|进度呢)[?？]?$/,
    /^(状态|什么状态|现在什么状态|状态咋样|状态怎么样|状态如何|状态呢)[?？]?$/,
    /^done[?？]?$/i,
    /^status[?？]?$/i,
    /^progress[?？]?$/i,
  ].some((pattern) => pattern.test(text));
}
