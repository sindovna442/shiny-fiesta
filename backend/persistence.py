"""Pet + sketch JSON persistence for the Demon Cat Tamagotchi backend.

Survives Flask restarts by writing `pets_data.json` and `user_sketches.json`
into `backend/data/` after every mutation, and rehydrating them on startup.

Public API
----------
- `DATA_DIR`, `PETS_FILE`, `SKETCHES_FILE`: filesystem anchors
- `save_state(pets, sketches)`: write both dicts to disk (best-effort per side)
- `load_state(pets, sketches, pet_class)`: rehydrate both dicts from disk
  (uses `pet_class.from_dict(d)` if present, else falls back to
  `pet_class.__new__(pet_class); pet.__dict__.update(d)`).

The persistence module intentionally takes the live `pets_data` and
`user_sketches` dicts as parameters — no globals, no circular imports.
"""
import json
import os

DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data')
os.makedirs(DATA_DIR, exist_ok=True)
PETS_FILE = os.path.join(DATA_DIR, 'pets_data.json')
SKETCHES_FILE = os.path.join(DATA_DIR, 'user_sketches.json')


def save_state(pets: dict, sketches: dict) -> None:
    """Persist pets + sketches to disk after every mutation. Best-effort per file."""
    try:
        serializable = {}
        for pid, pet in pets.items():
            try:
                serializable[pid] = pet.to_dict()
            except Exception:
                # skip pets that don't serialize; never block the write of the rest
                pass
        with open(PETS_FILE, 'w', encoding='utf-8') as f:
            json.dump(serializable, f, ensure_ascii=False)
    except Exception as e:
        print(f'persistence.save_state pets error: {e}', flush=True)

    try:
        with open(SKETCHES_FILE, 'w', encoding='utf-8') as f:
            json.dump(sketches, f, ensure_ascii=False)
    except Exception as e:
        print(f'persistence.save_state sketches error: {e}', flush=True)


def load_state(pets: dict, sketches: dict, pet_class) -> None:
    """Restore pets + sketches from disk on backend startup. Best-effort per pet.

    `pet_class` is passed in (rather than imported) to avoid a circular
    import between backend.app and backend.persistence.
    """
    if os.path.exists(PETS_FILE):
        try:
            with open(PETS_FILE, 'r', encoding='utf-8') as f:
                raw = json.load(f)
            if not isinstance(raw, dict):
                raw = {}
            for pid, p_dict in raw.items():
                try:
                    if hasattr(pet_class, 'from_dict'):
                        pets[pid] = pet_class.from_dict(p_dict)
                    else:
                        cat = pet_class.__new__(pet_class)
                        cat.__dict__.update(p_dict)
                        pets[pid] = cat
                except Exception as ex:
                    print(f'persistence.load_state: skipping pet {pid}: {ex}', flush=True)
        except Exception as e:
            print(f'persistence.load_state pets error: {e}', flush=True)

    if os.path.exists(SKETCHES_FILE):
        try:
            with open(SKETCHES_FILE, 'r', encoding='utf-8') as f:
                loaded = json.load(f)
            if isinstance(loaded, dict):
                sketches.update(loaded)
        except Exception as e:
            print(f'persistence.load_state sketches error: {e}', flush=True)
