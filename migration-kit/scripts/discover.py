# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""discover an agentic setup and emit a structured, secret-redacted inventory.

pure parsing: no network, no code execution, no judgment. the model consumes the inventory
and decides the migration plan. stdio package resolution and remote-mcp reachability are
intentionally NOT checked here -- they first surface at apply time.

zero third-party dependencies: frontmatter is parsed by the bundled frontmatter module and
the typed shapes come from contracts, so this runs on a stock python>=3.10 with no install.

usage:
    python3 discover.py <source_dir> [--out inventory.json]
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import re
import sys
from collections import Counter
from dataclasses import replace
from pathlib import Path

from contracts import SECRET_KEY_RE as _SECRET_KEY
from contracts import SECRET_TOKEN_RE as _SECRET_TOKEN
from contracts import SECRET_VALUE_RE as _SECRET_VALUE
from contracts import (
    BundledFile,
    ClaudeMdData,
    ClaudeMdItem,
    CommandData,
    CommandItem,
    FrontMatter,
    HookData,
    HookIntent,
    HookItem,
    Inventory,
    JsonValue,
    LocalToolData,
    LocalToolItem,
    McpServerData,
    McpServerItem,
    OpenclawData,
    OpenclawItem,
    ServerType,
    SkillData,
    SkillItem,
    SubagentData,
    SubagentItem,
    as_array,
    as_object,
    require_dict,
    to_jsonable,
)
from frontmatter import parse_frontmatter

# events whose hooks can block the action -- candidates for a tool-invocation policy.
_BLOCKING_EVENTS = {"PreToolUse", "UserPromptSubmit", "PreCompact", "Stop", "SubagentStop"}


def _style(text: str, code: str) -> str:
    if sys.stdout.isatty() and "NO_COLOR" not in os.environ:
        return f"\033[{code}m{text}\033[0m"
    return text


def _is_secret_value(value: str) -> bool:
    # a prefix that looks like a credential, OR a credential-shaped token embedded anywhere.
    return bool(_SECRET_VALUE.match(value) or _SECRET_TOKEN.search(value))


def _redact_inline(text: str) -> str:
    """replace credential-shaped tokens inside a config string (e.g. a hook command)."""
    return _SECRET_TOKEN.sub("<redacted>", text)


def _redact_value(value: str, ref: str, sink: list[str]) -> str:
    """redact a single structured-config string if it looks like a credential; record the ref."""
    if _is_secret_value(value):
        sink.append(ref)
        return "<redacted>"
    return value


def _warn_if_secret(text: str, ref: str, warnings: list[str]) -> None:
    """flag (do NOT alter) a credential-shaped token in artifact content -- prose/code bodies
    and bundled files are migrated verbatim, so we surface the risk instead of corrupting them."""
    if _SECRET_TOKEN.search(text):
        warnings.append(f"possible secret left intact in {ref} -- review before sharing the inventory")


def _redact(value: JsonValue, ref: str, sink: list[str]) -> JsonValue:
    """recursively replace secret-looking values; record where each redaction happened."""
    match value:
        case dict():
            out: dict[str, JsonValue] = {}
            for k, v in value.items():
                if isinstance(v, str) and (_SECRET_KEY.search(k) or _is_secret_value(v)):
                    out[k] = "<redacted>"
                    sink.append(f"{ref}#{k}")
                else:
                    out[k] = _redact(v, f"{ref}#{k}", sink)
            return out
        case list():
            return [_redact(v, f"{ref}[{i}]", sink) for i, v in enumerate(value)]
        case str() if _is_secret_value(value):
            sink.append(ref)
            return "<redacted>"
        case _:
            return value


def _meta_str(meta: FrontMatter, key: str) -> str | None:
    value = meta.get(key)
    return value if isinstance(value, str) else None


def _as_opt_str(value: JsonValue) -> str | None:
    return value if isinstance(value, str) else None


def _as_str_list(value: JsonValue) -> list[str]:
    arr = as_array(value)
    return [v for v in arr if isinstance(v, str)] if arr is not None else []


def _is_contained_file(path: Path, root: Path) -> bool:
    """a real file that resolves inside root. excludes symlinks escaping the source tree --
    following one would embed an arbitrary external file (e.g. /etc/shadow) into the inventory."""
    return path.is_file() and path.resolve().is_relative_to(root.resolve())


