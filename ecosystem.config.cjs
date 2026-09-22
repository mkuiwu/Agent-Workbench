module.exports = {
  apps: [
    {
      name: "agent-workbench-dev",
      cwd: __dirname,
      script: "./node_modules/.bin/tsx",
      args: "src/index.ts",
      interpreter: "none",
      watch: ["src", ".env", ".env.dev"],
      ignore_watch: [
        "dist",
        "node_modules",
        ".git",
        "runtime_tasks.db",
        "*.db",
        "*.db-shm",
        "*.db-wal",
        "versions",
      ],
      env: {
        NODE_ENV: "development",
        NODE_NO_WARNINGS: "1",
        ENV_FILE: ".env.dev",
        WEB_PORT: "3001",
      },
      restart_delay: 1000,
      max_restarts: 20,
      autorestart: true,
      watch_delay: 500,
    },
    {
      name: "agent-workbench",
      cwd: __dirname,
      script: "./dist/index.js",
      watch: false,
      env: {
        NODE_ENV: "production",
      },
      restart_delay: 1000,
      max_restarts: 10,
      autorestart: true,
    },
  ],
};
