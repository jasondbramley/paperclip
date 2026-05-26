---
title: Database
summary: Embedded PGlite vs Docker Postgres vs hosted
---

Paperclip uses PostgreSQL via Drizzle ORM. There are three ways to run the database.

## 1. Embedded PostgreSQL (Default)

Zero config. If you don't set `DATABASE_URL`, the server starts an embedded PostgreSQL instance automatically.

```sh
pnpm dev
```

On first start, the server:

1. Creates `~/.paperclip/instances/default/db/` for storage
2. Ensures the `paperclip` database exists
3. Runs migrations automatically
4. Starts serving requests

Data persists across restarts. To reset: `rm -rf ~/.paperclip/instances/default/db`.

The Docker quickstart also uses embedded PostgreSQL by default.

## 2. Local PostgreSQL (Docker)

For a full PostgreSQL server locally:

```sh
docker compose up -d
```

This starts PostgreSQL 17 on `localhost:5432`. Set the connection string:

```sh
cp .env.example .env
# DATABASE_URL=postgres://paperclip:paperclip@localhost:5432/paperclip
```

Push the schema:

```sh
DATABASE_URL=postgres://paperclip:paperclip@localhost:5432/paperclip \
  npx drizzle-kit push
```

## 3. Hosted PostgreSQL (Supabase or Azure)

For production, use a hosted provider like [Supabase](https://supabase.com/) or Azure Database for PostgreSQL Flexible Server.

1. Create a project at [database.new](https://database.new)
2. Copy the connection string from Project Settings > Database
3. Set `DATABASE_URL` in your `.env`

Use the **direct connection** (port 5432) for migrations and the **pooled connection** (port 6543) for the application.

If using connection pooling, disable prepared statements:

```ts
// packages/db/src/client.ts
export function createDb(url: string) {
  const sql = postgres(url, { prepare: false });
  return drizzlePg(sql, { schema });
}
```

## Switching Between Modes

| `DATABASE_URL` | Mode |
|----------------|------|
| Not set | Embedded PostgreSQL |
| `postgres://...localhost...` | Local Docker PostgreSQL |
| `postgres://...supabase.com...` | Hosted Supabase |

The Drizzle schema (`packages/db/src/schema/`) is the same regardless of mode.

## Back up and Restore

Create a logical backup with the configured database connection:

```sh
paperclipai db:backup --config ~/.paperclip/instances/default/config.json
```

Restore into a fresh target database with:

```sh
DATABASE_URL="$PAPERCLIP_TARGET_DATABASE_URL" \
  paperclipai db:restore ./paperclip-YYYYMMDD-HHMMSS.sql.gz --yes
```

`db:restore` reads the target connection string from `DATABASE_URL`, the instance config, or the embedded PostgreSQL default. Do not pass connection strings or passwords as command-line arguments. The command prints the connection source only, never the connection string.

The restore path accepts `.sql` and `.sql.gz` files created by `db:backup`. It restores all non-system schemas, including plugin-owned schemas and migration history, so it is suitable for moving from embedded/local PostgreSQL to hosted PostgreSQL.

## Azure PostgreSQL Cutover Notes

For Azure Database for PostgreSQL Flexible Server cutovers:

1. Create a fresh target database and keep the Paperclip service stopped while restoring.
2. Put the target connection string in a secret store or instance `.env` as `DATABASE_URL`; do not paste the value into shell history, ticket comments, logs, or process arguments.
3. Run `paperclipai db:restore <backup-file> --yes` from a machine with network access to the Azure server.
4. Start Paperclip with `DATABASE_URL` and `DATABASE_MIGRATION_URL` pointing at the Azure database.
5. Run a smoke check against the API and agent heartbeat flow before decommissioning the source database.

If the Azure server enforces TLS, include the provider-supported TLS setting in the secret value, for example `sslmode=require`. The CLI maps that setting into libpq environment variables for the `psql` restore subprocess instead of placing the connection string in argv.