def _read_bundled(path: Path, rel_to: Path) -> BundledFile:
    rel = path.relative_to(rel_to).as_posix()
    raw = path.read_bytes()
    try:
        return BundledFile(path=rel, content=raw.decode("utf-8"), encoding="utf8")
    except UnicodeDecodeError:
        return BundledFile(path=rel, content=base64.b64encode(raw).decode("ascii"), encoding="base64")


def _toolset_name(root: Path) -> str:
    """skill name for the shared toolset: '<project>-tools', kebab-cased so it is
    valid as an org-unique Archestra skill name."""
    base = re.sub(r"[^a-z0-9]+", "-", root.resolve().name.lower()).strip("-") or "project"
    return f"{base}-tools"


def _classify_hook(event: str, command: str) -> HookIntent:
    """advisory intent hint for the model: a deterministic guard vs passive logging. the guard
    logic often lives in a referenced script we don't read, so this is a HINT -- the model must
    inspect the hook before deciding to translate it to a policy."""
    if event in _BLOCKING_EVENTS or re.search(r"sys\.exit\(\s*2\s*\)|exit 2", command):
        return "guard"
    return "passive"


def _redact_env(name: str, env_raw: JsonValue, sink: list[str]) -> dict[str, str]:
    out: dict[str, str] = {}
    env_obj = as_object(env_raw)
    if env_obj is None:
        return out
    for key, value in env_obj.items():
        if isinstance(value, str) and (_SECRET_KEY.search(key) or _is_secret_value(value)):
            out[key] = "<redacted>"
            sink.append(f"mcp:{name}#env#{key}")
        else:
            out[key] = value if isinstance(value, str) else json.dumps(value)
    return out


