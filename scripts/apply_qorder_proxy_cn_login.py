#!/usr/bin/env python3
"""Point lininn/qorder-proxy at current qoderclicn login files.

qoderclicn 1.1.x stores OAuth at ~/.qoder-cn/.auth/user.
Upstream still looks for ~/.qoderworkcn/.auth-cn/user, so a logged-in CN CLI
is treated as unauthenticated. This patch is local compatibility, not a new
inference client.
"""

from __future__ import annotations

import sys
from pathlib import Path

OLD_HOME = "'.qoderworkcn'"
NEW_HOME = "'.qoder-cn'"

OLD_AUTH = """    const userFile = path.join(cfg.homeDir, '.auth-cn', 'user');
    return fs.existsSync(userFile) && fs.statSync(userFile).size > 0;"""

NEW_AUTH = """    const home = process.env.USERPROFILE || process.env.HOME || '';
    const candidates = [
      path.join(cfg.homeDir, '.auth', 'user'),
      path.join(cfg.homeDir, '.auth-cn', 'user'),
      path.join(home, '.qoder-cn', '.auth', 'user'),
      path.join(home, '.qoderworkcn', '.auth-cn', 'user'),
    ];
    return candidates.some((userFile) => fs.existsSync(userFile) && fs.statSync(userFile).size > 0);"""

QWEN38 = "  { id: 'qwen3.8-max', name: 'Qwen3.8-Max', cliModel: 'Qwen3.8-Max', reasoning: true },"


def patch_cli(path: Path) -> bool:
    text = path.read_text(encoding="utf-8")
    original = text
    text = text.replace(OLD_HOME, NEW_HOME, 1)
    if OLD_AUTH in text:
        text = text.replace(OLD_AUTH, NEW_AUTH, 1)
    if text == original:
        return False
    path.write_text(text, encoding="utf-8")
    return True


def patch_models(path: Path) -> bool:
    text = path.read_text(encoding="utf-8")
    if "qwen3.8-max" in text:
        return False
    needle = "  { id: 'auto', name: 'Auto', cliModel: 'auto', reasoning: true },"
    if needle not in text:
        raise SystemExit(f"could not insert qwen3.8-max in {path}")
    extra = (
        needle
        + "\n"
        + QWEN38
        + "\n"
        + "  { id: 'Qwen3.8-Max', name: 'Qwen3.8-Max', cliModel: 'Qwen3.8-Max', reasoning: true },"
        + "\n"
        + "  { id: 'qwen3.8-flash', name: 'Qwen3.8-Flash', cliModel: 'Qwen3.8-Flash', reasoning: true },"
    )
    path.write_text(text.replace(needle, extra, 1), encoding="utf-8")
    return True


def main() -> int:
    root = Path(sys.argv[1] if len(sys.argv) > 1 else "bridges/qorder-proxy")
    cli = root / "clean" / "qodercn-cli.js"
    models = root / "clean" / "models.js"
    if not cli.is_file() or not models.is_file():
        print(f"missing proxy sources under {root}", file=sys.stderr)
        return 1
    changed = patch_cli(cli) | patch_models(models)
    print("patched" if changed else "already patched", root)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
