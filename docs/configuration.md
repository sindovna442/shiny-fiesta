# Configuration

Shiny‑fiesta reads a small set of environment variables. All of them are
**optional for local development** — sensible defaults are baked into
`backend/app.py`. Real secrets (only one today: `SECRET_KEY`) should be
set through the Freebuff **Keys / API keys** tab, not by committing a
`.env` file.

> If you want a literal `.env.example` template, copy the table below
> into a repo file called `.env.example` after the workspace sandbox
> stops blocking writes to that exact name. Every value in this doc is a
> **placeholder** — never commit a real key.

## Variables

| Variable      | Default     | Read by                          | Purpose                                                                                |
|---------------|-------------|----------------------------------|----------------------------------------------------------------------------------------|
| `SECRET_KEY`  | `dev-secret-key` | `backend/config.py`        | Production signing key. **Set this in Keys / API keys** for any non‑dev run.           |
| `HOST`        | `0.0.0.0`   | `backend/app.py` (`__main__`)    | Bind address when launched via `python backend/app.py` (or `make run`).                 |
| `PORT`        | `5000`      | `backend/app.py` / Flask CLI     | Listen port. Freebuff's preview wrapper **injects `$PORT` automatically** — leave unset. |
| `FLASK_DEBUG` | `1`         | `backend/app.py`                 | `1` enables debug mode + auto‑reload. `0` for prod‑like runs.                           |

## Where each piece of code reads it

- **`backend/config.py`** — pulls `SECRET_KEY` via `os.environ` at import
  time, with `'dev-secret-key'` as a safe dev fallback.
- **`backend/app.py`** — the patched `if __name__ == '__main__':` block
  reads `HOST`, `PORT`, `FLASK_DEBUG`. Used when you launch the app via
  `python backend/app.py` (or `make run`).
- **`Makefile`** — the `dev` target invokes `flask run` with
  `--host=0.0.0.0` and lets the shell expand `$PORT` (the Freebuff
  wrapper injects this). The `install`, `build`, and `clean` targets do
  not read any env var.

## Recommended Freebuff preview wrapper wiring

```bash
freebuff-preview set-install "make install"
freebuff-preview set  "make dev" 5000
freebuff-preview set-build "make build"
```

These three lines are the durable hand‑off between this Makefile and
the Freebuff UI's **Start preview** button — and they do **not** bake
in any real port or secret.

## Generating a real `SECRET_KEY`

```bash
python -c "import secrets; print(secrets.token_hex(32))"
```

Drop the output into the Freebuff **Keys / API keys** tab under the
name `SECRET_KEY`. The running preview picks it up on the next start.