def discover(root: Path) -> Inventory:
    inv = Inventory(source_root=str(root))
    seen: set[Path] = set()

    def mark(p: Path) -> None:
        seen.add(p.resolve())

    def read(path: Path) -> str:
        return path.read_text(encoding="utf-8", errors="replace")

    def note_unparsed(doc_unparsed: list[str], rel: str) -> None:
        for line in doc_unparsed:
            inv.unknowns.append(f"{rel} (unparsed frontmatter: {line.strip()})")

    # 1. root CLAUDE.md -> primary agent
    for cm in (root / "CLAUDE.md", root / ".claude" / "CLAUDE.md"):
        if _is_contained_file(cm, root):
            doc = parse_frontmatter(read(cm))
            rel = cm.relative_to(root).as_posix()
            note_unparsed(doc.unparsed_lines, rel)
            _warn_if_secret(doc.body, rel, inv.warnings)
            inv.items.append(ClaudeMdItem(
                id="claude_md", name=root.name or "primary", path=rel,
                summary="root orchestration prompt -> primary agent system prompt",
                data=ClaudeMdData(body=doc.body, frontmatter=doc.frontmatter),
            ))
            mark(cm)
            break

    # 1b. instruction files from other ecosystems -> agent prompt material or
    # skills. AGENTS.md is the cross-vendor convention; Cursor and Copilot
    # rules are markdown instructions too. The mapping step decides whether to
    # fold each into the primary agent's system prompt or keep it as a skill.
    instruction_files = [
        p for p in (
            root / "AGENTS.md",
            root / ".cursorrules",
            root / ".github" / "copilot-instructions.md",
        )
        if _is_contained_file(p, root)
    ] + [
        p for p in sorted((root / ".cursor" / "rules").glob("*"))
        if _is_contained_file(p, root) and p.suffix in (".md", ".mdc")
    ]
    for f in instruction_files:
        doc = parse_frontmatter(read(f))
        rel = f.relative_to(root).as_posix()
        note_unparsed(doc.unparsed_lines, rel)
        _warn_if_secret(doc.body, rel, inv.warnings)
        name = f.stem.lstrip(".") or f.name.lstrip(".")
        inv.items.append(ClaudeMdItem(
            id=f"claude_md:{rel}", name=name, path=rel,
            summary=(
                "agent instructions (non-Claude-Code convention) -> fold into the "
                "primary agent prompt or keep as a skill"
            ),
            data=ClaudeMdData(body=doc.body, frontmatter=doc.frontmatter),
        ))
        mark(f)

    # 2. subagents -> skills (preferred)
    for f in sorted((root / ".claude" / "agents").glob("*.md")):
        if not _is_contained_file(f, root):
            continue
        doc = parse_frontmatter(read(f))
        name = _meta_str(doc.frontmatter, "name") or f.stem
        rel = f.relative_to(root).as_posix()
        note_unparsed(doc.unparsed_lines, rel)
        _warn_if_secret(doc.body, rel, inv.warnings)
        description = _meta_str(doc.frontmatter, "description")
        tools = doc.frontmatter.get("tools")
        inv.items.append(SubagentItem(
            id=f"subagent:{name}", name=name, path=rel, summary=(description or "")[:200],
            data=SubagentData(body=doc.body, description=description, tools=tools),
        ))
        mark(f)

    # 3. skills -> skills (clean)
    for skill_md in sorted((root / ".claude" / "skills").glob("*/SKILL.md")):
        # reject a skill reached through a symlinked dir that escapes the source tree.
        if not _is_contained_file(skill_md, root):
            continue
        skill_dir = skill_md.parent
        content = read(skill_md)
        doc = parse_frontmatter(content)
        name = _meta_str(doc.frontmatter, "name") or skill_dir.name
        rel = skill_md.relative_to(root).as_posix()
        note_unparsed(doc.unparsed_lines, rel)
        files = [
            _read_bundled(p, skill_dir)
            for p in sorted(skill_dir.rglob("*"))
            if p != skill_md and _is_contained_file(p, skill_dir)
        ]
        _warn_if_secret(content, rel, inv.warnings)
        for bf in files:
            if bf.encoding == "utf8":
                _warn_if_secret(bf.content, f"{skill_dir.relative_to(root).as_posix()}/{bf.path}", inv.warnings)
        inv.items.append(SkillItem(
            id=f"skill:{name}", name=name, path=rel,
            summary=(_meta_str(doc.frontmatter, "description") or "")[:200],
            data=SkillData(content=content, frontmatter=doc.frontmatter), files=files,
        ))
        for p in skill_dir.rglob("*"):
            mark(p)

    # 4. slash commands -> skills (best-effort)
    for f in sorted((root / ".claude" / "commands").glob("*.md")):
        if not _is_contained_file(f, root):
            continue
        doc = parse_frontmatter(read(f))
        name = _meta_str(doc.frontmatter, "name") or f.stem
        rel = f.relative_to(root).as_posix()
        note_unparsed(doc.unparsed_lines, rel)
        _warn_if_secret(doc.body, rel, inv.warnings)
        inv.items.append(CommandItem(
            id=f"command:{name}", name=name, path=rel,
            summary=(_meta_str(doc.frontmatter, "description") or "")[:200],
            data=CommandData(body=doc.body, frontmatter=doc.frontmatter),
        ))
        mark(f)

    # 5. local python tools (best-effort). heuristic: *.py at the top of a
    # tools/ dir are runnable tools. discovery stays granular — one item per
    # script — and ALSO emits one shared "<project>-tools" toolset item
    # bundling the whole tools/ tree, so the mapping step chooses the shape
    # (default: the toolset; see entity-mapping.md). Migrate one shape, never
    # both — they bundle the same scripts.
    tools_dir = root / "tools"
    tool_scripts = [
        f for f in sorted(tools_dir.glob("*.py"))
        if _is_contained_file(f, root) and f.name != "__init__.py"
    ]
    if tool_scripts:
        # the tools' own requirements are re-rooted to each generated skill's
        # root, where Archestra auto-installs them on mount. a root-level
        # requirements.txt is deliberately NOT attached — it usually pins the
        # whole project, not the tools.
        reqs = tools_dir / "requirements.txt"
        bundled_reqs: BundledFile | None = None
        if _is_contained_file(reqs, root):
            raw_reqs = _read_bundled(reqs, root)
            # requirements files commonly embed index credentials
            # (--extra-index-url https://user:token@...), so warn like any bundle
            _warn_if_secret(raw_reqs.content, raw_reqs.path, inv.warnings)
            bundled_reqs = replace(raw_reqs, path="requirements.txt")
            mark(reqs)
        elif _is_contained_file(root / "requirements.txt", root):
            inv.warnings.append(
                "tools/ has no requirements.txt; the root requirements.txt was NOT "
                "attached to the generated tool skill(s) — it usually pins the whole "
                "project. If the tools need third-party imports, copy the relevant "
                "pins into tools/requirements.txt and re-run discovery."
            )

        # granular items: one per script, for plans that migrate independent
        # single-file tools separately
        for f in tool_scripts:
            bundled = _read_bundled(f, root)
            entry = bundled.path
            files = [bundled] + ([bundled_reqs] if bundled_reqs is not None else [])
            inv.items.append(LocalToolItem(
                id=f"local_tool:{f.stem}", name=f.stem, path=entry,
                summary=f"local python tool {f.name}; member of the shared toolset item",
                data=LocalToolData(entrypoints=[entry]), files=files,
            ))
            mark(f)

        # the shared toolset item: the whole tools/ tree (data files and
        # submodules included), every top-level script as an entrypoint.
        # containment is checked against tools/ itself (not the repo root) so a
        # symlink can't pull arbitrary repo files (e.g. ../.env) into the
        # inventory.
        bundles: list[BundledFile] = []
        for f in sorted(tools_dir.rglob("*")):
            if not _is_contained_file(f, tools_dir) or f == reqs:
                continue
            rel_parts = f.relative_to(tools_dir).parts
            if any(p.startswith(".") or p == "__pycache__" for p in rel_parts) or f.suffix == ".pyc":
                continue
            tree_file = _read_bundled(f, root)
            if tree_file.encoding == "utf8":
                _warn_if_secret(tree_file.content, tree_file.path, inv.warnings)
            bundles.append(tree_file)
            mark(f)
        if bundled_reqs is not None:
            bundles.append(bundled_reqs)
        name = _toolset_name(root)
        entrypoints = [f.relative_to(root).as_posix() for f in tool_scripts]
        inv.items.append(LocalToolItem(
            id=f"local_toolset:{name}", name=name, path="tools",
            summary=(
                f"shared toolset skill bundling tools/ ({len(entrypoints)} entrypoint "
                "script(s)); alternative to the per-tool items — migrate one shape, not both"
            ),
            data=LocalToolData(entrypoints=entrypoints), files=bundles,
        ))

    # 6. mcp servers + hooks from .mcp.json and settings*.json
    for cfg_path in (root / ".mcp.json", root / ".claude" / "settings.json",
                     root / ".claude" / "settings.local.json"):
        if not cfg_path.is_file():
            continue
        mark(cfg_path)
        rel = cfg_path.relative_to(root).as_posix()
        try:
            parsed_cfg: JsonValue = json.loads(read(cfg_path))
        except json.JSONDecodeError:
            inv.unknowns.append(f"{rel} (invalid json)")
            continue
        cfg = as_object(parsed_cfg)
        if cfg is None:
            inv.unknowns.append(f"{rel} (not a json object)")
            continue
        _discover_mcp_servers(inv, cfg.get("mcpServers"), rel)
        _discover_hooks(inv, cfg.get("hooks"), rel)

    # 7. openclaw config -> report-only (schema unverified)
    for oc in (root / "openclaw.json", root / ".openclaw" / "openclaw.json"):
        if oc.is_file():
            mark(oc)
            rel = oc.relative_to(root).as_posix()
            try:
                parsed_oc: JsonValue = json.loads(read(oc))
            except json.JSONDecodeError:
                inv.unknowns.append(f"{rel} (invalid json)")
                continue
            raw = as_object(parsed_oc)
            if raw is None:
                inv.unknowns.append(f"{rel} (not a json object)")
                continue
            refs: list[str] = []
            config = require_dict(_redact(raw, "openclaw", refs), ctx="openclaw")
            inv.items.append(OpenclawItem(
                id="openclaw", name="openclaw", path=rel,
                summary="openclaw runtime config -> report-only (manual migration)",
                data=OpenclawData(config=config), redacted_refs=refs,
            ))

    # 8. unrecognized files under .claude/ -> surface for the model
    claude_dir = root / ".claude"
    if claude_dir.is_dir():
        for p in sorted(claude_dir.rglob("*")):
            if p.is_file() and p.resolve() not in seen:
                inv.unknowns.append(p.relative_to(root).as_posix())

    # 8b. well-known agentic artifacts from other ecosystems we don't parse —
    # surface them so the report can flag manual follow-up instead of staying
    # silent about a setup we only partially understood
    for known in (".windsurfrules", ".clinerules", "GEMINI.md", ".goosehints"):
        p = root / known
        if _is_contained_file(p, root) and p.resolve() not in seen:
            inv.unknowns.append(f"{known} (recognized agent-config artifact; not auto-migrated)")

    return inv


