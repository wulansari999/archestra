"""Verify the agent decoded the cipher by running the bundled skill script.

The plaintext is bespoke-cipher output, recoverable only via the seeded `cipher-decoder` skill, so an
exact match against the never-staged ground truth (BENCH_FIXTURES/expected/plaintext.txt) is the real
gate. We additionally require, from BENCH_STATE, that the skill was seeded from the repo and that a
run_command actually invoked the mounted decode.pl on the ciphertext -- a bare `cat`/`echo` of the
path, or the path without the ciphertext argument, does not count.
"""

import json
import os
from pathlib import Path

MOUNT = "/skills/cipher-decoder"
SCRIPT = "decode.pl"


def _load_json(env_var: str) -> dict:
    path = os.environ.get(env_var)
    assert path, f"{env_var} is not set"
    return json.loads(Path(path).read_text(encoding="utf-8"))


def _fixture_text(relpath: str) -> str:
    base = os.environ.get("BENCH_FIXTURES")
    assert base, "BENCH_FIXTURES is not set"
    return Path(base, relpath).read_text(encoding="utf-8")


def _run_command_text(call: dict) -> str:
    inp = call.get("input") or {}
    return " ".join(str(inp.get(field) or "") for field in ("command", "cwd"))


def test_plaintext_matches() -> None:
    expected = _fixture_text("expected/plaintext.txt")
    submitted = _load_json("BENCH_RESULT")["plaintext"]
    assert submitted == expected, f"submitted plaintext {submitted!r} != expected {expected!r}"


def test_decoder_script_ran_on_ciphertext() -> None:
    state = _load_json("BENCH_STATE")
    ciphertext = _fixture_text("inputs/cipher.txt").strip()
    ran = [
        call
        for call in state.get("tool_calls", [])
        if call.get("name") == "archestra__run_command"
        and MOUNT in (text := _run_command_text(call))
        and SCRIPT in text
        and ciphertext in text  # the script was run *on the ciphertext*, not merely inspected
    ]
    assert ran, (
        f"no run_command invoked {MOUNT}/.../{SCRIPT} with the ciphertext as an argument; "
        "the bundled decoder was not executed on the blob"
    )


def test_skill_seeded_from_repo() -> None:
    state = _load_json("BENCH_STATE")
    rest = state["rest"]
    assert len(rest) == 1, f"expected exactly one captured rest path, got {list(rest)}"
    payload = next(iter(rest.values()))
    rows = payload.get("data") if isinstance(payload, dict) else None
    matches = [r for r in (rows or []) if r.get("name") == "cipher-decoder"]
    assert len(matches) == 1, f"expected exactly one cipher-decoder skill row, got {matches}"
    assert matches[0].get("sourceType") == "github", (
        f"cipher-decoder must be seeded from the repo (sourceType=github), "
        f"got {matches[0].get('sourceType')!r}"
    )
