import { createRequire } from "node:module";
import { basename } from "node:path";
import { cwd as processCwd } from "node:process";
import { randomUUID } from "node:crypto";

import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

export type TrackedChat = {
  convoId: string;
  cwd: string;
};

export type StoredWebMessage = {
  messageId: number;
  role: "user" | "assistant" | "system";
  text: string;
  replyToMessageId?: number;
  createdAt: number;
  updatedAt: number;
};

export type TeamSummary = {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  lastOpenedAt: number;
  workdirCount: number;
  primaryPath: string | null;
};

export type TeamWorkdir = {
  path: string;
  label: string;
  sortOrder: number;
  isPrimary: boolean;
};

export type TeamRecord = TeamSummary & {
  workdirs: TeamWorkdir[];
};

export class SessionStore {
  private readonly db: DatabaseSyncType;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        convo_id TEXT NOT NULL,
        project_path TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'primary',
        session_id TEXT NOT NULL,
        PRIMARY KEY (convo_id, project_path, role)
      );
      CREATE TABLE IF NOT EXISTS user_cwd (
        convo_id TEXT PRIMARY KEY,
        cwd TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS heartbeat_runs (
        chat_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        last_triggered_at INTEGER NOT NULL,
        PRIMARY KEY (chat_id, file_path)
      );
      CREATE TABLE IF NOT EXISTS pending_skills (
        convo_id TEXT NOT NULL,
        cwd TEXT NOT NULL,
        skill_name TEXT NOT NULL,
        PRIMARY KEY (convo_id, cwd)
      );
      CREATE TABLE IF NOT EXISTS agent_providers (
        convo_id TEXT PRIMARY KEY,
        provider TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS web_messages (
        message_id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL,
        role TEXT NOT NULL,
        text TEXT NOT NULL,
        reply_to_message_id INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS teams (
        team_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_opened_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS team_workdirs (
        team_id TEXT NOT NULL,
        path TEXT NOT NULL,
        label TEXT NOT NULL,
        sort_order INTEGER NOT NULL,
        is_primary INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (team_id, path)
      );
    `);
    this.migrateSessionsTable();
    this.migratePendingSkillsTable();
  }

  saveSessionId(
    convoId: string,
    projectPath: string,
    sessionId: string,
    role = "primary",
  ): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO sessions (convo_id, project_path, role, session_id) VALUES (?, ?, ?, ?)`,
      )
      .run(convoId, projectPath, role, sessionId);
  }

  getSessionId(convoId: string, projectPath: string, role = "primary"): string | null {
    const row = this.db
      .prepare(
        `SELECT session_id FROM sessions WHERE convo_id = ? AND project_path = ? AND role = ?`,
      )
      .get(convoId, projectPath, role) as { session_id?: string } | undefined;
    return row?.session_id ?? null;
  }

  clearSessionId(convoId: string, projectPath?: string, role?: string): void {
    if (projectPath) {
      if (role) {
        this.db
          .prepare(`DELETE FROM sessions WHERE convo_id = ? AND project_path = ? AND role = ?`)
          .run(convoId, projectPath, role);
        return;
      }
      this.db
        .prepare(`DELETE FROM sessions WHERE convo_id = ? AND project_path = ?`)
        .run(convoId, projectPath);
      return;
    }
    this.db.prepare(`DELETE FROM sessions WHERE convo_id = ?`).run(convoId);
  }

  saveCwd(convoId: string, cwd: string): void {
    this.db
      .prepare(`INSERT OR REPLACE INTO user_cwd (convo_id, cwd) VALUES (?, ?)`)
      .run(convoId, cwd);
  }

  touchChat(convoId: string): void {
    const cwd = this.getCwd(convoId);
    this.db
      .prepare(`INSERT OR IGNORE INTO user_cwd (convo_id, cwd) VALUES (?, ?)`)
      .run(convoId, cwd);
  }

  getCwd(convoId: string): string {
    const row = this.db
      .prepare(`SELECT cwd FROM user_cwd WHERE convo_id = ?`)
      .get(convoId) as { cwd?: string } | undefined;
    return row?.cwd ?? processCwd();
  }

  setPendingSkill(convoId: string, cwd: string, skillName: string): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO pending_skills (convo_id, cwd, skill_name) VALUES (?, ?, ?)`,
      )
      .run(convoId, cwd, skillName);
  }

  getPendingSkill(convoId: string, cwd: string): string | null {
    const row = this.db
      .prepare(`SELECT skill_name FROM pending_skills WHERE convo_id = ? AND cwd = ?`)
      .get(convoId, cwd) as { skill_name?: string } | undefined;
    return row?.skill_name ?? null;
  }

  clearPendingSkill(convoId: string, cwd: string): void {
    this.db
      .prepare(`DELETE FROM pending_skills WHERE convo_id = ? AND cwd = ?`)
      .run(convoId, cwd);
  }

  clearAllPendingSkills(convoId: string): void {
    this.db.prepare(`DELETE FROM pending_skills WHERE convo_id = ?`).run(convoId);
  }

  getHeartbeatLastTriggeredAt(chatId: string, filePath: string): number | null {
    const row = this.db
      .prepare(
        `SELECT last_triggered_at FROM heartbeat_runs WHERE chat_id = ? AND file_path = ?`,
      )
      .get(chatId, filePath) as { last_triggered_at?: number } | undefined;
    return row?.last_triggered_at ?? null;
  }

  saveHeartbeatTrigger(chatId: string, filePath: string, triggeredAt: number): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO heartbeat_runs (chat_id, file_path, last_triggered_at)
         VALUES (?, ?, ?)`,
      )
      .run(chatId, filePath, triggeredAt);
  }

  getScopeKey(convoId: string, cwd = this.getCwd(convoId)): string {
    return `${convoId}::${cwd}`;
  }

  appendWebMessage(params: {
    chatId: string;
    role: StoredWebMessage["role"];
    text: string;
    replyToMessageId?: number;
  }): number {
    const now = Date.now();
    const result = this.db
      .prepare(
        `INSERT INTO web_messages (chat_id, role, text, reply_to_message_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        params.chatId,
        params.role,
        params.text,
        params.replyToMessageId ?? null,
        now,
        now,
      );
    this.trimWebMessages(params.chatId);
    return Number(result.lastInsertRowid);
  }

  listWebMessages(chatId: string): StoredWebMessage[] {
    const rows = this.db
      .prepare(
        `SELECT message_id, role, text, reply_to_message_id, created_at, updated_at
         FROM web_messages
         WHERE chat_id = ?
         ORDER BY message_id ASC`,
      )
      .all(chatId) as Array<{
      message_id?: number;
      role?: StoredWebMessage["role"];
      text?: string;
      reply_to_message_id?: number | null;
      created_at?: number;
      updated_at?: number;
    }>;

    return rows
      .filter((row) => row.message_id && row.role && row.text !== undefined)
      .map((row) => ({
        messageId: row.message_id as number,
        role: row.role as StoredWebMessage["role"],
        text: row.text as string,
        replyToMessageId: row.reply_to_message_id ?? undefined,
        createdAt: row.created_at ?? 0,
        updatedAt: row.updated_at ?? 0,
      }));
  }

  updateWebMessage(chatId: string, messageId: number, text: string): void {
    this.db
      .prepare(
        `UPDATE web_messages
         SET text = ?, updated_at = ?
         WHERE chat_id = ? AND message_id = ?`,
      )
      .run(text, Date.now(), chatId, messageId);
  }

  clearWebMessages(chatId: string): void {
    this.db.prepare(`DELETE FROM web_messages WHERE chat_id = ?`).run(chatId);
  }

  createTeam(name: string): TeamSummary {
    const now = Date.now();
    const teamId = randomUUID();
    this.db
      .prepare(
        `INSERT INTO teams (team_id, name, created_at, updated_at, last_opened_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(teamId, name, now, now, now);
    return this.getTeamSummary(teamId) as TeamSummary;
  }

  listTeams(): TeamSummary[] {
    const rows = this.db
      .prepare(
        `SELECT
           t.team_id,
           t.name,
           t.created_at,
           t.updated_at,
           t.last_opened_at,
           COUNT(w.path) AS workdir_count,
           MAX(CASE WHEN w.is_primary = 1 THEN w.path ELSE NULL END) AS primary_path
         FROM teams t
         LEFT JOIN team_workdirs w ON w.team_id = t.team_id
         GROUP BY t.team_id
         ORDER BY t.last_opened_at DESC, t.updated_at DESC`,
      )
      .all() as Array<{
      team_id?: string;
      name?: string;
      created_at?: number;
      updated_at?: number;
      last_opened_at?: number;
      workdir_count?: number;
      primary_path?: string | null;
    }>;

    return rows
      .filter((row) => row.team_id && row.name)
      .map((row) => ({
        id: row.team_id as string,
        name: row.name as string,
        createdAt: row.created_at ?? 0,
        updatedAt: row.updated_at ?? 0,
        lastOpenedAt: row.last_opened_at ?? 0,
        workdirCount: row.workdir_count ?? 0,
        primaryPath: row.primary_path ?? null,
      }));
  }

  getTeamSummary(teamId: string): TeamSummary | null {
    return this.listTeams().find((team) => team.id === teamId) ?? null;
  }

  getTeam(teamId: string): TeamRecord | null {
    const summary = this.getTeamSummary(teamId);
    if (!summary) {
      return null;
    }
    return {
      ...summary,
      workdirs: this.listTeamWorkdirs(teamId),
    };
  }

  touchTeam(teamId: string): void {
    const now = Date.now();
    this.db
      .prepare(`UPDATE teams SET last_opened_at = ?, updated_at = ? WHERE team_id = ?`)
      .run(now, now, teamId);
  }

  renameTeam(teamId: string, name: string): void {
    this.db
      .prepare(`UPDATE teams SET name = ?, updated_at = ? WHERE team_id = ?`)
      .run(name, Date.now(), teamId);
  }

  deleteTeam(teamId: string): void {
    this.db.prepare(`DELETE FROM team_workdirs WHERE team_id = ?`).run(teamId);
    this.db.prepare(`DELETE FROM teams WHERE team_id = ?`).run(teamId);
  }

  listTeamWorkdirs(teamId: string): TeamWorkdir[] {
    const rows = this.db
      .prepare(
        `SELECT path, label, sort_order, is_primary
         FROM team_workdirs
         WHERE team_id = ?
         ORDER BY sort_order ASC, path ASC`,
      )
      .all(teamId) as Array<{
      path?: string;
      label?: string;
      sort_order?: number;
      is_primary?: number;
    }>;

    return rows
      .filter((row) => row.path && row.label)
      .map((row) => ({
        path: row.path as string,
        label: row.label as string,
        sortOrder: row.sort_order ?? 0,
        isPrimary: row.is_primary === 1,
      }));
  }

  addTeamWorkdir(teamId: string, path: string): void {
    const existing = this.listTeamWorkdirs(teamId);
    if (existing.some((entry) => entry.path === path)) {
      return;
    }
    const sortOrder = existing.length === 0
      ? 0
      : Math.max(...existing.map((entry) => entry.sortOrder)) + 1;
    const isPrimary = existing.length === 0 ? 1 : 0;
    this.db
      .prepare(
        `INSERT INTO team_workdirs (team_id, path, label, sort_order, is_primary)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(teamId, path, basename(path) || path, sortOrder, isPrimary);
    this.touchTeam(teamId);
  }

  removeTeamWorkdir(teamId: string, path: string): void {
    const workdirs = this.listTeamWorkdirs(teamId);
    const removed = workdirs.find((entry) => entry.path === path);
    this.db
      .prepare(`DELETE FROM team_workdirs WHERE team_id = ? AND path = ?`)
      .run(teamId, path);

    if (removed?.isPrimary) {
      const remaining = this.listTeamWorkdirs(teamId);
      const nextPrimary = remaining[0];
      if (nextPrimary) {
        this.setPrimaryTeamWorkdir(teamId, nextPrimary.path);
      }
    }
    this.reindexTeamWorkdirs(teamId);
    this.touchTeam(teamId);
  }

  setPrimaryTeamWorkdir(teamId: string, path: string): void {
    this.db
      .prepare(`UPDATE team_workdirs SET is_primary = 0 WHERE team_id = ?`)
      .run(teamId);
    this.db
      .prepare(`UPDATE team_workdirs SET is_primary = 1 WHERE team_id = ? AND path = ?`)
      .run(teamId, path);
    this.touchTeam(teamId);
  }

  moveTeamWorkdir(teamId: string, path: string, direction: "up" | "down"): void {
    const workdirs = this.listTeamWorkdirs(teamId);
    const index = workdirs.findIndex((entry) => entry.path === path);
    if (index < 0) {
      return;
    }
    const swapIndex = direction === "up" ? index - 1 : index + 1;
    if (swapIndex < 0 || swapIndex >= workdirs.length) {
      return;
    }
    const current = workdirs[index];
    const target = workdirs[swapIndex];
    if (!current || !target) {
      return;
    }
    this.db
      .prepare(`UPDATE team_workdirs SET sort_order = ? WHERE team_id = ? AND path = ?`)
      .run(target.sortOrder, teamId, current.path);
    this.db
      .prepare(`UPDATE team_workdirs SET sort_order = ? WHERE team_id = ? AND path = ?`)
      .run(current.sortOrder, teamId, target.path);
    this.touchTeam(teamId);
  }

  getPrimaryTeamWorkdir(teamId: string): string | null {
    const row = this.db
      .prepare(
        `SELECT path FROM team_workdirs WHERE team_id = ? AND is_primary = 1 LIMIT 1`,
      )
      .get(teamId) as { path?: string } | undefined;
    return row?.path ?? null;
  }

  listTrackedChats(): TrackedChat[] {
    const rows = this.db
      .prepare(`
        SELECT convo_id, cwd
        FROM user_cwd
        ORDER BY convo_id
      `)
      .all() as Array<{ convo_id?: string; cwd?: string }>;

    return rows
      .filter((row) => row.convo_id && row.cwd)
      .map((row) => ({
        convoId: row.convo_id as string,
        cwd: row.cwd as string,
      }));
  }

  close(): void {
    this.db.close();
  }

  private migratePendingSkillsTable(): void {
    const columns = this.db.prepare(`PRAGMA table_info(pending_skills)`).all() as Array<{
      name?: string;
    }>;
    if (columns.some((column) => column.name === "cwd")) {
      return;
    }

    this.db.exec(`
      ALTER TABLE pending_skills RENAME TO pending_skills_legacy;
      CREATE TABLE pending_skills (
        convo_id TEXT NOT NULL,
        cwd TEXT NOT NULL,
        skill_name TEXT NOT NULL,
        PRIMARY KEY (convo_id, cwd)
      );
    `);

    const legacyRows = this.db
      .prepare(`SELECT convo_id, skill_name FROM pending_skills_legacy`)
      .all() as Array<{ convo_id?: string; skill_name?: string }>;
    const insert = this.db.prepare(
      `INSERT OR REPLACE INTO pending_skills (convo_id, cwd, skill_name) VALUES (?, ?, ?)`,
    );
    for (const row of legacyRows) {
      if (!row.convo_id || !row.skill_name) {
        continue;
      }
      insert.run(row.convo_id, this.getCwd(row.convo_id), row.skill_name);
    }

    this.db.exec(`DROP TABLE pending_skills_legacy`);
  }

  private migrateSessionsTable(): void {
    const columns = this.db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{
      name?: string;
    }>;
    if (columns.some((column) => column.name === "role")) {
      return;
    }

    this.db.exec(`
      ALTER TABLE sessions RENAME TO sessions_legacy;
      CREATE TABLE sessions (
        convo_id TEXT NOT NULL,
        project_path TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'primary',
        session_id TEXT NOT NULL,
        PRIMARY KEY (convo_id, project_path, role)
      );
    `);

    const legacyRows = this.db
      .prepare(`SELECT convo_id, project_path, session_id FROM sessions_legacy`)
      .all() as Array<{ convo_id?: string; project_path?: string; session_id?: string }>;
    const insert = this.db.prepare(
      `INSERT OR REPLACE INTO sessions (convo_id, project_path, role, session_id) VALUES (?, ?, ?, ?)`,
    );
    for (const row of legacyRows) {
      if (!row.convo_id || !row.project_path || !row.session_id) {
        continue;
      }
      insert.run(row.convo_id, row.project_path, "primary", row.session_id);
    }

    this.db.exec(`DROP TABLE sessions_legacy`);
  }

  private trimWebMessages(chatId: string, limit = 200): void {
    this.db
      .prepare(
        `DELETE FROM web_messages
         WHERE chat_id = ?
           AND message_id NOT IN (
             SELECT message_id FROM web_messages
             WHERE chat_id = ?
             ORDER BY message_id DESC
             LIMIT ?
           )`,
      )
      .run(chatId, chatId, limit);
  }

  private reindexTeamWorkdirs(teamId: string): void {
    const workdirs = this.listTeamWorkdirs(teamId);
    const update = this.db.prepare(
      `UPDATE team_workdirs SET sort_order = ? WHERE team_id = ? AND path = ?`,
    );
    workdirs.forEach((workdir, index) => {
      update.run(index, teamId, workdir.path);
    });
  }
}