def _discover_mcp_servers(inv: Inventory, servers: JsonValue, rel: str) -> None:
    servers_obj = as_object(servers)
    if servers_obj is None:
        return
    for name, spec in servers_obj.items():
        spec_obj = as_object(spec)
        if spec_obj is None:
            inv.unknowns.append(f"{rel} (mcpServers.{name} is not an object)")
            continue
        refs: list[str] = []
        url = _as_opt_str(spec_obj.get("url"))
        server_type: ServerType = "remote" if url else "local"
        command = _as_opt_str(spec_obj.get("command"))
        # command/args/url are structured config -> redact embedded secrets (env handled below).
        if command is not None:
            command = _redact_value(command, f"mcp:{name}#command", refs)
        if url is not None:
            url = _redact_value(url, f"mcp:{name}#url", refs)
        args = [_redact_value(a, f"mcp:{name}#args[{i}]", refs)
                for i, a in enumerate(_as_str_list(spec_obj.get("args")))]
        inv.items.append(McpServerItem(
            id=f"mcp:{name}", name=name, path=rel,
            summary=f"{server_type} mcp server -> catalog item (+ optional install)",
            data=McpServerData(
                transport=server_type, command=command, args=args,
                env=_redact_env(name, spec_obj.get("env"), refs), url=url,
            ),
            redacted_refs=refs,
        ))


