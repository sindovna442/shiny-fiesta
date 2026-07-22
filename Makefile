# shiny-fiesta — durable preview/dev/build commands.
#
# Freebuff preview wrapper binds `install` / `dev` / `build` to these targets
# via `freebuff-preview set-install "make install"`,
# `freebuff-preview set "make dev" 5000`, and
# `freebuff-preview set-build "make build"`.
#
# Tunables (override on the command line):
PYTHON ?= python3
VENV   ?= .venv
PORT   ?= 5000
HOST   ?= 0.0.0.0

.PHONY: install build dev run clean

install:
	$(PYTHON) -m venv $(VENV)
	$(VENV)/bin/pip install --upgrade pip
	$(VENV)/bin/pip install -r backend/requirements.txt

# Plain HTML/JS/CSS — Flask serves `frontend/` as the static root, no bundler.
build:
	@echo "No build step required — Flask serves frontend/ directly."

# Used by the Freebuff preview wrapper. Freebuff injects $PORT into the
# process environment, so $$PORT is expanded by the shell to the right port.
# `flask run` is used so we bypass app.py's __main__ hardcoded config.
dev:
	FLASK_APP=backend/app.py $(VENV)/bin/flask run --host=$(HOST) --port=$$PORT

# Convenience for local direct launches — reads HOST/PORT/FLASK_DEBUG
# from the environment (see `.env.example`).
run:
	$(VENV)/bin/python backend/app.py

clean:
	rm -rf $(VENV)
	find . -type d -name __pycache__ -exec rm -rf {} +
