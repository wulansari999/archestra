"""local-tools pipeline: granular + shared-toolset discovery, contracts round-trip,
SKILL.md generation."""

from pathlib import Path

from apply import _skill_content_for
from contracts import (
    BundledFile,
    Inventory,
    LocalToolData,
    LocalToolItem,
    parse_item,
    to_jsonable,
)
from discover import discover


def _make_project(tmp_path: Path, files: dict[str, str]) -> Path:
    root = tmp_path / "my_proj"
    root.mkdir(parents=True)
    for rel, content in files.items():
        target = root / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content)
    return root


def _tool_items(inv: Inventory) -> list[LocalToolItem]:
    return [i for i in inv.items if isinstance(i, LocalToolItem)]


def _toolset(inv: Inventory) -> LocalToolItem:
    items = [i for i in _tool_items(inv) if i.id.startswith("local_toolset:")]
    assert len(items) == 1
    return items[0]


def test_emits_granular_items_and_one_toolset(tmp_path: Path) -> None:
    inv = discover(
        _make_project(
            tmp_path,
            {"tools/a.py": "print('a')\n", "tools/b.py": "print('b')\n"},
        )
    )
    by_id = {i.id: i for i in _tool_items(inv)}
    assert set(by_id) == {"local_tool:a", "local_tool:b", "local_toolset:my-proj-tools"}
    assert by_id["local_tool:a"].data.entrypoints == ["tools/a.py"]
    assert by_id["local_toolset:my-proj-tools"].data.entrypoints == [
        "tools/a.py",
        "tools/b.py",
    ]


def test_tools_requirements_is_rerooted_into_both_shapes(tmp_path: Path) -> None:
    inv = discover(
        _make_project(
            tmp_path,
            {
                "tools/extract.py": "import mpmath\n",
                "tools/requirements.txt": "mpmath\n",
                "requirements.txt": "httpx\n",
            },
        )
    )
    toolset_paths = {f.path: f for f in _toolset(inv).files}
    assert set(toolset_paths) == {"tools/extract.py", "requirements.txt"}
    assert toolset_paths["requirements.txt"].content == "mpmath\n"
    per_tool = next(i for i in _tool_items(inv) if i.id == "local_tool:extract")
    assert {f.path for f in per_tool.files} == {"tools/extract.py", "requirements.txt"}


def test_root_requirements_is_not_attached_but_warned(tmp_path: Path) -> None:
    inv = discover(
        _make_project(
            tmp_path,
            {"tools/extract.py": "print('x')\n", "requirements.txt": "httpx\n"},
        )
    )
    assert [f.path for f in _toolset(inv).files] == ["tools/extract.py"]
    assert any("root requirements.txt was NOT" in w for w in inv.warnings)


def test_no_requirements_and_no_tools_dir(tmp_path: Path) -> None:
    inv = discover(_make_project(tmp_path, {"tools/extract.py": "print('x')\n"}))
    assert [f.path for f in _toolset(inv).files] == ["tools/extract.py"]
    assert not any("requirements" in w for w in inv.warnings)

    bare = discover(_make_project(tmp_path / "other", {"README.md": "hi\n"}))
    assert _tool_items(bare) == []


def test_toolset_bundles_whole_tree_but_entrypoints_stay_top_level(tmp_path: Path) -> None:
    inv = discover(
        _make_project(
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
    )
    item = _toolset(inv)
    # __init__.py is bundled (packages need it) but is not a runnable entrypoint,
    # and gets no granular item of its own
    assert item.data.entrypoints == ["tools/extract.py"]
    assert sorted(f.path for f in item.files) == [
        "tools/__init__.py",
        "tools/data/config.json",
        "tools/extract.py",
        "tools/lib/helper.py",
    ]
    granular_ids = {i.id for i in _tool_items(inv)} - {item.id}
    assert granular_ids == {"local_tool:extract"}


def test_symlink_escaping_tools_dir_is_not_bundled(tmp_path: Path) -> None:
    root = _make_project(
        tmp_path,
        {"tools/extract.py": "print('x')\n", "secret.env": "TOKEN=abc\n"},
    )
    (root / "tools" / "leak.env").symlink_to(root / "secret.env")
    assert [f.path for f in _toolset(discover(root)).files] == ["tools/extract.py"]


def test_empty_bundled_file_round_trips(tmp_path: Path) -> None:
    inv = discover(
        _make_project(
            tmp_path,
            {"tools/extract.py": "print('x')\n", "tools/__init__.py": ""},
        )
    )
    item = _toolset(inv)
    assert "tools/__init__.py" in [f.path for f in item.files]
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
        id="local_toolset:p-tools",
        name="p-tools",
        path="tools",
        summary="s",
        data=LocalToolData(entrypoints=["tools/a.py"]),
        files=[BundledFile(path="tools/a.py", content="print()\n", encoding="utf8")],
    )
    content, _ = _skill_content_for(item, "p-tools")
    assert "automatically when the skill is mounted" not in content