def _discover_hooks(inv: Inventory, hooks: JsonValue, rel: str) -> None:
    hooks_obj = as_object(hooks)
    if hooks_obj is None:
        return
    for event, entries in hooks_obj.items():
        entries_arr = as_array(entries)
        if entries_arr is None:
            continue
        for i, entry in enumerate(entries_arr):
            entry_obj = as_object(entry)
            if entry_obj is None:
                continue
            matcher = _as_opt_str(entry_obj.get("matcher"))
            handlers_arr = as_array(entry_obj.get("hooks"))
            if handlers_arr is None:
                continue
            for j, h in enumerate(handlers_arr):
                h_obj = as_object(h)
                if h_obj is None:
                    continue
                raw_command = h_obj.get("command")
                command = _redact_inline(raw_command if isinstance(raw_command, str) else "")
                intent = _classify_hook(event, command)
                inv.items.append(HookItem(
                    id=f"hook:{event}:{i}:{j}", name=f"{event}#{i}.{j}", path=rel,
                    summary=f"{event} hook ({intent})",
                    data=HookData(event=event, matcher=matcher, command=command, intent=intent),
                ))


def _kind_counts(inv: Inventory) -> str:
    counts = Counter(it.kind for it in inv.items)
    return ", ".join(f"{kind}={count}" for kind, count in sorted(counts.items())) or "none"


def _print_summary(inv: Inventory, out: Path) -> None:
    likely = sum(1 for it in inv.items if it.kind in {"claude_md", "skill", "command", "local_tool"})
    review = sum(
        1 for it in inv.items
        if it.kind in {"subagent", "mcp_server"} or (isinstance(it, HookItem) and it.data.intent == "guard")
    )
    manual = sum(
        1 for it in inv.items
        if it.kind == "openclaw" or (isinstance(it, HookItem) and it.data.intent == "passive")
    ) + len(inv.unknowns)
    redacted = sum(len(it.redacted_refs) for it in inv.items)

    print(_style(f"🔎 discovered {len(inv.items)} items; wrote {out}", "36;1"))
    print(f"  inventory: {_kind_counts(inv)}")
    print(f"  {_style('✅ likely migrates', '32;1')}: {likely} item(s) (agent prompt, skills, commands, local tools)")
    print(f"  {_style('⚠️  needs review', '33;1')}: {review} item(s) (subagents, MCP install choices, guard hooks)")
    print(f"  {_style('🛠️  manual/report-only', '34;1')}: {manual} item(s) (passive hooks, openclaw, unknown files)")
    safety = f"{redacted} structured value(s) redacted; {len(inv.warnings)} content warning(s)"
    print(f"  {_style('🔐 safety', '35;1')}: {safety}")
    for unknown in inv.unknowns:
        print(f"  unknown: {unknown}")
    for warning in inv.warnings:
        print(f"  warning: {warning}")
    print(_style("➡️  next: ask the migrate-to-archestra skill to draft a preview plan from this inventory.", "36;1"))
    print("      approve that plan before running apply.py against Archestra.")


def main() -> int:
    ap = argparse.ArgumentParser(description="discover an agentic setup into an inventory")
    ap.add_argument("source_dir", type=Path)
    ap.add_argument("--out", type=Path, default=Path("inventory.json"))
    args = ap.parse_args()

    root = args.source_dir.expanduser().resolve()
    if not root.is_dir():
        print(f"error: not a directory: {root}", file=sys.stderr)
        return 1

    inv = discover(root)
    args.out.write_text(json.dumps(to_jsonable(inv), indent=2), encoding="utf-8")
    _print_summary(inv, args.out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
