"""shared-toolset pipeline: tools/ discovery, contracts round-trip, SKILL.md generation."""

from pathlib import Path

from apply import _skill_content_for
from contracts import BundledFile, LocalToolData, LocalToolItem, parse_item, to_jsonable
from discover import discover


def _make_project(tmp_path: Path, files: dict[str, str]) -> Path:
    root = tmp_path / "my_proj"
    root.mkdir(parents=True)
    for rel, content in files.items():
        target = root / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content)
    return root


def _toolset(root: Path) -> LocalToolItem:
    items = [i for i in discover(root).items if isinstance(i, LocalToolItem)]
    assert len(items) == 1
    return items[0]


def test_toolset_name_derives_from_project_dir(tmp_path: Path) -> None:
    root = _make_project(tmp_path, {"tools/extract.py": "print('x')\n"})
    item = _toolset(root)
    assert item.name == "my-proj-tools"
    assert item.id == "local_tool:my-proj-tools"


def test_tools_requirements_wins_over_root_and_is_rerooted(tmp_path: Path) -> None:
    root = _make_project(
        tmp_path,
        {
            "tools/extract.py": "import mpmath\n",
            "tools/requirements.txt": "mpmath\n",
            "requirements.txt": "httpx\n",
        },
    )
    by_path = {f.path: f for f in _toolset(root).files}
    assert set(by_path) == {"tools/extract.py", "requirements.txt"}
    assert by_path["requirements.txt"].content == "mpmath\n"


def test_root_requirements_is_the_fallback(tmp_path: Path) -> None:
    root = _make_project(
        tmp_path,
        {"tools/extract.py": "print('x')\n", "requirements.txt": "httpx\n"},
    )
    by_path = {f.path: f for f in _toolset(root).files}
    assert by_path["requirements.txt"].content == "httpx\n"


def test_no_requirements_and_no_tools_dir(tmp_path: Path) -> None:
    root = _make_project(tmp_path, {"tools/extract.py": "print('x')\n"})
    assert [f.path for f in _toolset(root).files] == ["tools/extract.py"]

    bare = _make_project(tmp_path / "other", {"README.md": "hi\n"})
    assert [i for i in discover(bare).items if isinstance(i, LocalToolItem)] == []


def test_bundles_whole_tools_tree_but_entrypoints_stay_top_level(tmp_path: Path) -> None:
    root = _make_project(
        tmp_path,
        {
            "tools/extract.py": "print('x')\n",
            "tools/__init__.py": "",
            "tools/data/config.json": "{}\n",
            "tools/lib/helper.py": "X = 1\n",
            "tools/__pycache__/extract.cpython-312.pyc": "junk",
            "tools/.hidden": "junk",
        },
    )
    item = _toolset(root)
    # __init__.py is bundled (packages need it) but is not a runnable entrypoint
    assert item.data.entrypoints == ["tools/extract.py"]
    assert sorted(f.path for f in item.files) == [
        "tools/__init__.py",
        "tools/data/config.json",
        "tools/extract.py",
        "tools/lib/helper.py",
    ]


def test_symlink_escaping_tools_dir_is_not_bundled(tmp_path: Path) -> None:
    root = _make_project(
        tmp_path,
        {"tools/extract.py": "print('x')\n", "secret.env": "TOKEN=abc\n"},
    )
    (root / "tools" / "leak.env").symlink_to(root / "secret.env")
    assert [f.path for f in _toolset(root).files] == ["tools/extract.py"]


def test_empty_bundled_file_round_trips(tmp_path: Path) -> None:
    root = _make_project(
        tmp_path,
        {"tools/extract.py": "print('x')\n", "tools/__init__.py": ""},
    )
    item = _toolset(root)
    assert parse_item(to_jsonable(item), ctx="items[0]") == item


def test_legacy_single_entrypoint_inventory_still_loads() -> None:
    payload = {
        "id": "local_tool:a",
        "kind": "local_tool",
        "name": "a",
        "path": "tools/a.py",
        "summary": "s",
        "files": [],
        "redacted_refs": [],
        "data": {"entrypoint": "tools/a.py"},
    }
    restored = parse_item(payload, ctx="items[0]")
    assert isinstance(restored, LocalToolItem)
    assert restored.data.entrypoints == ["tools/a.py"]


def test_toolset_skill_without_requirements_omits_install_note() -> None:
    item = LocalToolItem(
        id="local_tool:p-tools",
        name="p-tools",
        path="tools",
        summary="s",
        data=LocalToolData(entrypoints=["tools/a.py"]),
        files=[BundledFile(path="tools/a.py", content="print()\n", encoding="utf8")],
    )
    content, _ = _skill_content_for(item, "p-tools")
    assert "automatically when the skill is mounted" not in content
