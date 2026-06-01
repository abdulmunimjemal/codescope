#!/usr/bin/env python3
"""Ground-truth oracle for Python, using Jedi (the engine behind many Python
IDEs). For each function/class/method definition in a package, emit the set of
files containing a *call* to it, resolved across the project.

Usage: python3 bench/oracle-python.py <package-dir> > oracle.json
Output: JSON list of {"name": str, "callerFiles": [str, ...]} (repo-relative).
"""
import json
import os
import sys

import jedi

root = os.path.abspath(sys.argv[1])
limit = int(sys.argv[2]) if len(sys.argv) > 2 else 120
SKIP = ("/.git", "/node_modules", "/__pycache__", "/.venv", "/venv", "/build", "/dist")

py_files = []
for dp, _dn, fns in os.walk(root):
    if any(s in dp for s in SKIP):
        continue
    for f in fns:
        if f.endswith(".py"):
            py_files.append(os.path.join(dp, f))

project = jedi.Project(root)
_cache = {}


def script_and_lines(path):
    if path not in _cache:
        with open(path, encoding="utf-8", errors="ignore") as fh:
            code = fh.read()
        _cache[path] = (jedi.Script(code=code, path=path, project=project), code.splitlines())
    return _cache[path]


def rel(p):
    return os.path.relpath(os.path.abspath(p), root)


def is_call(path, line, col, name):
    try:
        _, lines = script_and_lines(path)
    except OSError:
        return False
    if line - 1 >= len(lines):
        return False
    after = lines[line - 1][col + len(name):].lstrip()
    return after.startswith("(")


# Enumerate function/class definitions across the package.
defs = []
for path in py_files:
    try:
        script, _ = script_and_lines(path)
        for n in script.get_names(all_scopes=True, definitions=True, references=False):
            if n.type in ("function", "class"):
                defs.append((n.name, path, n.line, n.column))
    except Exception:
        continue

step = max(1, len(defs) // limit)
defs = defs[::step][:limit]

out = []
for name, path, line, col in defs:
    try:
        script, _ = script_and_lines(path)
        refs = script.get_references(line, col)
    except Exception:
        continue
    caller_files = set()
    for r in refs:
        rp = str(r.module_path) if r.module_path else None
        if not rp:
            continue
        rp_abs = os.path.abspath(rp)
        if not rp_abs.startswith(root):
            continue
        if rp_abs == path and r.line == line:
            continue  # the definition itself
        if is_call(rp_abs, r.line, r.column, r.name):
            caller_files.add(rel(rp_abs))
    if caller_files:
        out.append({"name": name, "callerFiles": sorted(caller_files)})

print(json.dumps(out))
